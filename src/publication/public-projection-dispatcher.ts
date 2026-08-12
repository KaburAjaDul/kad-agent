import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import {
  claimPublicProjectionOutbox,
  finalizePublicProjectionOutbox,
  getPublicProjectionOutbox,
  listDuePublicProjectionOutbox,
  markPublicProjectionDeadLetter,
  markPublicProjectionNeedsReconciliation,
  markPublicProjectionRetryable,
  renewPublicProjectionOutboxLease,
  resolvePublicProjectionOutbox,
  type PublicProjectionOutbox
} from "./public-projection-outbox-repo.js";
import { canonicalJson, canonicalProjectionBytes } from "./signing.js";
import { PublicProjectionHttpClient, type ProjectionFetch } from "./public-projection-http-client.js";
import type { AgendaProjection, ProjectionSignature, PublicAgendaEntry } from "./types.js";

const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RECONCILIATION_DELAY_MS = 5_000;
const PROJECTION_TYPE = "language_club_agenda_entry.v1";

export type PublicProjectionDispatcherOptions = RuntimeLeaseContext & {
  db: SqliteDatabase;
  ownerId: string;
  endpoint: string;
  reconciliationEndpoint: string;
  keyId: string;
  signingPrivateKey: string;
  fetchImpl?: ProjectionFetch;
  timeoutMs?: number;
  leaseDurationMs?: number;
  leaseHeartbeatIntervalMs?: number;
  now?: () => Date;
  /** Kept injectable for callers that share a scheduler; this dispatcher never retries a POST. */
  sleepImpl?: (milliseconds: number) => Promise<void>;
};

export type ProjectionDispatchOutcome =
  | { kind: "published"; id: string; status: number }
  | { kind: "retryable"; id: string; status?: number; nextAttemptAt: string }
  | { kind: "needs_reconciliation"; id: string; reason: string }
  | { kind: "dead_letter"; id: string; status?: number; reason: string }
  | { kind: "no_work" }
  | { kind: "stale_claim"; id: string };

export type ProjectionReconciliationOutcome =
  | { kind: "succeeded"; id: string; revision: number }
  | { kind: "retryable"; id: string; revision?: number; nextAttemptAt: string; reason: string }
  | { kind: "dead_letter"; id: string; revision?: number; reason: string }
  | { kind: "not_reconcilable"; id: string; state?: string }
  | { kind: "missing"; id: string };

