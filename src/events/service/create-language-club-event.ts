import { createUuidV7 } from "../../app/lib/uuidv7.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import { getLanguageClubGuildConfigByGuildId } from "../repo/language-club-guild-config-repo.js";
import { getLanguageClubByKey } from "../repo/language-club-registry-repo.js";
import { insertReminderJob } from "../repo/event-reminder-repo.js";
import {
  createDraftedLanguageClubEvent,
  findLanguageClubEventByClubSchedule,
  findLanguageClubEventBySchedule,
  findSupportedLanguageClubTemplate,
  getLanguageClubEventById,
  markLanguageClubEventPublishFailed,
  markLanguageClubEventPublished,
  storeLanguageClubEventDiscordScheduledEventId
} from "../repo/language-club-event-repo.js";
import { buildReminderJobRecord } from "./reminder-job-factory.js";

const SUPPORTED_TEMPLATE_KEY = "language_club_default";
const SUPPORTED_TEMPLATE_VERSION = 1;
const SUPPORTED_EVENT_TYPE = "language_club";
const SUPPORTED_APPROVAL_CLASS = "routine_auto_publish";
const SUPPORTED_CLASSIFICATION = "routine_language_club";
const SCHEDULING_SCOPE_KEY_PREFIX = "language_club_channel:";

export type CreateLanguageClubEventInput = {
  guildId: string | null;
  actorDiscordUserId: string;
  actorRoleIds: string[];
  sourceInteractionId: string;
  clubKey: string;
  date: string;
  time: string;
  hostVoiceChannelId?: string | null;
  hostDiscordUserIds?: string[];
};

export type LanguageClubDiscordPublisher = {
  createScheduledEvent: (input: {
    guildId: string;
    channelId: string;
    title: string;
    description: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
  }) => Promise<{ scheduledEventId: string }>;
  publishAnnouncement: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
};

export type CreateLanguageClubEventResult =
  | {
      status: "hard_rejected";
      reason: string;
    }
  | {
      status: "published";
      eventId: string;
      scheduledStartAt: string;
      discordScheduledEventId: string;
      messageId: string;
    }
  | {
      status: "publish_failed";
      eventId: string;
      scheduledStartAt: string;
      reason: string;
      discordScheduledEventId: string | null;
    };

type CreateLanguageClubEventDeps = {
  db: SqliteDatabase;
  publisher: LanguageClubDiscordPublisher;
  now?: Date;
};

