import { createHash, randomUUID } from "node:crypto";
import { toSafeOperationalErrorMessage } from "../app/lib/operational-logger.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";

export type PublicProjectionOutboxState =
  | "pending"
  | "leased"
  | "retryable"
  | "needs_reconciliation"
  | "succeeded"
  | "dead_letter";

export type PublicProjectionOutbox = {
  id: string;
  deterministicKey: string;
  idempotencyKey: string;
  projectionType: string;
  triggerAgendaEntryId: string;
  projectionRevision: number;
  contentHash: string;
  state: PublicProjectionOutboxState;
  payloadJson: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  fencingToken: number;
  attempts: number;
  nextAttemptAt?: string;
  runtimeLeaseName?: string;
  runtimeOwnerId?: string;
  runtimeFencingToken?: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  lastError?: string;
};

export type CreatePublicProjectionOutboxInput = {
  id?: string;
  projectionType?: string;
  triggerAgendaEntryId: string;
  projectionRevision: number;
  payloadJson: string;
  contentHash?: string;
  deterministicKey?: string;
  idempotencyKey?: string;
  now?: Date | string;
};

type OutboxRow = {
  id: string;
  deterministic_key: string;
  idempotency_key: string;
  projection_type: string;
  trigger_agenda_entry_id: string;
  projection_revision: number;
  content_hash: string;
  state: PublicProjectionOutboxState;
  payload_json: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  attempts: number;
  next_attempt_at: string | null;
  runtime_lease_name: string | null;
  runtime_owner_id: string | null;
  runtime_fencing_token: number | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  last_error: string | null;
};

const DEFAULT_PROJECTION_TYPE = "language_club_agenda_entry.v1";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_LEASE_DURATION_MS = 60 * 60_000;
const MAX_ERROR_LENGTH = 500;
const MAX_ATTEMPTS = 5;

export function buildPublicProjectionDeterministicKey(input: {
  projectionType?: string;
  projectionRevision: number;
  contentHash: string;
}): string {
  const canonical = JSON.stringify([
    input.projectionType ?? DEFAULT_PROJECTION_TYPE,
    input.projectionRevision,
    input.contentHash
  ]);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function buildPublicProjectionIdempotencyKey(input: {
  projectionType?: string;
  projectionRevision: number;
  contentHash: string;
}): string {
  return `public-projection:${buildPublicProjectionDeterministicKey(input)}`;
}

export function createOrGetPublicProjectionOutbox(
  db: SqliteDatabase,
  input: CreatePublicProjectionOutboxInput
): PublicProjectionOutbox {
  const projectionType = input.projectionType ?? DEFAULT_PROJECTION_TYPE;
  // The payload is the authority for its content hash. A caller-supplied hash
  // is accepted only as an assertion, never as a value to persist.
  const computedContentHash = sha256(input.payloadJson);
  if (input.contentHash !== undefined && input.contentHash !== computedContentHash) {
    throw new Error("Public projection contentHash does not match payloadJson.");
  }
  const contentHash = computedContentHash;
  assertInput(input.triggerAgendaEntryId, input.projectionRevision, input.payloadJson, contentHash);
  const deterministicKey = buildPublicProjectionDeterministicKey({
    projectionType,
    projectionRevision: input.projectionRevision,
    contentHash
  });
  if (input.deterministicKey !== undefined && input.deterministicKey !== deterministicKey) {
    throw new Error("Public projection deterministicKey does not match canonical key.");
  }
  const idempotencyKey = buildPublicProjectionIdempotencyKey({
    projectionType,
    projectionRevision: input.projectionRevision,
    contentHash
  });
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== idempotencyKey) {
    throw new Error("Public projection idempotencyKey does not match canonical key.");
  }
  const now = asIso(input.now);
  db.prepare(
    `INSERT OR IGNORE INTO public_projection_outbox
      (id, deterministic_key, idempotency_key, projection_type, trigger_agenda_entry_id,
       projection_revision, content_hash, state, payload_json, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`
  ).run(
    input.id ?? randomUUID(), deterministicKey, idempotencyKey, projectionType,
    input.triggerAgendaEntryId, input.projectionRevision, contentHash, input.payloadJson, now, now
  );
  const row = db.prepare("SELECT * FROM public_projection_outbox WHERE deterministic_key = ?").get(deterministicKey) as OutboxRow | undefined;
  if (!row) throw new Error("Unable to create public projection outbox item.");
  return mapOutbox(row);
}

export const insertOrGetPublicProjectionOutbox = createOrGetPublicProjectionOutbox;
export const createPublicProjectionOutbox = createOrGetPublicProjectionOutbox;

export function getPublicProjectionOutbox(db: SqliteDatabase, idOrKey: string): PublicProjectionOutbox | null {
  const row = db.prepare(
    "SELECT * FROM public_projection_outbox WHERE id = ? OR deterministic_key = ? OR idempotency_key = ? LIMIT 1"
  ).get(idOrKey, idOrKey, idOrKey) as OutboxRow | undefined;
  return row ? mapOutbox(row) : null;
}