/** Claim and process at most one due outbox item. */
export async function dispatchOnePublicProjection(
  options: PublicProjectionDispatcherOptions
): Promise<ProjectionDispatchOutcome> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const candidate = listDuePublicProjectionOutbox(options.db, nowIso, 1)[0];
  if (!candidate) return { kind: "no_work" };
  const claimed = claimPublicProjectionOutbox(options.db, {
    runtimeLeaseName: options.runtimeLeaseName,
    runtimeOwnerId: options.runtimeOwnerId,
    runtimeFencingToken: options.runtimeFencingToken,
    id: candidate.id,
    ownerId: options.ownerId,
    now: nowIso,
    leaseDurationMs: options.leaseDurationMs
  });
  if (!claimed) return { kind: "no_work" };

  let parsed: ParsedProjection;
  try {
    parsed = parseStoredProjection(claimed);
  } catch (error) {
    const reason = safeReason(error, "Stored projection is invalid.");
    markPublicProjectionDeadLetter(options.db, leaseMutation(options, claimed, nowIso, { error: reason }));
    return { kind: "dead_letter", id: claimed.id, reason };
  }

  const signature = signExactProjection(parsed.projection, parsed.body, options.keyId, options.signingPrivateKey, now().getTime());
  const client = new PublicProjectionHttpClient({
    endpoint: options.endpoint,
    reconciliationEndpoint: options.reconciliationEndpoint,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  });
  const heartbeat = startLeaseHeartbeat(options, claimed);
  let result;
  try {
    result = await client.post(signature, claimed.idempotencyKey);
  } finally {
    heartbeat.stop();
  }
  if (!heartbeat.isValid()) return { kind: "stale_claim", id: claimed.id };
  if (result.kind === "ambiguous") {
    const reason = safeReason(result.error, "Projection publication outcome is ambiguous.");
    markPublicProjectionNeedsReconciliation(options.db, leaseMutation(options, claimed, now().toISOString(), { error: reason }));
    return { kind: "needs_reconciliation", id: claimed.id, reason };
  }

  const status = result.response.status;
  const responseNow = now().toISOString();
  if (status === 202) {
    if (!finalizePublicProjectionOutbox(options.db, {
      ...runtimeContext(options),
      id: claimed.id,
      ownerId: options.ownerId,
      fencingToken: claimed.fencingToken,
      contentHash: claimed.contentHash,
      now: responseNow
    })) return { kind: "stale_claim", id: claimed.id };
    return { kind: "published", id: claimed.id, status };
  }
  if (status === 429 || status >= 500 && status <= 599) {
    const nextAttemptAt = new Date(Date.parse(responseNow) + retryAfterMilliseconds(result.response.headers.get("retry-after"), now)).toISOString();
    const changed = markPublicProjectionRetryable(options.db, leaseMutation(options, claimed, responseNow, { error: `Projection endpoint returned HTTP ${status}.`, nextAttemptAt }));
    if (!changed) return { kind: "stale_claim", id: claimed.id };
    const state = getPublicProjectionOutbox(options.db, claimed.id)?.state;
    if (state === "dead_letter") return { kind: "dead_letter", id: claimed.id, status, reason: "Projection retry budget exhausted." };
    return { kind: "retryable", id: claimed.id, status, nextAttemptAt };
  }
  if (status === 409) {
    const reason = "Projection endpoint reported a revision conflict (HTTP 409).";
    markPublicProjectionNeedsReconciliation(options.db, leaseMutation(options, claimed, responseNow, { error: reason }));
    return { kind: "needs_reconciliation", id: claimed.id, reason };
  }
  const reason = `Projection endpoint rejected publication with HTTP ${status}.`;
  markPublicProjectionDeadLetter(options.db, leaseMutation(options, claimed, responseNow, { error: reason }));
  return { kind: "dead_letter", id: claimed.id, status, reason };
}

