import { toSafeOperationalErrorMessage } from "../../app/lib/operational-logger.js";
import {
  claimExternalEffectIntent,
  createOrGetExternalEffectIntent,
  getExternalEffectIntent,
  markExternalEffectNeedsReconciliation,
  markExternalEffectRetryable,
  markExternalEffectSucceeded,
  type ExternalEffectIntent
} from "../repo/external-effect-intent-repo.js";
import {
  getLanguageClubEventById,
  confirmLanguageClubExternalEffectReference,
  markLanguageClubEventPublished,
  recordLateExternalEffectReference,
  storeLanguageClubEventDiscordScheduledEventId,
  type EventStateTransitionRecord,
  type LanguageClubEffectFinalizerContext,
  type StoredLanguageClubEvent
} from "../repo/language-club-event-repo.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";

const SCHEDULED_EVENT_EFFECT_KIND = "discord_scheduled_event_create";
const ANNOUNCEMENT_EFFECT_KIND = "discord_announcement_send";
const MAX_ERROR_LENGTH = 500;

export type LanguageClubEffectExecutionContext = {
  ownerId: string;
  runtimeLeaseName: string;
  runtimeOwnerId: string;
  runtimeFencingToken: number;
  leaseDurationMs?: number;
};

export type LanguageClubEffectReconciliationPublisher = {
  createScheduledEvent: (input: {
    guildId: string;
    channelId: string;
    title: string;
    description: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
  }) => Promise<{ scheduledEventId: string }>;
  publishAnnouncement: (input: {
    channelId: string;
    content: string;
    allowedUserIds: string[];
  }) => Promise<{ messageId: string }>;
};

export type LanguageClubEffectInput = {
  db: SqliteDatabase;
  event: StoredLanguageClubEvent;
  publisher: LanguageClubEffectReconciliationPublisher;
  executionContext: LanguageClubEffectExecutionContext;
  hostDiscordUserIds: string[];
  now: Date;
  actorDiscordUserId: string;
  allowScheduledEventCreate?: boolean;
  confirmedScheduledEventId?: string;
};

export type LanguageClubEffectResult =
  | { status: "published"; scheduledEventId: string; messageId: string }
  | { status: "incomplete"; reason: string; scheduledEventId: string | null };

/**
 * Runs the durable two-effect publication sequence. A succeeded intent is
 * always reused; an ambiguous outcome is never sent again automatically.
 */
