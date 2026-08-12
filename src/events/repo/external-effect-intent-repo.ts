import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { toSafeOperationalErrorMessage } from "../../app/lib/operational-logger.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import type { RuntimeLeaseContext } from "../../app/repo/runtime-lease-repo.js";

export type ExternalEffectState =
  | "pending"
  | "leased"
  | "succeeded"
  | "retryable"
  | "needs_reconciliation"
  | "cancelled"
  | "dead_letter";

export type ExternalEffectIntent = {
  id: string;
  deterministicKey: string;
  kind: string;
  authorityId: string;
  guildId: string;
  state: ExternalEffectState;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  fencingToken: number;
  runtimeFencingToken: number;
  attempts: number;
  nextAttemptAt?: string;
  externalReference?: string;
  lastError?: string;
  lastAttemptedAt?: string;
  succeededAt?: string;
  cancelledAt?: string;
  needsReconciliationAt?: string;
  deadLetteredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateExternalEffectIntentInput = {
  id?: string;
  deterministicKey?: string;
  kind: string;
  authorityId: string;
  guildId: string;
  now?: Date | string;
};

type EffectRow = {
  id: string; deterministic_key: string; kind: string; authority_id: string; guild_id: string;
  state: ExternalEffectState; lease_owner: string | null; lease_expires_at: string | null; fencing_token: number; runtime_fencing_token: number;
  attempts: number; next_attempt_at: string | null; external_reference: string | null;
  last_error: string | null; last_attempted_at: string | null; succeeded_at: string | null;
  cancelled_at: string | null; needs_reconciliation_at: string | null; dead_lettered_at: string | null;
  created_at: string; updated_at: string;
};

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 500;

export function buildExternalEffectDeterministicKey(input: { guildId: string; kind: string; authorityId: string }): string {
  const canonical = JSON.stringify([input.guildId, input.kind, input.authorityId]);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createOrGetExternalEffectIntent(db: SqliteDatabase, input: CreateExternalEffectIntentInput): ExternalEffectIntent {
  const now = asIso(input.now);
  const canonicalKey = buildExternalEffectDeterministicKey(input);
  if (input.deterministicKey && input.deterministicKey !== canonicalKey) {
    throw new Error("External effect deterministicKey does not match canonical authority key.");
  }
  const deterministicKey = canonicalKey;
  db.prepare(
    `INSERT OR IGNORE INTO external_effect_intents
      (id, deterministic_key, kind, authority_id, guild_id, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  ).run(input.id ?? randomUUID(), deterministicKey, input.kind, input.authorityId, input.guildId, now, now);
  const row = db.prepare("SELECT * FROM external_effect_intents WHERE deterministic_key = ?").get(deterministicKey) as EffectRow | undefined;
  if (!row) throw new Error("Unable to create external effect intent.");
  return mapEffect(row);
}

export const insertOrGetExternalEffectIntent = createOrGetExternalEffectIntent;
export const createExternalEffectIntent = createOrGetExternalEffectIntent;

export function getExternalEffectIntent(db: SqliteDatabase, idOrKey: string): ExternalEffectIntent | null {
  const row = db.prepare("SELECT * FROM external_effect_intents WHERE id = ? OR deterministic_key = ? LIMIT 1").get(idOrKey, idOrKey) as EffectRow | undefined;
  return row ? mapEffect(row) : null;
}

export type ClaimExternalEffectInput = {
  id: string;
  ownerId: string;
  now?: Date | string;
  leaseDurationMs?: number;
  runtimeFencingToken: number;
  runtimeLeaseName: string;
  runtimeOwnerId: string;
};

export function claimExternalEffectIntent(db: SqliteDatabase, input: ClaimExternalEffectInput): ExternalEffectIntent | null {
  const now = asIso(input.now);
  const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();
  const result = db.prepare(
    `UPDATE external_effect_intents
     SET state = 'leased', lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1, runtime_fencing_token = ?, attempts = attempts + 1,
         last_attempted_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND state IN ('pending', 'retryable')
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       AND EXISTS (
         SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
       )`
  ).run(input.ownerId, leaseExpiresAt, input.runtimeFencingToken, now, now, input.id, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1 ? getExternalEffectIntent(db, input.id) : null;
}

export function listDueExternalEffectIntents(db: SqliteDatabase, now: Date | string = new Date(), limit = 100): ExternalEffectIntent[] {
  const nowIso = asIso(now);
  const rows = db.prepare(
    `SELECT * FROM external_effect_intents
     WHERE state IN ('pending', 'retryable') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY COALESCE(next_attempt_at, created_at) ASC LIMIT ?`
  ).all(nowIso, Math.max(1, Math.min(limit, 1000))) as EffectRow[];
  return rows.map(mapEffect);
}

export function renewExternalEffectLease(db: SqliteDatabase, input: { id: string; ownerId: string; fencingToken?: number } & RuntimeLeaseContext & { now?: Date | string; leaseDurationMs?: number }): boolean {
  const now = asIso(input.now);
  const expires = new Date(Date.parse(now) + (input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();
  if (input.fencingToken === undefined) return false;
  const result = db.prepare(
    `UPDATE external_effect_intents SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ? AND fencing_token = ? AND runtime_fencing_token = ? AND lease_expires_at > ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(expires, now, input.id, input.ownerId, input.fencingToken, input.runtimeFencingToken, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markExternalEffectSucceeded(db: SqliteDatabase, input: { id: string; ownerId: string; fencingToken?: number; externalReference: string } & RuntimeLeaseContext & { now?: Date | string }): boolean {
  const now = asIso(input.now);
  if (input.fencingToken === undefined) return false;
  const result = db.prepare(
    `UPDATE external_effect_intents
     SET state = 'succeeded', external_reference = ?, lease_owner = NULL, lease_expires_at = NULL,
         succeeded_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND state = 'leased' AND lease_owner = ? AND fencing_token = ? AND runtime_fencing_token = ? AND lease_expires_at > ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(input.externalReference, now, now, input.id, input.ownerId, input.fencingToken, input.runtimeFencingToken, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markExternalEffectRetryable(
  db: SqliteDatabase,
  input: { id: string; ownerId: string; fencingToken?: number; error: unknown; nextAttemptAt?: Date | string; now?: Date | string; maxAttempts?: number } & RuntimeLeaseContext
): boolean {
  const now = asIso(input.now);
  const row = getExternalEffectIntent(db, input.id);
  if (!row || input.fencingToken === undefined || row.state !== "leased" || row.leaseOwner !== input.ownerId || row.fencingToken !== input.fencingToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return false;
  const error = safeError(input.error);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const terminal = row.attempts >= maxAttempts;
  const nextAttemptAt = asIso(input.nextAttemptAt ?? new Date(Date.parse(now) + backoffMs(row.attempts)));
  const result = db.prepare(
    `UPDATE external_effect_intents
     SET state = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?,
         dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ? AND fencing_token = ? AND runtime_fencing_token = ? AND lease_expires_at > ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(terminal ? "dead_letter" : "retryable", error, nextAttemptAt, terminal ? "dead_letter" : "retryable", terminal ? now : null, now, input.id, input.ownerId, input.fencingToken, input.runtimeFencingToken, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const claimExternalEffect = claimExternalEffectIntent;
export const renewExternalEffect = renewExternalEffectLease;
export const succeedExternalEffect = markExternalEffectSucceeded;
export const retryExternalEffect = markExternalEffectRetryable;
export const reconcileExternalEffect = markExternalEffectNeedsReconciliation;
export const deadLetterExternalEffect = markExternalEffectDeadLetter;

export function markExternalEffectNeedsReconciliation(db: SqliteDatabase, input: { id: string; ownerId: string; fencingToken?: number; error?: unknown; now?: Date | string } & RuntimeLeaseContext): boolean {
  const now = asIso(input.now);
  if (input.fencingToken === undefined) return false;
  const result = db.prepare(
    `UPDATE external_effect_intents SET state = 'needs_reconciliation', lease_owner = NULL,
      lease_expires_at = NULL, needs_reconciliation_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND state = 'leased' AND lease_owner = ? AND fencing_token = ? AND runtime_fencing_token = ? AND lease_expires_at > ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(now, input.error === undefined ? null : safeError(input.error), now, input.id, input.ownerId, input.fencingToken, input.runtimeFencingToken, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markExternalEffectDeadLetter(db: SqliteDatabase, input: { id: string; ownerId: string; fencingToken: number; error?: unknown; now?: Date | string } & RuntimeLeaseContext): boolean {
  const now = asIso(input.now);
  const current = getExternalEffectIntent(db, input.id);
  if (!current || (current.state === "leased" && (!current.leaseExpiresAt || current.leaseExpiresAt <= now || current.leaseOwner !== input.ownerId || current.fencingToken !== input.fencingToken))) return false;
  const result = db.prepare(
    `UPDATE external_effect_intents SET state = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
      dead_lettered_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND state IN ('pending', 'retryable', 'leased')
       AND (state <> 'leased' OR (lease_owner = ? AND fencing_token = ?))
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(now, input.error === undefined ? null : safeError(input.error), now, input.id, input.ownerId, input.fencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function cancelExternalEffectIntent(db: SqliteDatabase, input: { id: string; fencingToken: number; now?: Date | string; reason?: unknown } & RuntimeLeaseContext): boolean {
  const now = asIso(input.now);
  const result = db.prepare(
    `UPDATE external_effect_intents SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
      cancelled_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state NOT IN ('succeeded', 'cancelled')
       AND fencing_token = ? AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(now, input.reason === undefined ? null : safeError(input.reason), now, input.id, input.fencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export type ExternalReconciliationResolution = "succeeded" | "retryable" | "dead_letter";

export function resolveExternalEffectReconciliation(
  db: SqliteDatabase,
  input: { id: string; resolution: ExternalReconciliationResolution; externalReference?: string; error?: unknown; nextAttemptAt?: Date | string; now?: Date | string } & RuntimeLeaseContext
): boolean {
  const now = asIso(input.now);
  if (input.resolution === "succeeded" && !input.externalReference) return false;
  const nextAttemptAt = input.nextAttemptAt ? asIso(input.nextAttemptAt) : now;
  const result = db.prepare(
    `UPDATE external_effect_intents
     SET state = ?, external_reference = COALESCE(?, external_reference), last_error = ?,
       next_attempt_at = CASE WHEN ? = 'retryable' THEN ? ELSE next_attempt_at END,
       succeeded_at = CASE WHEN ? = 'succeeded' THEN ? ELSE succeeded_at END,
       dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END,
       needs_reconciliation_at = COALESCE(needs_reconciliation_at, ?), updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ? AND state = 'needs_reconciliation'
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(
    input.resolution,
    input.externalReference ?? null,
    input.error === undefined ? null : safeError(input.error),
    input.resolution,
    nextAttemptAt,
    input.resolution,
    input.resolution === "succeeded" ? now : null,
    input.resolution,
    input.resolution === "dead_letter" ? now : null,
    now,
    now,
    input.id,
    input.runtimeLeaseName,
    input.runtimeOwnerId,
    input.runtimeFencingToken,
    now
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const resolveExternalEffectIntent = resolveExternalEffectReconciliation;

export function recoverExpiredExternalEffectIntents(db: SqliteDatabase, input: ({ now?: Date | string } & RuntimeLeaseContext)): number {
  const nowIso = asIso(input.now);
  const result = db.prepare(
    `UPDATE external_effect_intents SET state = 'needs_reconciliation', lease_owner = NULL,
      lease_expires_at = NULL, needs_reconciliation_at = ?, last_error = COALESCE(last_error, 'Lease expired before effect outcome was recorded.'), updated_at = ?
     WHERE state = 'leased' AND lease_expires_at <= ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(nowIso, nowIso, nowIso, input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, nowIso) as { changes?: number };
  return Number(result.changes ?? 0);
}

function mapEffect(row: EffectRow): ExternalEffectIntent {
  return {
    id: row.id, deterministicKey: row.deterministic_key, kind: row.kind, authorityId: row.authority_id,
    guildId: row.guild_id, state: row.state, leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined, attempts: Number(row.attempts),
    fencingToken: Number(row.fencing_token ?? 0), runtimeFencingToken: Number(row.runtime_fencing_token ?? 0),
    nextAttemptAt: row.next_attempt_at ?? undefined, externalReference: row.external_reference ?? undefined,
    lastError: row.last_error ?? undefined, lastAttemptedAt: row.last_attempted_at ?? undefined,
    succeededAt: row.succeeded_at ?? undefined, cancelledAt: row.cancelled_at ?? undefined,
    needsReconciliationAt: row.needs_reconciliation_at ?? undefined, deadLetteredAt: row.dead_lettered_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function asIso(value?: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function safeError(error: unknown): string {
  return toSafeOperationalErrorMessage(error, "External effect failed.").slice(0, MAX_ERROR_LENGTH);
}

function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}