/** Reconcile a previously ambiguous item without issuing another POST. */
export async function reconcilePublicProjection(
  options: PublicProjectionDispatcherOptions,
  id: string
): Promise<ProjectionReconciliationOutcome> {
  const item = getPublicProjectionOutbox(options.db, id);
  if (!item) return { kind: "missing", id };
  if (item.state !== "needs_reconciliation") return { kind: "not_reconcilable", id, state: item.state };
  let parsed: ParsedProjection;
  try {
    parsed = parseStoredProjection(item);
  } catch (error) {
    const reason = safeReason(error, "Stored projection is invalid.");
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "dead_letter", error: reason, now: nowIso(options)
    });
    return { kind: "dead_letter", id, reason };
  }
  const client = new PublicProjectionHttpClient({ endpoint: options.endpoint, reconciliationEndpoint: options.reconciliationEndpoint, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  const result = await client.get();
  if (result.kind === "ambiguous") {
    const nextAttemptAt = new Date(Date.parse(nowIso(options)) + DEFAULT_RECONCILIATION_DELAY_MS).toISOString();
    const reason = safeReason(result.error, "Public projection reconciliation failed.");
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "retryable", error: reason, nextAttemptAt, now: nowIso(options)
    });
    return { kind: "retryable", id, nextAttemptAt, reason };
  }
  const status = result.response.status;
  const currentNow = nowIso(options);
  if (status === 429 || status >= 500 && status <= 599) {
    const nextAttemptAt = new Date(Date.parse(currentNow) + retryAfterMilliseconds(result.response.headers.get("retry-after"), options.now)).toISOString();
    const reason = `Projection reconciliation endpoint returned HTTP ${status}.`;
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "retryable", error: reason, nextAttemptAt, now: currentNow
    });
    return { kind: "retryable", id, nextAttemptAt, reason };
  }
  if (status < 200 || status > 299) {
    const reason = `Projection reconciliation endpoint returned HTTP ${status}.`;
    resolvePublicProjectionOutbox(options.db, { ...runtimeContext(options), id, resolution: "dead_letter", error: reason, now: currentNow });
    return { kind: "dead_letter", id, reason };
  }
  let remote: PublicAgendaRead;
  try {
    remote = parseRemoteProjection(await result.response.text());
  } catch (error) {
    const reason = safeReason(error, "Public projection response is invalid.");
    const nextAttemptAt = new Date(Date.parse(currentNow) + DEFAULT_RECONCILIATION_DELAY_MS).toISOString();
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "retryable", error: reason, nextAttemptAt, now: currentNow
    });
    return { kind: "retryable", id, revision: undefined, nextAttemptAt, reason };
  }

  if (remote.revision > parsed.projection.revision) {
    const reason = `Public projection was superseded by revision ${remote.revision}.`;
    resolvePublicProjectionOutbox(options.db, { ...runtimeContext(options), id, resolution: "dead_letter", error: reason, now: currentNow });
    return { kind: "dead_letter", id, revision: remote.revision, reason };
  }
  if (remote.revision < parsed.projection.revision) {
    const reason = `Public projection is still at revision ${remote.revision}.`;
    const nextAttemptAt = new Date(Date.parse(currentNow) + DEFAULT_RECONCILIATION_DELAY_MS).toISOString();
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "retryable", error: reason, nextAttemptAt, now: currentNow
    });
    return { kind: "retryable", id, revision: remote.revision, nextAttemptAt, reason };
  }
  if (remote.observedAt !== parsed.projection.observedAt || canonicalJson(remote.entries) !== canonicalJson(parsed.projection.entries)) {
    const reason = "Public projection revision matches but its public entry set does not.";
    const nextAttemptAt = new Date(Date.parse(currentNow) + DEFAULT_RECONCILIATION_DELAY_MS).toISOString();
    resolvePublicProjectionOutbox(options.db, {
      ...runtimeContext(options), id, resolution: "retryable", error: reason, nextAttemptAt, now: currentNow
    });
    return { kind: "retryable", id, revision: remote.revision, nextAttemptAt, reason };
  }
  if (!resolvePublicProjectionOutbox(options.db, { ...runtimeContext(options), id, resolution: "succeeded", now: currentNow })) {
    return { kind: "not_reconcilable", id, state: "stale_runtime_lease" };
  }
  return { kind: "succeeded", id, revision: remote.revision };
}

type ParsedProjection = { projection: AgendaProjection; body: string };

function parseStoredProjection(item: PublicProjectionOutbox): ParsedProjection {
  const digest = `sha256:${createHash("sha256").update(item.payloadJson, "utf8").digest("hex")}`;
  if (digest !== item.contentHash) throw new Error("Stored projection content hash does not match payload.");
  let value: unknown;
  try { value = JSON.parse(item.payloadJson) as unknown; } catch { throw new Error("Stored projection payload is not valid JSON."); }
  const projection = validateProjection(value);
  if (projection.revision !== item.projectionRevision) throw new Error("Stored projection revision does not match outbox revision.");
  return { projection, body: item.payloadJson };
}

export type PublicAgendaRead = {
  schemaVersion: "v1";
  generatedAt: string;
  observedAt: string;
  revision: number;
  sourceStatus: "fresh" | "stale";
  staleAt: string;
  entries: PublicAgendaEntry[];
};

export type PublicProjectionHeadOptions = {
  endpoint: string;
  reconciliationEndpoint: string;
  fetchImpl?: ProjectionFetch;
  timeoutMs?: number;
};