export async function publishLanguageClubEventEffects(input: LanguageClubEffectInput): Promise<LanguageClubEffectResult> {
  let event = getLanguageClubEventById(input.db, input.event.id) ?? input.event;
  const scheduledIntent = createOrGetExternalEffectIntent(input.db, {
    kind: SCHEDULED_EVENT_EFFECT_KIND,
    authorityId: event.id,
    guildId: event.guildId,
    now: input.now
  });

  if (
    input.confirmedScheduledEventId &&
    scheduledIntent.state === "needs_reconciliation" &&
    scheduledIntent.externalReference === input.confirmedScheduledEventId
  ) {
    confirmLanguageClubExternalEffectReference(input.db, {
      effectId: scheduledIntent.id,
      externalReference: input.confirmedScheduledEventId,
      fencingToken: scheduledIntent.fencingToken,
      runtimeFencingToken: input.executionContext.runtimeFencingToken,
      runtimeLeaseName: input.executionContext.runtimeLeaseName,
      runtimeOwnerId: input.executionContext.runtimeOwnerId,
      occurredAt: input.now.toISOString(),
      actorId: input.actorDiscordUserId
    });
  }

  const refreshedScheduledIntent = getExternalEffectIntent(input.db, scheduledIntent.id) ?? scheduledIntent;

  let scheduledEventId = event.discordScheduledEventId ?? refreshedScheduledIntent.externalReference ?? null;

  if (input.confirmedScheduledEventId) {
    if (refreshedScheduledIntent.externalReference && refreshedScheduledIntent.externalReference !== input.confirmedScheduledEventId) {
      return incomplete("Confirmed Scheduled Event reference does not match the durable effect intent.", scheduledEventId);
    }
    scheduledEventId = input.confirmedScheduledEventId;
  }

  if (scheduledEventId && event.discordScheduledEventId !== scheduledEventId) {
    if (refreshedScheduledIntent.state !== "succeeded" || !refreshedScheduledIntent.externalReference) {
      return incomplete("Scheduled Event reference requires a succeeded durable effect intent.", scheduledEventId);
    }
    try {
      storeLanguageClubEventDiscordScheduledEventId(
        input.db,
        event.id,
        scheduledEventId,
        input.now.toISOString(),
        finalizerContext(input.executionContext, refreshedScheduledIntent, input.now.toISOString())
      );
    } catch (error) {
      return incomplete(formatErrorMessage(error), scheduledEventId);
    }
    event = getLanguageClubEventById(input.db, event.id) ?? event;
  }

  if (!scheduledEventId) {
    if (refreshedScheduledIntent.state === "needs_reconciliation") {
      return incomplete("Scheduled Event outcome requires reconciliation before another Discord call.", null);
    }
    if (!input.allowScheduledEventCreate) {
      return incomplete("Scheduled Event reference is not confirmed; repair will not create an external event.", null);
    }

    const lease = claimExternalEffectIntent(input.db, {
      id: scheduledIntent.id,
      ownerId: input.executionContext.ownerId,
      runtimeFencingToken: input.executionContext.runtimeFencingToken,
      runtimeLeaseName: input.executionContext.runtimeLeaseName,
      runtimeOwnerId: input.executionContext.runtimeOwnerId,
      leaseDurationMs: input.executionContext.leaseDurationMs,
      now: input.now
    });
    if (!lease) {
      return effectNotClaimable(input.db, scheduledIntent.id, "Scheduled Event effect is already leased or requires reconciliation.", null);
    }

    try {
      const result = await input.publisher.createScheduledEvent({
        guildId: event.guildId,
        channelId: event.hostVoiceChannelId ?? "",
        title: event.title,
        description: event.description,
        scheduledStartAt: event.scheduledStartAt,
        scheduledEndAt: event.scheduledEndAt
      });
      if (!result.scheduledEventId) {
        markNeedsReconciliation(input.db, lease, input.executionContext, "Discord Scheduled Event returned no reference.", input.now);
        return incomplete("Discord Scheduled Event returned no reference; reconciliation is required.", null);
      }
      if (!markExternalEffectSucceeded(input.db, succeededInput(lease, input.executionContext, result.scheduledEventId, input.now))) {
        recordLateExternalEffectReference(input.db, {
          effectId: lease.id,
          externalReference: result.scheduledEventId,
          fencingToken: lease.fencingToken,
          runtimeFencingToken: lease.runtimeFencingToken,
          occurredAt: input.now.toISOString(),
          error: "Scheduled Event returned after its effect lease expired; operator reconciliation required."
        });
        return incomplete("Scheduled Event succeeded but its durable finalizer could not be recorded.", result.scheduledEventId);
      }
      scheduledEventId = result.scheduledEventId;
      storeLanguageClubEventDiscordScheduledEventId(
        input.db,
        event.id,
        scheduledEventId,
        input.now.toISOString(),
        finalizerContext(input.executionContext, { ...lease, state: "succeeded", externalReference: scheduledEventId }, input.now.toISOString())
      );
      event = getLanguageClubEventById(input.db, event.id) ?? event;
    } catch (error) {
      const classification = classifyEffectFailure(error);
      if (classification === "needs_reconciliation") {
        markNeedsReconciliation(input.db, lease, input.executionContext, error, input.now);
      } else {
        markRetryable(input.db, lease, input.executionContext, error, input.now);
      }
      return incomplete(formatErrorMessage(error), scheduledEventId);
    }
  }

  if (!scheduledEventId) {
    return incomplete("Scheduled Event publication is incomplete.", null);
  }

  const announcementIntent = createOrGetExternalEffectIntent(input.db, {
    kind: ANNOUNCEMENT_EFFECT_KIND,
    authorityId: event.id,
    guildId: event.guildId,
    now: input.now
  });
  const existingMessageId = event.discordAnnouncementMessageId ?? announcementIntent.externalReference ?? null;

  if (existingMessageId) {
    if (announcementIntent.state !== "succeeded" || !announcementIntent.externalReference) {
      return incomplete("Announcement reference requires a succeeded durable effect intent.", scheduledEventId);
    }
    if (event.state === "published" && event.discordScheduledEventId === scheduledEventId && event.discordAnnouncementMessageId === existingMessageId) {
      return { status: "published", scheduledEventId, messageId: existingMessageId };
    }
    try {
      finalizePublishedEvent(input, event, scheduledEventId, existingMessageId, announcementIntent);
    } catch (error) {
      return incomplete(formatErrorMessage(error), scheduledEventId);
    }
    return { status: "published", scheduledEventId, messageId: existingMessageId };
  }

  if (announcementIntent.state === "needs_reconciliation") {
    return incomplete("Announcement outcome requires reconciliation before another Discord call.", scheduledEventId);
  }

  const announcementLease = claimExternalEffectIntent(input.db, {
    id: announcementIntent.id,
    ownerId: input.executionContext.ownerId,
    runtimeFencingToken: input.executionContext.runtimeFencingToken,
    runtimeLeaseName: input.executionContext.runtimeLeaseName,
    runtimeOwnerId: input.executionContext.runtimeOwnerId,
    leaseDurationMs: input.executionContext.leaseDurationMs,
    now: input.now
  });
  if (!announcementLease) {
    return effectNotClaimable(input.db, announcementIntent.id, "Announcement effect is already leased or requires reconciliation.", scheduledEventId);
  }

  try {
    const result = await input.publisher.publishAnnouncement({
      channelId: event.announcementChannelId,
      content: buildAnnouncementMessage(event, input.hostDiscordUserIds),
      allowedUserIds: input.hostDiscordUserIds
    });
    if (!result.messageId) {
      markNeedsReconciliation(input.db, announcementLease, input.executionContext, "Discord announcement returned no message reference.", input.now);
      return incomplete("Announcement returned no message reference; reconciliation is required.", scheduledEventId);
    }
    if (!markExternalEffectSucceeded(input.db, succeededInput(announcementLease, input.executionContext, result.messageId, input.now))) {
      recordLateExternalEffectReference(input.db, {
        effectId: announcementLease.id,
        externalReference: result.messageId,
        fencingToken: announcementLease.fencingToken,
        runtimeFencingToken: announcementLease.runtimeFencingToken,
        occurredAt: input.now.toISOString(),
        error: "Announcement returned after its effect lease expired; operator reconciliation required."
      });
      return incomplete("Announcement succeeded but its durable finalizer could not be recorded.", scheduledEventId);
    }
    finalizePublishedEvent(
      input,
      event,
      scheduledEventId,
      result.messageId,
      { ...announcementLease, state: "succeeded", externalReference: result.messageId }
    );
    return { status: "published", scheduledEventId, messageId: result.messageId };
  } catch (error) {
    const classification = classifyEffectFailure(error);
    if (classification === "needs_reconciliation") {
      markNeedsReconciliation(input.db, announcementLease, input.executionContext, error, input.now);
    } else {
      markRetryable(input.db, announcementLease, input.executionContext, error, input.now);
    }
    return incomplete(formatErrorMessage(error), scheduledEventId);
  }
}

