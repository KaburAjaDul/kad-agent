import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import type { ReminderJobRecord } from "../types/reminder-job.js";

type ReminderRow = {
  id: string;
  event_id: string;
  reminder_type: ReminderJobRecord["reminderType"];
  audience_kind: ReminderJobRecord["audienceKind"];
  scheduled_for: string;
  state: ReminderJobRecord["state"];
  job_key: string;
  payload_json: string;
  discord_message_id: string | null;
  last_attempted_at: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  created_at: string;
  updated_at: string;
};

export function insertReminderJob(db: SqliteDatabase, reminderJob: ReminderJobRecord): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO event_reminders (
        id,
        event_id,
        reminder_type,
        audience_kind,
        scheduled_for,
        state,
        job_key,
        payload_json,
        discord_message_id,
        last_attempted_at,
        delivered_at,
        delivery_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    reminderJob.id,
    reminderJob.eventId,
    reminderJob.reminderType,
    reminderJob.audienceKind,
    reminderJob.scheduledFor,
    reminderJob.state,
    reminderJob.jobKey,
    JSON.stringify(reminderJob.payload),
    reminderJob.discordMessageId ?? null,
    reminderJob.lastAttemptedAt ?? null,
    reminderJob.deliveredAt ?? null,
    reminderJob.deliveryError ?? null,
    reminderJob.createdAt,
    reminderJob.updatedAt
  );
}

export function listDuePendingReminderJobs(db: SqliteDatabase, nowIso: string): ReminderJobRecord[] {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          event_id,
          reminder_type,
          audience_kind,
          scheduled_for,
          state,
          job_key,
          payload_json,
          discord_message_id,
          last_attempted_at,
          delivered_at,
          delivery_error,
          created_at,
          updated_at
        FROM event_reminders
        WHERE state = ?
          AND scheduled_for <= ?
        ORDER BY scheduled_for ASC
      `
    )
    .all("pending", nowIso) as ReminderRow[];

  return rows.map(mapReminderRow);
}

export function claimReminderJobForSending(db: SqliteDatabase, reminderId: string, nowIso: string): boolean {
  const result = db
    .prepare(
      `
        UPDATE event_reminders
        SET state = ?,
            last_attempted_at = ?,
            delivery_error = NULL,
            updated_at = ?
        WHERE id = ?
          AND state = ?
          AND scheduled_for <= ?
      `
    )
    .run("sending", nowIso, nowIso, reminderId, "pending", nowIso) as { changes?: number };

  return Number(result.changes ?? 0) === 1;
}

export function markReminderJobSent(
  db: SqliteDatabase,
  reminderId: string,
  deliveredAt: string,
  discordMessageId: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE event_reminders
        SET state = ?,
            last_attempted_at = ?,
            delivered_at = ?,
            discord_message_id = ?,
            delivery_error = NULL,
            updated_at = ?
        WHERE id = ?
          AND state = ?
      `
    )
    .run("sent", deliveredAt, deliveredAt, discordMessageId, deliveredAt, reminderId, "sending") as { changes?: number };

  return Number(result.changes ?? 0) === 1;
}

export function markReminderJobSendFailed(db: SqliteDatabase, reminderId: string, attemptedAt: string, deliveryError: string): boolean {
  const result = db
    .prepare(
      `
        UPDATE event_reminders
        SET state = ?,
            last_attempted_at = ?,
            delivery_error = ?,
            updated_at = ?
        WHERE id = ?
          AND state = ?
      `
    )
    .run("send_failed", attemptedAt, deliveryError, attemptedAt, reminderId, "sending") as { changes?: number };

  return Number(result.changes ?? 0) === 1;
}

function mapReminderRow(row: ReminderRow): ReminderJobRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    reminderType: row.reminder_type,
    audienceKind: row.audience_kind,
    scheduledFor: row.scheduled_for,
    state: row.state,
    jobKey: row.job_key,
    payload: JSON.parse(row.payload_json) as ReminderJobRecord["payload"],
    discordMessageId: row.discord_message_id ?? undefined,
    lastAttemptedAt: row.last_attempted_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    deliveryError: row.delivery_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