export async function createLanguageClubEvent(
  input: CreateLanguageClubEventInput,
  deps: CreateLanguageClubEventDeps
): Promise<CreateLanguageClubEventResult> {
  if (!input.guildId) {
    return hardRejected("Perintah ini hanya bisa dipakai di dalam server Discord.");
  }

  const publishConfig = getLanguageClubGuildConfigByGuildId(deps.db, input.guildId);

  if (!publishConfig) {
    return hardRejected("Guild ini belum dikonfigurasi untuk Event Slice E1. Jalankan /setup e1-configure terlebih dahulu.");
  }

  if (!isAuthorizedStaffActor(input.actorRoleIds, publishConfig.staffRoleIds)) {
    return hardRejected("Kamu tidak punya izin untuk membuat event Language Club.");
  }

  const template = findSupportedLanguageClubTemplate(deps.db);

  if (!template) {
    return hardRejected("Template seeded language_club_default@v1 belum tersedia di SQLite.");
  }

  const normalizedClubKey = normalizeClubKey(input.clubKey);
  const languageClub = getLanguageClubByKey(deps.db, publishConfig.guildId, normalizedClubKey);

  if (!languageClub || !languageClub.isActive) {
    return hardRejected("club_key belum dikonfigurasi aktif. Jalankan /setup language-club-upsert terlebih dahulu.");
  }

  if (
    template.templateKey !== SUPPORTED_TEMPLATE_KEY ||
    template.templateVersion !== SUPPORTED_TEMPLATE_VERSION ||
    template.eventType !== SUPPORTED_EVENT_TYPE ||
    template.approvalClass !== SUPPORTED_APPROVAL_CLASS ||
    template.classification !== SUPPORTED_CLASSIFICATION
  ) {
    return hardRejected("Template seeded Language Club tidak cocok dengan policy rutin auto-publish yang didukung.");
  }

  const schedule = parseConfiguredSchedule(input.date, input.time, publishConfig.defaultTimezone);

  if (!schedule.ok) {
    return hardRejected(schedule.reason);
  }

  const resolvedHostVoiceChannelId =
    normalizeOptionalDiscordId(input.hostVoiceChannelId) ??
    languageClub.defaultHostVoiceChannelId ??
    publishConfig.hostVoiceChannelId;

  if (!resolvedHostVoiceChannelId) {
    return hardRejected("Guild ini belum punya host voice channel default yang valid untuk Language Club.");
  }

  const normalizedHostDiscordUserIds = dedupeDiscordIds(input.hostDiscordUserIds ?? []);
  const schedulingScopeKey = buildSchedulingScopeKey(resolvedHostVoiceChannelId);

  const scheduledEndAt = new Date(
    new Date(schedule.scheduledStartAt).getTime() + template.defaultDurationMinutes * 60 * 1000
  ).toISOString();
  const duplicateEvent = findLanguageClubEventBySchedule(
    deps.db,
    publishConfig.guildId,
    schedule.scheduledStartAt,
    schedulingScopeKey
  );

  if (duplicateEvent) {
    return hardRejected("Sudah ada event Language Club untuk host channel dan jadwal mulai yang sama.");
  }

  const duplicateClubEvent = findLanguageClubEventByClubSchedule(
    deps.db,
    publishConfig.guildId,
    languageClub.id,
    schedule.scheduledStartAt
  );

  if (duplicateClubEvent) {
    return hardRejected("Sudah ada event Language Club untuk club_key dan jadwal mulai yang sama.");
  }

  const baseNow = deps.now ?? new Date();
  const draftedAt = baseNow.toISOString();
  const eventId = createUuidV7(baseNow);
  const title = renderTemplate(template.titleTemplate, schedule.labels);
  const description = renderTemplate(template.descriptionTemplate, schedule.labels);

  try {
    createDraftedLanguageClubEvent(
      deps.db,
      {
        id: eventId,
        guildId: publishConfig.guildId,
        announcementChannelId: publishConfig.announcementChannelId,
        hostVoiceChannelId: resolvedHostVoiceChannelId,
        languageClubId: languageClub.id,
        languageClubKey: languageClub.clubKey,
        languageClubDisplayName: languageClub.displayName,
        templateId: template.id,
        templateKey: template.templateKey,
        templateVersion: template.templateVersion,
        eventType: template.eventType,
        approvalClass: template.approvalClass,
        classification: template.classification,
        schedulingScopeKey,
        state: "drafted",
        title,
        description,
        timezone: publishConfig.defaultTimezone,
        scheduledStartAt: schedule.scheduledStartAt,
        scheduledEndAt,
        createdByDiscordUserId: input.actorDiscordUserId,
        sourceInteractionId: input.sourceInteractionId,
        draftedAt,
        publishedAt: null,
        publishFailedAt: null,
        publishError: null,
        discordAnnouncementMessageId: null,
        discordScheduledEventId: null,
        googleCalendarEventId: null
      },
      {
        id: createUuidV7(new Date(baseNow.getTime() + 1)),
        eventId,
        fromState: null,
        toState: "drafted",
        actorDiscordUserId: input.actorDiscordUserId,
        occurredAt: draftedAt,
        reason: "language_club_seeded_create"
      },
      normalizedHostDiscordUserIds.map((discordUserId, index) => ({
        id: createUuidV7(new Date(baseNow.getTime() + 10 + index)),
        eventId,
        discordUserId,
        displayOrder: index + 1,
        assignedByDiscordUserId: input.actorDiscordUserId,
        assignedAt: draftedAt
      }))
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return hardRejected("Sudah ada event Language Club untuk club/channel dan jadwal mulai yang sama.");
    }

    throw error;
  }

  const draftedEvent = getLanguageClubEventById(deps.db, eventId);

  if (!draftedEvent) {
    throw new Error("Event draft Language Club baru saja tersimpan tetapi tidak bisa dibaca kembali dari SQLite.");
  }

  if (!draftedEvent.hostVoiceChannelId) {
    throw new Error("Event draft Language Club belum punya host voice channel yang valid.");
  }

  if (draftedEvent.discordScheduledEventId) {
    throw new Error("Event draft Language Club ini sudah punya Discord Scheduled Event ID.");
  }

  let discordScheduledEventId: string | null = null;

  try {
    const scheduledEventResult = await deps.publisher.createScheduledEvent({
      guildId: draftedEvent.guildId,
      channelId: draftedEvent.hostVoiceChannelId,
      title: draftedEvent.title,
      description: draftedEvent.description,
      scheduledStartAt: draftedEvent.scheduledStartAt,
      scheduledEndAt: draftedEvent.scheduledEndAt
    });

    discordScheduledEventId = scheduledEventResult.scheduledEventId;

    if (!discordScheduledEventId) {
      throw new Error("Discord Scheduled Event berhasil dibuat tetapi tidak mengembalikan ID event.");
    }

    storeLanguageClubEventDiscordScheduledEventId(
      deps.db,
      eventId,
      discordScheduledEventId,
      new Date(baseNow.getTime() + 2).toISOString()
    );

    const publishResult = await deps.publisher.publishAnnouncement({
      channelId: draftedEvent.announcementChannelId,
      content: buildAnnouncementMessage({
        languageClubDisplayName: draftedEvent.languageClubDisplayName ?? languageClub.displayName,
        scheduledStartAt: draftedEvent.scheduledStartAt,
        timeZone: draftedEvent.timezone,
        hostVoiceChannelId: draftedEvent.hostVoiceChannelId,
        hostDiscordUserIds: normalizedHostDiscordUserIds
      })
    });
    const publishedAtDate = new Date(baseNow.getTime() + 3);
    const publishedAt = publishedAtDate.toISOString();

    markLanguageClubEventPublished(deps.db, eventId, publishedAt, publishResult.messageId, {
      id: createUuidV7(publishedAtDate),
      eventId,
      fromState: "drafted",
      toState: "published",
      actorDiscordUserId: input.actorDiscordUserId,
      occurredAt: publishedAt,
      reason: "language_club_seeded_publish_success"
    });

    try {
      createFutureReminderRows(deps.db, {
        eventId,
        announcementChannelId: draftedEvent.announcementChannelId,
        languageClubDisplayName: draftedEvent.languageClubDisplayName ?? languageClub.displayName,
        scheduledStartAt: draftedEvent.scheduledStartAt,
        hostVoiceChannelId: draftedEvent.hostVoiceChannelId,
        now: publishedAtDate
      });
    } catch (reminderSchedulingError) {
      console.error("Language Club event published but reminder scheduling failed", reminderSchedulingError);
    }

    return {
      status: "published",
      eventId,
      scheduledStartAt: draftedEvent.scheduledStartAt,
      discordScheduledEventId,
      messageId: publishResult.messageId
    };
  } catch (error) {
    const failureReason = formatErrorMessage(error);
    const failedAtDate = new Date(baseNow.getTime() + 3);
    const failedAt = failedAtDate.toISOString();

    markLanguageClubEventPublishFailed(deps.db, eventId, failedAt, failureReason, {
      id: createUuidV7(failedAtDate),
      eventId,
      fromState: "drafted",
      toState: "publish_failed",
      actorDiscordUserId: input.actorDiscordUserId,
      occurredAt: failedAt,
      reason: failureReason
    });

    return {
      status: "publish_failed",
      eventId,
      scheduledStartAt: draftedEvent.scheduledStartAt,
      reason: failureReason,
      discordScheduledEventId
    };
  }
}

