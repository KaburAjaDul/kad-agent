import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import {
  claimReminderJobForSending,
  listDuePendingReminderJobs,
  markReminderJobSendFailed,
  markReminderJobSent
} from "../repo/event-reminder-repo.js";
import type { ReminderJobRecord } from "../types/reminder-job.js";

export type ReminderDiscordPublisher = {
  publishReminder: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
};

export type ReminderDeliverySweepResult = {
  discoveredDueReminders: number;
  delivered: number;
  failed: number;
};

export async function deliverDueEventReminders(
  db: SqliteDatabase,
  publisher: ReminderDiscordPublisher,
  now: Date = new Date()
): Promise<ReminderDeliverySweepResult> {
  const nowIso = now.toISOString();
  const dueReminders = listDuePendingReminderJobs(db, nowIso);
  let delivered = 0;
  let failed = 0;

  for (const reminder of dueReminders) {
    if (!claimReminderJobForSending(db, reminder.id, nowIso)) {
      continue;
    }

    const targetChannelId = reminder.payload.targetChannelId;

    if (!targetChannelId) {
      if (markReminderJobSendFailed(db, reminder.id, nowIso, "Reminder payload is missing targetChannelId.")) {
        failed += 1;
      }
      continue;
    }

    try {
      const publishResult = await publisher.publishReminder({
        channelId: targetChannelId,
        content: buildReminderMessage(reminder)
      });

      if (markReminderJobSent(db, reminder.id, nowIso, publishResult.messageId)) {
        delivered += 1;
      }
    } catch (error) {
      if (markReminderJobSendFailed(db, reminder.id, nowIso, formatErrorMessage(error))) {
        failed += 1;
      }
    }
  }

  return {
    discoveredDueReminders: dueReminders.length,
    delivered,
    failed
  };
}

export function buildReminderMessage(reminder: ReminderJobRecord): string {
  const clubName = reminder.payload.languageClubDisplayName ?? "Language Club";
  const scheduledStartAt = reminder.payload.scheduledStartAt ?? reminder.scheduledFor;
  const hostVoiceChannelId = reminder.payload.hostVoiceChannelId;
  const timingLabel = reminder.reminderType === "t_minus_24h" ? "24 jam lagi" : "1 jam lagi";

  return [
    `Reminder: ${clubName} mulai ${timingLabel}.`,
    `Start time: ${scheduledStartAt}`,
    hostVoiceChannelId ? `Voice/stage channel: <#${hostVoiceChannelId}>` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown reminder delivery error.";
}