/** Read and strictly validate the current public Worker checkpoint. */
export async function readPublicProjectionHead(
  options: PublicProjectionHeadOptions
): Promise<PublicAgendaRead> {
  const client = new PublicProjectionHttpClient(options);
  const result = await client.get();
  if (result.kind === "ambiguous") throw result.error;
  if (result.response.status !== 200) {
    throw new Error(`Public projection head returned HTTP ${result.response.status}.`);
  }
  return parseRemoteProjection(await result.response.text());
}

function parseRemoteProjection(body: string): PublicAgendaRead {
  let value: unknown;
  try { value = JSON.parse(body) as unknown; } catch { throw new Error("Public projection response is not valid JSON."); }
  return validatePublicAgendaRead(value);
}

function validatePublicAgendaRead(value: unknown): PublicAgendaRead {
  if (!isRecord(value)) throw new Error("Public agenda response must be an object.");
  const fields = ["schemaVersion", "generatedAt", "observedAt", "revision", "sourceStatus", "staleAt", "entries"];
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Public agenda response field ${key} is not allowed.`);
  if (value.schemaVersion !== "v1") throw new Error("Public agenda response schemaVersion must be v1.");
  if (typeof value.generatedAt !== "string" || !validIso(value.generatedAt)) throw new Error("Public agenda generatedAt is invalid.");
  if (typeof value.observedAt !== "string" || !validIso(value.observedAt)) throw new Error("Public agenda observedAt is invalid.");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new Error("Public agenda revision is invalid.");
  if (value.sourceStatus !== "fresh" && value.sourceStatus !== "stale") throw new Error("Public agenda sourceStatus is invalid.");
  if (typeof value.staleAt !== "string" || !validIso(value.staleAt)) throw new Error("Public agenda staleAt is invalid.");
  if (!Array.isArray(value.entries)) throw new Error("Public agenda entries must be an array.");
  const entries = value.entries.map((entry) => validateEntry(entry));
  const ids = new Set<string>();
  for (const entry of entries) { if (ids.has(entry.id)) throw new Error("Public agenda entry IDs must be unique."); ids.add(entry.id); }
  return {
    schemaVersion: "v1", generatedAt: value.generatedAt, observedAt: value.observedAt,
    revision: Number(value.revision), sourceStatus: value.sourceStatus, staleAt: value.staleAt, entries
  };
}

function validateProjection(value: unknown, remote = false): AgendaProjection {
  if (!isRecord(value)) throw new Error("Projection must be an object.");
  const allowed = remote ? ["schemaVersion", "observedAt", "revision", "entries", "tombstones"] : ["schemaVersion", "observedAt", "revision", "entries", "tombstones"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Projection field ${key} is not allowed.`);
  if (value.schemaVersion !== "v1") throw new Error("Projection schemaVersion must be v1.");
  if (typeof value.observedAt !== "string" || !validIso(value.observedAt)) throw new Error("Projection observedAt is invalid.");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new Error("Projection revision is invalid.");
  if (!Array.isArray(value.entries)) throw new Error("Projection entries must be an array.");
  const entries = value.entries.map((entry) => validateEntry(entry));
  const ids = new Set<string>();
  for (const entry of entries) { if (ids.has(entry.id)) throw new Error("Projection entry IDs must be unique."); ids.add(entry.id); }
  if (!remote && !Object.prototype.hasOwnProperty.call(value, "tombstones")) throw new Error("Stored projection tombstones are required.");
  const tombstones = value.tombstones === undefined ? [] : value.tombstones;
  if (!Array.isArray(tombstones) || tombstones.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("Projection tombstones are invalid.");
  if (new Set(tombstones).size !== tombstones.length) throw new Error("Projection tombstones must be unique.");
  return { schemaVersion: "v1", observedAt: value.observedAt, revision: Number(value.revision), entries, tombstones: [...tombstones] };
}