function hardRejected(reason: string): CreateLanguageClubEventResult {
  return {
    status: "hard_rejected",
    reason
  };
}

function normalizeClubKey(clubKey: string): string {
  return clubKey.trim().toLowerCase();
}

function isAuthorizedStaffActor(actorRoleIds: string[], allowedRoleIds: string[]): boolean {
  return actorRoleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

function renderTemplate(template: string, labels: Record<string, string>): string {
  return template.replace(/\{(day_name|date_label|time_label|timezone_label)\}/g, (fullMatch, token: keyof typeof labels) => {
    return labels[token] ?? fullMatch;
  });
}

function buildAnnouncementMessage(input: {
  languageClubDisplayName: string;
  scheduledStartAt: string;
  timeZone: string;
  hostVoiceChannelId: string;
  hostDiscordUserIds: string[];
}): string {
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone: input.timeZone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const scheduleLabel = formatter.format(new Date(input.scheduledStartAt));

  return [
    "Halo teman-teman KAD! ✨",
    "",
    `${input.languageClubDisplayName} kita buka lagi pada ${scheduleLabel} (${input.timeZone}).`,
    `Yuk gabung santai, ngobrol bareng, dan latihan langsung di voice channel <#${input.hostVoiceChannelId}>.`,
    "Native Discord event-nya juga sudah aktif di server ini ✨",
    input.hostDiscordUserIds.length > 0 ? `Host sesi ini: ${input.hostDiscordUserIds.map((userId) => `<@${userId}>`).join(", ")}.` : null,
    "Sampai ketemu dan semoga sesi kali ini seru ya!"
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function createFutureReminderRows(
  db: SqliteDatabase,
  input: {
    eventId: string;
    announcementChannelId: string;
    languageClubDisplayName: string;
    scheduledStartAt: string;
    hostVoiceChannelId: string;
    now: Date;
  }
): void {
  const scheduledStartMs = new Date(input.scheduledStartAt).getTime();
  const reminderSpecs = [
    { reminderType: "t_minus_24h" as const, offsetMs: 24 * 60 * 60 * 1000 },
    { reminderType: "t_minus_1h" as const, offsetMs: 60 * 60 * 1000 }
  ];

  for (const spec of reminderSpecs) {
    const sendAt = new Date(scheduledStartMs - spec.offsetMs);

    if (sendAt.getTime() <= input.now.getTime()) {
      continue;
    }

    insertReminderJob(
      db,
      buildReminderJobRecord({
        eventId: input.eventId,
        reminderType: spec.reminderType,
        audienceKind: "attendee",
        scheduledFor: sendAt.toISOString(),
        payload: {
          targetChannelId: input.announcementChannelId,
          languageClubDisplayName: input.languageClubDisplayName,
          scheduledStartAt: input.scheduledStartAt,
          hostVoiceChannelId: input.hostVoiceChannelId
        },
        now: input.now
      })
    );
  }
}

function buildSchedulingScopeKey(hostVoiceChannelId: string): string {
  return `${SCHEDULING_SCOPE_KEY_PREFIX}${hostVoiceChannelId}`;
}

function dedupeDiscordIds(discordIds: string[]): string[] {
  const dedupedIds: string[] = [];
  const seen = new Set<string>();

  for (const discordId of discordIds) {
    const normalizedDiscordId = normalizeOptionalDiscordId(discordId);

    if (!normalizedDiscordId || seen.has(normalizedDiscordId)) {
      continue;
    }

    seen.add(normalizedDiscordId);
    dedupedIds.push(normalizedDiscordId);
  }

  return dedupedIds;
}

function normalizeOptionalDiscordId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue === "" ? null : trimmedValue;
}

type ParsedScheduleResult =
  | {
      ok: true;
      scheduledStartAt: string;
      labels: Record<"day_name" | "date_label" | "time_label" | "timezone_label", string>;
    }
  | {
      ok: false;
      reason: string;
    };

function parseConfiguredSchedule(date: string, time: string, timeZone: string): ParsedScheduleResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return {
      ok: false,
      reason: "Format jadwal tidak valid. Gunakan date YYYY-MM-DD dan time HH:mm."
    };
  }

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return {
      ok: false,
      reason: "Format jadwal tidak valid. Gunakan date YYYY-MM-DD dan time HH:mm."
    };
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = getTimeZoneOffsetMilliseconds(new Date(utcGuess), timeZone);
  let scheduledStartDate = new Date(utcGuess - firstOffset);
  const secondOffset = getTimeZoneOffsetMilliseconds(scheduledStartDate, timeZone);

  if (secondOffset !== firstOffset) {
    scheduledStartDate = new Date(utcGuess - secondOffset);
  }

  const zonedParts = getTimeZoneParts(scheduledStartDate, timeZone);

  if (
    zonedParts.year !== String(year).padStart(4, "0") ||
    zonedParts.month !== String(month).padStart(2, "0") ||
    zonedParts.day !== String(day).padStart(2, "0") ||
    zonedParts.hour !== String(hour).padStart(2, "0") ||
    zonedParts.minute !== String(minute).padStart(2, "0")
  ) {
    return {
      ok: false,
      reason: `Jadwal tidak valid untuk timezone ${timeZone}.`
    };
  }

  return {
    ok: true,
    scheduledStartAt: scheduledStartDate.toISOString(),
    labels: {
      day_name: new Intl.DateTimeFormat("id-ID", { timeZone, weekday: "long" }).format(scheduledStartDate),
      date_label: new Intl.DateTimeFormat("id-ID", {
        timeZone,
        day: "2-digit",
        month: "long",
        year: "numeric"
      }).format(scheduledStartDate),
      time_label: new Intl.DateTimeFormat("id-ID", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(scheduledStartDate),
      timezone_label: timeZone
    }
  };
}

function getTimeZoneOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = getTimeZoneParts(date, timeZone);

  const utcFromParts = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    0
  );

  return utcFromParts - date.getTime();
}

function getTimeZoneParts(date: Date, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return {
    year: String(byType.year),
    month: String(byType.month),
    day: String(byType.day),
    hour: String(byType.hour),
    minute: String(byType.minute),
    second: String(byType.second)
  };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown publish error";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
