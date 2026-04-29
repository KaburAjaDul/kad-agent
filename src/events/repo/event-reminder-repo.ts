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
  last_attempted_at: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  created_at: string;
  updated_at: string;
};

export function insertReminderJob(db: SqliteDatabase, reminderJob: ReminderJobRecord): void {
  db.prepare(
    `
      INSERT INTO event_reminders (
        id,
        event_id,
        reminder_type,
        audience_kind,
        scheduled_for,
        state,
        job_key,
        payload_json,
        last_attempted_at,
        delivered_at,
        delivery_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    .all("scheduled", nowIso) as ReminderRow[];

  return rows.map(mapReminderRow);
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
    lastAttemptedAt: row.last_attempted_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    deliveryError: row.delivery_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