/** Operator-facing repair API. It never creates a Scheduled Event. */
export async function reconcileLanguageClubEventEffects(input: Omit<LanguageClubEffectInput, "allowScheduledEventCreate"> & { confirmedScheduledEventId?: string }): Promise<LanguageClubEffectResult> {
  return publishLanguageClubEventEffects({ ...input, allowScheduledEventCreate: false });
}

export const repairLanguageClubEventPublication = reconcileLanguageClubEventEffects;
export const reconcileLanguageClubEventPublication = reconcileLanguageClubEventEffects;

function finalizePublishedEvent(
  input: LanguageClubEffectInput,
  event: StoredLanguageClubEvent,
  scheduledEventId: string,
  messageId: string,
  announcementIntent: ExternalEffectIntent
): void {
  const transition: EventStateTransitionRecord = {
    id: `language-club-published:${event.id}:${messageId}`,
    eventId: event.id,
    fromState: event.state,
    toState: "published",
    actorDiscordUserId: input.actorDiscordUserId,
    occurredAt: input.now.toISOString(),
    reason: "language_club_effect_reconciliation_success"
  };
  markLanguageClubEventPublished(
    input.db,
    event.id,
    input.now.toISOString(),
    messageId,
    transition,
    finalizerContext(input.executionContext, announcementIntent, input.now.toISOString())
  );
}