export function listDuePublicProjectionOutbox(
  db: SqliteDatabase,
  now: Date | string = new Date(),
  limit = 100
): PublicProjectionOutbox[] {
  const nowIso = asIso(now);
  const rows = db.prepare(
    `SELECT * FROM public_projection_outbox
     WHERE state IN ('pending', 'retryable')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC LIMIT ?`
  ).all(nowIso, boundedLimit(limit)) as OutboxRow[];
  return rows.map(mapOutbox);
}

export type ClaimPublicProjectionOutboxInput = RuntimeLeaseContext & {
  id: string;
  ownerId: string;
  now?: Date | string;
  leaseDurationMs?: number;
};

export function claimPublicProjectionOutbox(
  db: SqliteDatabase,
  input: ClaimPublicProjectionOutboxInput
): PublicProjectionOutbox | null {
  const now = asIso(input.now);
  const leaseExpiresAt = plusMs(now, boundedLeaseDuration(input.leaseDurationMs));
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
         fencing_token = fencing_token + 1, attempts = attempts + 1,
         runtime_lease_name = ?, runtime_owner_id = ?, runtime_fencing_token = ?,
         next_attempt_at = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND state IN ('pending', 'retryable')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    input.ownerId, leaseExpiresAt, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, now, input.id, now, input.runtimeLeaseName,
    input.runtimeOwnerId, input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1 ? getPublicProjectionOutbox(db, input.id) : null;
}

export const claimPublicProjection = claimPublicProjectionOutbox;

export type PublicProjectionLeaseMutationInput = RuntimeLeaseContext & {
  id: string;
  ownerId: string;
  fencingToken?: number;
  now?: Date | string;
  leaseDurationMs?: number;
};

