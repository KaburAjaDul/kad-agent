import { randomUUID } from "node:crypto";
import type { CreateReminderJobInput, ReminderJobRecord } from "../types/reminder-job.js";

export function buildReminderJobRecord(input: CreateReminderJobInput): ReminderJobRecord {
  const nowIso = (input.now ?? new Date()).toISOString();

  return {
    id: randomUUID(),
    eventId: input.eventId,
    reminderType: input.reminderType,
    audienceKind: input.audienceKind,
    scheduledFor: input.scheduledFor,
    state: "pending",
    jobKey: ["event_reminder", input.eventId, input.reminderType, input.audienceKind, input.scheduledFor].join(":"),
    payload: input.payload ?? {},
    createdAt: nowIso,
    updatedAt: nowIso
  };
}