function validateEntry(value: unknown): PublicAgendaEntry {
  if (!isRecord(value)) throw new Error("Projection entry must be an object.");
  const fields = ["id", "title", "summary", "startAt", "endAt", "timezone", "status", "program", "series", "joinUrl", "source"];
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Projection entry field ${key} is not allowed.`);
  const strings = ["id", "title", "summary", "startAt", "timezone", "status", "program", "joinUrl", "source"];
  for (const key of strings) if (typeof value[key] !== "string" || value[key] === "") throw new Error(`Projection entry ${key} is invalid.`);
  if (value.endAt !== null && typeof value.endAt !== "string") throw new Error("Projection entry endAt is invalid.");
  if (value.series !== null && typeof value.series !== "string") throw new Error("Projection entry series is invalid.");
  if (!validIso(value.startAt as string) || value.endAt !== null && !validIso(value.endAt as string)) throw new Error("Projection entry timestamp is invalid.");
  if (value.status !== "scheduled" && value.status !== "active") throw new Error("Projection entry status is invalid.");
  if (value.timezone !== "Asia/Jakarta" || value.joinUrl !== "https://discord.gg/RUFFbEaeDx" || value.source !== "discord_scheduled_event") throw new Error("Projection entry public fields are invalid.");
  return value as unknown as PublicAgendaEntry;
}

function signExactProjection(projection: AgendaProjection, body: string, keyId: string, privateKeyValue: string, now: number): ProjectionSignature {
  const issuedAt = String(now);
  const expiresAt = String(now + 5 * 60_000);
  const nonce = randomBytes(18).toString("base64url");
  const contentSha256 = createHash("sha256").update(body, "utf8").digest("base64url");
  const key = privateKeyValue.includes("BEGIN") ? createPrivateKey(privateKeyValue) : createPrivateKey({ key: Buffer.from(privateKeyValue, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Projection signing key must be Ed25519.");
  const signature = sign(null, canonicalProjectionBytes(issuedAt, expiresAt, nonce, contentSha256, body), key).toString("base64url");
  void projection;
  return { schemaVersion: "v1", keyId, issuedAt, expiresAt, nonce, contentSha256, signature, body };
}

function runtimeContext(options: PublicProjectionDispatcherOptions): RuntimeLeaseContext {
  return { runtimeLeaseName: options.runtimeLeaseName, runtimeOwnerId: options.runtimeOwnerId, runtimeFencingToken: options.runtimeFencingToken };
}

function leaseMutation(options: PublicProjectionDispatcherOptions, item: PublicProjectionOutbox, now: string, extra: { error: unknown; nextAttemptAt?: string }) {
  return { ...runtimeContext(options), id: item.id, ownerId: options.ownerId, fencingToken: item.fencingToken, now, ...extra };
}

function startLeaseHeartbeat(
  options: PublicProjectionDispatcherOptions,
  item: PublicProjectionOutbox
): { stop: () => void; isValid: () => boolean } {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const intervalMs = Math.min(
    options.leaseHeartbeatIntervalMs ?? Math.max(1, Math.floor(leaseDurationMs / 3)),
    Math.max(1, leaseDurationMs - 1)
  );
  let valid = true;
  const timer = setInterval(() => {
    if (!valid) return;
    try {
      valid = renewPublicProjectionOutboxLease(options.db, {
        ...runtimeContext(options),
        id: item.id,
        ownerId: options.ownerId,
        fencingToken: item.fencingToken,
        leaseDurationMs,
        now: nowIso(options)
      });
    } catch {
      valid = false;
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    isValid: () => valid
  };
}

function retryAfterMilliseconds(value: string | null, now?: () => Date): number {
  if (!value) return DEFAULT_RECONCILIATION_DELAY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  const current = (now ?? (() => new Date()))().getTime();
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - current)) : DEFAULT_RECONCILIATION_DELAY_MS;
}

function validIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso(options: PublicProjectionDispatcherOptions): string { return (options.now ?? (() => new Date()))().toISOString(); }
function safeReason(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message.slice(0, 300) : fallback; }