export function renewPublicProjectionOutboxLease(
  db: SqliteDatabase,
  input: PublicProjectionLeaseMutationInput
): boolean {
  if (input.fencingToken === undefined) return false;
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ?
       AND fencing_token = ? AND lease_expires_at > ?
       AND runtime_lease_name = ? AND runtime_owner_id = ? AND runtime_fencing_token = ?
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    plusMs(now, boundedLeaseDuration(input.leaseDurationMs)), now, input.id, input.ownerId,
    input.fencingToken, now, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const renewPublicProjectionLease = renewPublicProjectionOutboxLease;

export type FinalizePublicProjectionOutboxInput = RuntimeLeaseContext & {
  id: string;
  ownerId: string;
  fencingToken?: number;
  contentHash?: string;
  now?: Date | string;
};

/** Finalize only an unexpired, correctly fenced lease as a succeeded publication. */
export function finalizePublicProjectionOutbox(
  db: SqliteDatabase,
  input: FinalizePublicProjectionOutboxInput
): boolean {
  if (input.fencingToken === undefined) return false;
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
         published_at = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ?
       AND fencing_token = ? AND lease_expires_at > ?
       AND (? IS NULL OR content_hash = ?)
       AND runtime_lease_name = ? AND runtime_owner_id = ? AND runtime_fencing_token = ?
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    now, now, input.id, input.ownerId, input.fencingToken, now,
    input.contentHash ?? null, input.contentHash ?? null,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const finalizePublicProjection = finalizePublicProjectionOutbox;
export const succeedPublicProjectionOutbox = finalizePublicProjectionOutbox;
export const markPublicProjectionSucceeded = finalizePublicProjectionOutbox;

export function markPublicProjectionRetryable(
  db: SqliteDatabase,
  input: PublicProjectionLeaseMutationInput & { error: unknown; nextAttemptAt?: Date | string; maxAttempts?: number }
): boolean {
  if (input.fencingToken === undefined) return false;
  const now = asIso(input.now);
  const currentAttempts = getPublicProjectionOutbox(db, input.id)?.attempts ?? 0;
  const nextAttemptAt = asIso(input.nextAttemptAt ?? new Date(Date.parse(now) + backoffMs(currentAttempts)));
  const state = currentAttempts >= (input.maxAttempts ?? MAX_ATTEMPTS)
    ? "dead_letter"
    : "retryable";
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = CASE WHEN ? = 'retryable' THEN ? ELSE NULL END,
         last_error = ?, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ?
       AND fencing_token = ? AND lease_expires_at > ?
       AND runtime_lease_name = ? AND runtime_owner_id = ? AND runtime_fencing_token = ?
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    state, state, nextAttemptAt, safeError(input.error), now, input.id, input.ownerId,
    input.fencingToken, now, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markPublicProjectionNeedsReconciliation(
  db: SqliteDatabase,
  input: PublicProjectionLeaseMutationInput & { error?: unknown }
): boolean {
  if (input.fencingToken === undefined) return false;
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = 'needs_reconciliation', lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ?
       AND fencing_token = ? AND lease_expires_at > ?
       AND runtime_lease_name = ? AND runtime_owner_id = ? AND runtime_fencing_token = ?
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    input.error === undefined ? null : safeError(input.error), now, input.id, input.ownerId,
    input.fencingToken, now, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const markPublicProjectionOutboxNeedsReconciliation = markPublicProjectionNeedsReconciliation;

export function markPublicProjectionDeadLetter(
  db: SqliteDatabase,
  input: PublicProjectionLeaseMutationInput & { error?: unknown }
): boolean {
  if (input.fencingToken === undefined) return false;
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND state IN ('pending', 'retryable', 'leased')
       AND (state <> 'leased' OR (lease_owner = ? AND fencing_token = ? AND lease_expires_at > ?))
       AND (state <> 'leased' OR (runtime_lease_name = ? AND runtime_owner_id = ? AND runtime_fencing_token = ?))
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    input.error === undefined ? null : safeError(input.error), now, input.id, input.ownerId,
    input.fencingToken, now, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, input.runtimeLeaseName, input.runtimeOwnerId,
    input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export type PublicProjectionReconciliationResolution = "succeeded" | "retryable" | "dead_letter";

export function resolvePublicProjectionOutbox(
  db: SqliteDatabase,
  input: RuntimeLeaseContext & {
    id: string;
    resolution: PublicProjectionReconciliationResolution;
    error?: unknown;
    nextAttemptAt?: Date | string;
    now?: Date | string;
  }
): boolean {
  const now = asIso(input.now);
  const nextAttemptAt = asIso(input.nextAttemptAt ?? now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
         published_at = CASE WHEN ? = 'succeeded' THEN ? ELSE published_at END,
         next_attempt_at = CASE WHEN ? = 'retryable' THEN ? ELSE NULL END,
         last_error = ?, updated_at = ?
     WHERE id = ? AND state = 'needs_reconciliation'
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    input.resolution, input.resolution, now, input.resolution, nextAttemptAt,
    input.error === undefined ? null : safeError(input.error), now, input.id,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const resolvePublicProjectionReconciliation = resolvePublicProjectionOutbox;

export function recoverExpiredPublicProjectionOutbox(
  db: SqliteDatabase,
  input: RuntimeLeaseContext & { now?: Date | string; error?: unknown }
): number {
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE public_projection_outbox
     SET state = 'needs_reconciliation', lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = NULL,
         last_error = COALESCE(last_error, ?), updated_at = ?
     WHERE state = 'leased' AND lease_expires_at <= ?
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(
    input.error === undefined ? "Projection lease expired before publication outcome was recorded." : safeError(input.error),
    now, now, input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now
  ) as { changes?: number };
  return Number(result.changes ?? 0);
}

export const recoverExpiredPublicProjectionLeases = recoverExpiredPublicProjectionOutbox;

function mapOutbox(row: OutboxRow): PublicProjectionOutbox {
  return {
    id: row.id,
    deterministicKey: row.deterministic_key,
    idempotencyKey: row.idempotency_key,
    projectionType: row.projection_type,
    triggerAgendaEntryId: row.trigger_agenda_entry_id,
    projectionRevision: Number(row.projection_revision),
    contentHash: row.content_hash,
    state: row.state,
    payloadJson: row.payload_json,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    fencingToken: Number(row.fencing_token),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ?? undefined,
    runtimeLeaseName: row.runtime_lease_name ?? undefined,
    runtimeOwnerId: row.runtime_owner_id ?? undefined,
    runtimeFencingToken: row.runtime_fencing_token === null ? undefined : Number(row.runtime_fencing_token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? undefined,
    lastError: row.last_error ?? undefined
  };
}

function assertInput(triggerAgendaEntryId: string, revision: number, payloadJson: string, contentHash: string): void {
  if (!triggerAgendaEntryId || triggerAgendaEntryId.length > 200) throw new Error("Public projection triggerAgendaEntryId is invalid.");
  if (!Number.isInteger(revision) || revision < 0) throw new Error("Public projection revision is invalid.");
  if (typeof payloadJson !== "string" || payloadJson.length === 0) throw new Error("Public projection payload is required.");
  if (!contentHash || contentHash.length > 256) throw new Error("Public projection content hash is invalid.");
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function asIso(value?: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function plusMs(now: string, durationMs: number): string {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

function boundedLeaseDuration(value?: number): number {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LEASE_DURATION_MS;
  return Math.min(MAX_LEASE_DURATION_MS, Math.max(1, Math.floor(value)));
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(1000, Math.floor(Number.isFinite(value) ? value : 100)));
}

function safeError(error: unknown): string {
  return toSafeOperationalErrorMessage(error, "Public projection publication failed.").slice(0, MAX_ERROR_LENGTH);
}

function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}
