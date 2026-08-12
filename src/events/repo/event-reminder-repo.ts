import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import type { ReminderJobRecord, ReminderState } from "../types/reminder-job.js";
import type { RuntimeLeaseContext } from "../../app/repo/runtime-lease-repo.js";

type ReminderRow = {
  id: string; event_id: string; reminder_type: ReminderJobRecord["reminderType"];
  audience_kind: ReminderJobRecord["audienceKind"]; scheduled_for: string; state: ReminderState;
  job_key: string; payload_json: string; discord_message_id: string | null;
  lease_owner: string | null; lease_expires_at: string | null; fencing_token: number | null; runtime_fencing_token: number | null; heartbeat_at: string | null;
  attempts: number | null; next_attempt_at: string | null; needs_reconciliation_at: string | null;
  dead_lettered_at: string | null; last_attempted_at: string | null; delivered_at: string | null;
  delivery_error: string | null; created_at: string; updated_at: string;
};

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function insertReminderJob(db: SqliteDatabase, reminderJob: ReminderJobRecord): void {
  db.prepare(
    `INSERT OR IGNORE INTO event_reminders (
      id, event_id, reminder_type, audience_kind, scheduled_for, state, job_key, payload_json,
      discord_message_id, lease_owner, lease_expires_at, fencing_token, runtime_fencing_token, heartbeat_at, attempts, next_attempt_at,
      needs_reconciliation_at, dead_lettered_at, last_attempted_at, delivered_at, delivery_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    reminderJob.id, reminderJob.eventId, reminderJob.reminderType, reminderJob.audienceKind, reminderJob.scheduledFor,
    reminderJob.state, reminderJob.jobKey, JSON.stringify(reminderJob.payload), reminderJob.discordMessageId ?? null,
    reminderJob.leaseOwner ?? null, reminderJob.leaseExpiresAt ?? null, reminderJob.fencingToken ?? 0, reminderJob.runtimeFencingToken ?? 0, reminderJob.heartbeatAt ?? null,
    reminderJob.attempts ?? 0, reminderJob.nextAttemptAt ?? reminderJob.scheduledFor, reminderJob.needsReconciliationAt ?? null,
    reminderJob.deadLetteredAt ?? null, reminderJob.lastAttemptedAt ?? null, reminderJob.deliveredAt ?? null,
    reminderJob.deliveryError ?? null, reminderJob.createdAt, reminderJob.updatedAt
  );
}

export function listDuePendingReminderJobs(db: SqliteDatabase, nowIso: string): ReminderJobRecord[] {
  const rows = db.prepare(
    `SELECT * FROM event_reminders
     WHERE state IN ('pending', 'retryable')
       AND COALESCE(next_attempt_at, scheduled_for) <= ?
     ORDER BY scheduled_for ASC`
  ).all(nowIso) as ReminderRow[];
  return rows.map(mapReminderRow);
}

export type ReminderClaimOptions = {
  ownerId: string;
  leaseDurationMs?: number;
} & RuntimeLeaseContext;

export type ReminderLease = { ownerId: string; fencingToken: number; leaseExpiresAt: string };

export function claimReminderJobLease(db: SqliteDatabase, reminderId: string, nowIso: string, options: ReminderClaimOptions): ReminderLease | null {
  const ownerId = options.ownerId;
  const leaseExpiresAt = new Date(Date.parse(nowIso) + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();
  const result = db.prepare(
    `UPDATE event_reminders
     SET state = 'sending', lease_owner = ?, lease_expires_at = ?, fencing_token = COALESCE(fencing_token, 0) + 1, runtime_fencing_token = ?, heartbeat_at = ?, attempts = COALESCE(attempts, 0) + 1,
         last_attempted_at = ?, delivery_error = NULL, updated_at = ?
     WHERE id = ? AND state IN ('pending', 'retryable')
       AND COALESCE(next_attempt_at, scheduled_for) <= ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(ownerId, leaseExpiresAt, options.runtimeFencingToken, nowIso, nowIso, nowIso, reminderId, nowIso,
    options.runtimeLeaseName, options.runtimeOwnerId, options.runtimeFencingToken, nowIso) as { changes?: number };
  if (Number(result.changes ?? 0) !== 1) return null;
  const row = db.prepare("SELECT fencing_token FROM event_reminders WHERE id = ?").get(reminderId) as { fencing_token: number } | undefined;
  return row ? { ownerId, fencingToken: Number(row.fencing_token), leaseExpiresAt } : null;
}

export function claimReminderJobForSending(db: SqliteDatabase, reminderId: string, nowIso: string, options: ReminderClaimOptions): boolean {
  return claimReminderJobLease(db, reminderId, nowIso, options) !== null;
}

export function renewReminderJobLease(db: SqliteDatabase, input: { reminderId: string; fencingToken: number; nowIso: string; leaseDurationMs?: number } & RuntimeLeaseContext): boolean {
  const leaseExpiresAt = new Date(Date.parse(input.nowIso) + (input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();
  const result = db.prepare(
    `UPDATE event_reminders SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_owner = ? AND fencing_token = ? AND runtime_fencing_token = ? AND lease_expires_at > ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(leaseExpiresAt, input.nowIso, input.nowIso, input.reminderId, input.runtimeOwnerId, input.fencingToken, input.runtimeFencingToken, input.nowIso,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, input.nowIso) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function recoverExpiredSendingReminderJobs(db: SqliteDatabase, nowIso: string, context: RuntimeLeaseContext): number {
  const result = db.prepare(
    `UPDATE event_reminders SET state = 'needs_reconciliation', needs_reconciliation_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, delivery_error = COALESCE(delivery_error, 'Lease expired before reminder outcome was recorded.'), updated_at = ?
     WHERE state = 'sending' AND lease_expires_at <= ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(nowIso, nowIso, nowIso, context.runtimeLeaseName, context.runtimeOwnerId, context.runtimeFencingToken, nowIso) as { changes?: number };
  return Number(result.changes ?? 0);
}

export function markReminderJobSent(db: SqliteDatabase, reminderId: string, deliveredAt: string, discordMessageId: string, input: { ownerId: string; fencingToken: number } & RuntimeLeaseContext): boolean {
  const result = db.prepare(
    `UPDATE event_reminders SET state = 'sent', last_attempted_at = ?, delivered_at = ?, discord_message_id = ?,
      lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?, delivery_error = NULL, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_owner = ? AND lease_expires_at > ? AND fencing_token = ? AND runtime_fencing_token = ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(deliveredAt, deliveredAt, discordMessageId, deliveredAt, deliveredAt, reminderId, input.ownerId, deliveredAt, input.fencingToken, input.runtimeFencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, deliveredAt) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markReminderJobSendFailed(db: SqliteDatabase, reminderId: string, attemptedAt: string, deliveryError: string, input: { ownerId: string; fencingToken: number } & RuntimeLeaseContext): boolean {
  const result = db.prepare(
    `UPDATE event_reminders SET state = 'send_failed', last_attempted_at = ?, delivery_error = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_owner = ? AND lease_expires_at > ? AND fencing_token = ? AND runtime_fencing_token = ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(attemptedAt, deliveryError.slice(0, 500), attemptedAt, reminderId, input.ownerId, attemptedAt, input.fencingToken, input.runtimeFencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, attemptedAt) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markReminderJobRetryable(
  db: SqliteDatabase,
  input: { reminderId: string; attemptedAt: string; deliveryError: string; ownerId: string; fencingToken: number; nextAttemptAt?: string; maxAttempts?: number } & RuntimeLeaseContext
): boolean {
  const row = getReminderJob(db, input.reminderId);
  if (
    !row ||
    row.state !== "sending" ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt <= input.attemptedAt ||
    row.leaseOwner !== input.ownerId || row.fencingToken !== input.fencingToken || row.runtimeFencingToken !== input.runtimeFencingToken
  ) return false;
  const terminal = (row.attempts ?? 0) >= (input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const nextAttemptAt = input.nextAttemptAt ?? new Date(Date.parse(input.attemptedAt) + backoffMs(row.attempts ?? 1)).toISOString();
  const result = db.prepare(
    `UPDATE event_reminders SET state = ?, delivery_error = ?, next_attempt_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_owner = ? AND lease_expires_at > ? AND fencing_token = ? AND runtime_fencing_token = ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(terminal ? "dead_letter" : "retryable", input.deliveryError.slice(0, 500), nextAttemptAt, terminal ? "dead_letter" : "retryable", terminal ? input.attemptedAt : null, input.attemptedAt, input.reminderId, input.ownerId, input.attemptedAt, input.fencingToken, input.runtimeFencingToken,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, input.attemptedAt) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const recoverExpiredSendingReminders = recoverExpiredSendingReminderJobs;

export type ReminderReconciliationResolution = "sent" | "retryable" | "dead_letter";

export function resolveReminderJobReconciliation(
  db: SqliteDatabase,
  input: { reminderId: string; resolution: ReminderReconciliationResolution; resolvedAt: string; discordMessageId?: string; deliveryError?: string; nextAttemptAt?: string } & RuntimeLeaseContext
): boolean {
  if (input.resolution === "sent" && !input.discordMessageId) return false;
  const nextAttemptAt = input.nextAttemptAt ?? input.resolvedAt;
  const result = db.prepare(
    `UPDATE event_reminders SET state = ?, discord_message_id = COALESCE(?, discord_message_id),
       delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END,
       next_attempt_at = CASE WHEN ? = 'retryable' THEN ? ELSE next_attempt_at END,
       dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END,
       delivery_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'needs_reconciliation'
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(
    input.resolution,
    input.discordMessageId ?? null,
    input.resolution,
    input.resolution === "sent" ? input.resolvedAt : null,
    input.resolution,
    nextAttemptAt,
    input.resolution,
    input.resolution === "dead_letter" ? input.resolvedAt : null,
    input.deliveryError?.slice(0, 500) ?? null,
    input.resolvedAt,
    input.reminderId,
    input.runtimeLeaseName,
    input.runtimeOwnerId,
    input.runtimeFencingToken,
    input.resolvedAt
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export const resolveReminderReconciliation = resolveReminderJobReconciliation;

/** Records an ambiguous provider result after the delivery lease expired; never marks it sent. */
export function recordExpiredReminderOutcome(
  db: SqliteDatabase,
  input: { reminderId: string; attemptedAt: string; deliveryError: string; discordMessageId?: string } & RuntimeLeaseContext
): boolean {
  const result = db.prepare(
    `UPDATE event_reminders SET state = 'needs_reconciliation', needs_reconciliation_at = ?,
       delivery_error = ?, discord_message_id = COALESCE(?, discord_message_id), lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_expires_at <= ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(input.attemptedAt, input.deliveryError.slice(0, 500), input.discordMessageId ?? null, input.attemptedAt, input.reminderId, input.attemptedAt,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, input.attemptedAt) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function markReminderJobNeedsReconciliation(
  db: SqliteDatabase,
  input: { reminderId: string; attemptedAt: string; deliveryError: string; ownerId: string; fencingToken: number; discordMessageId?: string } & RuntimeLeaseContext
): boolean {
  const result = db.prepare(
    `UPDATE event_reminders SET state = 'needs_reconciliation', needs_reconciliation_at = ?, delivery_error = ?,
       discord_message_id = COALESCE(?, discord_message_id), lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'sending' AND lease_owner = ? AND lease_expires_at > ? AND fencing_token = ? AND runtime_fencing_token = ?
       AND EXISTS (SELECT 1 FROM runtime_leases AS runtime WHERE runtime.lease_key = ? AND runtime.owner_id = ? AND runtime.fencing_token = ? AND runtime.expires_at > ?)`
  ).run(
    input.attemptedAt,
    input.deliveryError.slice(0, 500),
    input.discordMessageId ?? null,
    input.attemptedAt,
    input.reminderId,
    input.ownerId,
    input.attemptedAt,
    input.fencingToken,
    input.runtimeFencingToken,
    input.runtimeLeaseName,
    input.runtimeOwnerId,
    input.runtimeFencingToken,
    input.attemptedAt
  ) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function getReminderJob(db: SqliteDatabase, reminderId: string): ReminderJobRecord | null {
  const row = db.prepare("SELECT * FROM event_reminders WHERE id = ?").get(reminderId) as ReminderRow | undefined;
  return row ? mapReminderRow(row) : null;
}

function mapReminderRow(row: ReminderRow): ReminderJobRecord {
  return {
    id: row.id, eventId: row.event_id, reminderType: row.reminder_type, audienceKind: row.audience_kind,
    scheduledFor: row.scheduled_for, state: row.state, jobKey: row.job_key,
    payload: JSON.parse(row.payload_json) as ReminderJobRecord["payload"], discordMessageId: row.discord_message_id ?? undefined,
    leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined, fencingToken: Number(row.fencing_token ?? 0), runtimeFencingToken: Number(row.runtime_fencing_token ?? 0), heartbeatAt: row.heartbeat_at ?? undefined,
    attempts: Number(row.attempts ?? 0), nextAttemptAt: row.next_attempt_at ?? undefined,
    needsReconciliationAt: row.needs_reconciliation_at ?? undefined, deadLetteredAt: row.dead_lettered_at ?? undefined,
    lastAttemptedAt: row.last_attempted_at ?? undefined, deliveredAt: row.delivered_at ?? undefined,
    deliveryError: row.delivery_error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}