function effectNotClaimable(db: SqliteDatabase, id: string, reason: string, scheduledEventId: string | null): LanguageClubEffectResult {
  const current = getExternalEffectIntent(db, id);
  if (current?.state === "succeeded" && current.externalReference) {
    return { status: "incomplete", reason: "Effect succeeded but event finalization is pending.", scheduledEventId: scheduledEventId ?? current.externalReference };
  }
  return incomplete(reason, scheduledEventId);
}

function succeededInput(lease: ExternalEffectIntent, context: LanguageClubEffectExecutionContext, externalReference: string, now: Date) {
  return {
    id: lease.id,
    ownerId: context.ownerId,
    fencingToken: lease.fencingToken,
    runtimeFencingToken: context.runtimeFencingToken,
    runtimeLeaseName: context.runtimeLeaseName,
    runtimeOwnerId: context.runtimeOwnerId,
    externalReference,
    now
  };
}

function finalizerContext(context: LanguageClubEffectExecutionContext, intent: ExternalEffectIntent, checkedAt = new Date().toISOString()): LanguageClubEffectFinalizerContext {
  if (context.runtimeFencingToken < intent.runtimeFencingToken) {
    throw new Error("External effect finalizer runtime fencing token is stale.");
  }
  return {
    effectId: intent.id,
    ownerId: context.ownerId,
    fencingToken: intent.fencingToken,
    runtimeFencingToken: intent.runtimeFencingToken,
    runtimeLeaseName: context.runtimeLeaseName,
    runtimeOwnerId: context.runtimeOwnerId,
    currentRuntimeFencingToken: context.runtimeFencingToken,
    checkedAt
  };
}

function markNeedsReconciliation(db: SqliteDatabase, lease: ExternalEffectIntent, context: LanguageClubEffectExecutionContext, error: unknown, now: Date): void {
  markExternalEffectNeedsReconciliation(db, {
    id: lease.id,
    ownerId: context.ownerId,
    fencingToken: lease.fencingToken,
    runtimeFencingToken: context.runtimeFencingToken,
    runtimeLeaseName: context.runtimeLeaseName,
    runtimeOwnerId: context.runtimeOwnerId,
    error,
    now
  });
}

function markRetryable(db: SqliteDatabase, lease: ExternalEffectIntent, context: LanguageClubEffectExecutionContext, error: unknown, now: Date): void {
  markExternalEffectRetryable(db, {
    id: lease.id,
    ownerId: context.ownerId,
    fencingToken: lease.fencingToken,
    runtimeFencingToken: context.runtimeFencingToken,
    runtimeLeaseName: context.runtimeLeaseName,
    runtimeOwnerId: context.runtimeOwnerId,
    error,
    now
  });
}

function classifyEffectFailure(error: unknown): "retryable" | "needs_reconciliation" {
  if (typeof error === "object" && error !== null && "outcome" in error) {
    const outcome = (error as { outcome?: string }).outcome;
    if (outcome === "before_call" || outcome === "retryable") return "retryable";
  }
  if (error instanceof Error && /before[- ]call|validation|not attempted/i.test(error.message)) return "retryable";
  return "needs_reconciliation";
}

function formatErrorMessage(error: unknown): string {
  return toSafeOperationalErrorMessage(error, "Language Club publication failed.").slice(0, MAX_ERROR_LENGTH);
}

function incomplete(reason: string, scheduledEventId: string | null): LanguageClubEffectResult {
  return { status: "incomplete", reason, scheduledEventId };
}

function buildAnnouncementMessage(event: StoredLanguageClubEvent, hostDiscordUserIds: string[]): string {
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone: event.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const scheduleLabel = formatter.format(new Date(event.scheduledStartAt));
  return [
    "Halo teman-teman KAD! ✨",
    "",
    `${event.languageClubDisplayName ?? "Language Club"} kita buka lagi pada ${scheduleLabel} (${event.timezone}).`,
    `Yuk gabung santai, ngobrol bareng, dan latihan langsung di voice channel <#${event.hostVoiceChannelId}>.`,
    "Native Discord event-nya juga sudah aktif di server ini ✨",
    hostDiscordUserIds.length > 0 ? `Host sesi ini: ${hostDiscordUserIds.map((id) => `<@${id}>`).join(", ")}.` : null,
    "Sampai ketemu dan semoga sesi kali ini seru ya!"
  ].filter((line): line is string => line !== null).join("\n");
}
