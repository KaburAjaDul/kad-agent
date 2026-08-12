import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import { toSafeOperationalErrorMessage } from "../../app/lib/operational-logger.js";
import {
  claimReminderJobLease,
  listDuePendingReminderJobs,
  markReminderJobNeedsReconciliation,
  markReminderJobRetryable,
  markReminderJobSendFailed,
  markReminderJobSent,
  recordExpiredReminderOutcome,
  recoverExpiredSendingReminderJobs,
  renewReminderJobLease
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

export type ReminderDeliveryOptions = {
  now?: Date | (() => Date);
  ownerId?: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  heartbeatIntervalMs?: number;
  runtimeFencingToken?: number;
  runtimeLeaseName?: string;
  runtimeOwnerId?: string;
};

export async function deliverDueEventReminders(
  db: SqliteDatabase,
  publisher: ReminderDiscordPublisher,
  nowOrOptions: Date | (() => Date) | ReminderDeliveryOptions = new Date()
): Promise<ReminderDeliverySweepResult> {
  const options = nowOrOptions instanceof Date || typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  const clock = createClock(options.now);
  const sweepStartedAt = clock().toISOString();
  const ownerId = options.ownerId ?? "reminder-delivery";
  if (!options.runtimeLeaseName || !options.runtimeOwnerId || options.runtimeFencingToken === undefined) {
    throw new Error("Reminder delivery requires an active runtime lease context.");
  }
  const runtimeContext = { runtimeLeaseName: options.runtimeLeaseName, runtimeOwnerId: options.runtimeOwnerId, runtimeFencingToken: options.runtimeFencingToken };
  recoverExpiredSendingReminderJobs(db, sweepStartedAt, runtimeContext);
  const dueReminders = listDuePendingReminderJobs(db, sweepStartedAt);
  let delivered = 0;
  let failed = 0;

  for (const reminder of dueReminders) {
    const runtimeFencingToken = options.runtimeFencingToken;
    const leaseContext = runtimeContext;
    const lease = claimReminderJobLease(db, reminder.id, sweepStartedAt, { ownerId, leaseDurationMs: options.leaseDurationMs, ...leaseContext });
    if (!lease) continue;
    const targetChannelId = reminder.payload.targetChannelId;

    if (!targetChannelId) {
      const completedAt = clock().toISOString();
      if (!markReminderJobSendFailed(db, reminder.id, completedAt, "Reminder payload is missing targetChannelId.", { ownerId, fencingToken: lease.fencingToken, ...leaseContext })) {
        markReminderJobNeedsReconciliation(db, {
          reminderId: reminder.id,
          attemptedAt: completedAt,
          deliveryError: "Reminder lease expired before invalid payload state was recorded.",
          ownerId,
          fencingToken: lease.fencingToken,
          ...leaseContext
        });
      }
      failed += 1;
      continue;
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(10, Math.min(30_000, Math.floor((options.leaseDurationMs ?? 60_000) / 3)));
      heartbeatTimer = setInterval(() => {
        renewReminderJobLease(db, {
          reminderId: reminder.id,
          fencingToken: lease.fencingToken,
          ...leaseContext,
          nowIso: clock().toISOString(),
          leaseDurationMs: options.leaseDurationMs
        });
      }, heartbeatIntervalMs);
      const publishResult = await publisher.publishReminder({ channelId: targetChannelId, content: buildReminderMessage(reminder) });
      const completedAt = clock().toISOString();
      if (!publishResult?.messageId) {
        markReminderJobNeedsReconciliation(db, { reminderId: reminder.id, attemptedAt: completedAt, deliveryError: "Discord accepted no message reference; outcome requires reconciliation.", ownerId, fencingToken: lease.fencingToken, ...leaseContext });
        failed += 1;
      } else if (markReminderJobSent(db, reminder.id, completedAt, publishResult.messageId, { ownerId, fencingToken: lease.fencingToken, ...leaseContext })) {
        delivered += 1;
      } else {
        const reconciled = markReminderJobNeedsReconciliation(db, {
          reminderId: reminder.id,
          attemptedAt: completedAt,
          deliveryError: "Discord returned a message reference after the delivery lease expired; reconcile before retrying.",
          ownerId,
          fencingToken: lease.fencingToken,
          ...leaseContext,
          discordMessageId: publishResult.messageId
        });
        if (!reconciled) recordExpiredReminderOutcome(db, {
          reminderId: reminder.id,
          attemptedAt: completedAt,
          deliveryError: "Discord returned a message reference after the delivery lease expired; reconcile before retrying.",
          discordMessageId: publishResult.messageId,
          ...leaseContext
        });
        failed += 1;
      }
    } catch (error) {
      const completedAt = clock().toISOString();
      const safeError = formatErrorMessage(error);
      const transition = isAmbiguousEffect(error)
        ? markReminderJobNeedsReconciliation(db, { reminderId: reminder.id, attemptedAt: completedAt, deliveryError: safeError, ownerId, fencingToken: lease.fencingToken, ...leaseContext })
        : markReminderJobRetryable(db, {
            reminderId: reminder.id,
            attemptedAt: completedAt,
            deliveryError: safeError,
            ownerId,
            fencingToken: lease.fencingToken,
            ...leaseContext,
            maxAttempts: options.maxAttempts
          });
      if (!transition) {
        const reconciled = markReminderJobNeedsReconciliation(db, {
          reminderId: reminder.id,
          attemptedAt: completedAt,
          deliveryError: "Reminder outcome was not recorded before its delivery lease expired.",
          ownerId,
          fencingToken: lease.fencingToken,
          ...leaseContext
        });
        if (!reconciled) recordExpiredReminderOutcome(db, {
          reminderId: reminder.id,
          attemptedAt: completedAt,
          deliveryError: "Reminder outcome was not recorded before its delivery lease expired.",
          ...leaseContext
        });
      }
      failed += 1;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  return { discoveredDueReminders: dueReminders.length, delivered, failed };
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
  ].filter((line): line is string => line !== null).join("\n");
}

function formatErrorMessage(error: unknown): string {
  return toSafeOperationalErrorMessage(error, "Unknown reminder delivery error.").slice(0, MAX_PROVIDER_ERROR_LENGTH);
}

function isAmbiguousEffect(error: unknown): boolean {
  if (error && typeof error === "object" && "ambiguous" in error && error.ambiguous === true) return true;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /timeout|timed out|unknown outcome|ambiguous/i.test(`${code} ${message}`);
}

function createClock(now?: Date | (() => Date)): () => Date {
  if (typeof now === "function") return now;
  if (now instanceof Date) return () => now;
  return () => new Date();
}

const MAX_PROVIDER_ERROR_LENGTH = 500;
