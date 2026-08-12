import { createHash } from "node:crypto";
import type { RuntimeLeaseContext } from "../../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import { classifyLanguageEvent, normalizeTitle, publicEntryFor } from "../../publication/classifier.js";
import type { DiscordScheduledEvent } from "../../publication/types.js";
import {
  markDisappearedObservations,
  upsertObservation,
  upsertPrivateAgendaEntry,
  withdrawPrivateAgendaForSource,
  type DiscordScheduledEventObservation
} from "../repo/discord-scheduled-event-observation-repo.js";

export type DiscordObservationReconciliationOptions = {
  db: SqliteDatabase;
  guildId: string;
  events: readonly DiscordScheduledEvent[];
  context: RuntimeLeaseContext;
  /** Unknown titles are fail-closed by default; only observe mode may opt in. */
  unknownTitlePolicy?: UnknownTitlePolicy;
  observedAt?: string;
  /** Injectable trusted local clock; never derive lease validity from provider time. */
  now?: () => Date;
};

export type UnknownTitlePolicy = "reject" | "record_shadow";

export type DiscordObservationReconciliationResult = {
  observed: number;
  present: number;
  unknown: number;
  rejected: number;
  tombstoned: number;
  disappeared: number;
  pendingAgendaEntries: number;
  withdrawnAgendaEntries: number;
};

const SOURCE = "discord_rest_reconciliation";
const SOURCE_VERSION = 1;
const PROJECTION_TYPE = "language_club_agenda_entry.v1" as const;

/**
 * Reconcile a complete Discord Scheduled Event list into private SQLite state.
 * This function never writes D1 or any public table. Every mutation is fenced
 * by the supplied runtime lease and happens inside one SQLite transaction.
 */
export function reconcileDiscordScheduledEventObservations(
  options: DiscordObservationReconciliationOptions
): DiscordObservationReconciliationResult {
  const observedAt = new Date(options.observedAt ?? new Date().toISOString()).toISOString();
  const mutationNow = (options.now ?? (() => new Date()))().toISOString();
  const providerEventIds = new Set<string>();
  const unknownTitlePolicy = options.unknownTitlePolicy ?? "reject";
  const classifiedEvents = options.events.map((event) => {
    if (event.guild_id !== options.guildId) {
      throw new Error("Discord observation guild assertion failed.");
    }
    if (providerEventIds.has(event.id)) {
      throw new Error("Discord observation snapshot rejected; duplicate scheduled-event identity.");
    }
    providerEventIds.add(event.id);
    return { event, classified: normalizeObservation(event, options.guildId, observedAt, unknownTitlePolicy) };
  });
  const unsafeEvent = classifiedEvents.find(({ classified }) => classified.snapshotUnsafe);
  if (unsafeEvent) {
    throw new Error("Discord observation snapshot rejected; unknown or invalid active event.");
  }
  const result: DiscordObservationReconciliationResult = {
    observed: 0,
    present: 0,
    unknown: 0,
    rejected: 0,
    tombstoned: 0,
    disappeared: 0,
    pendingAgendaEntries: 0,
    withdrawnAgendaEntries: 0
  };
  const seenProviderEventIds = new Set<string>();

  options.db.exec("BEGIN IMMEDIATE");
  try {
    for (const { event, classified } of classifiedEvents) {
      seenProviderEventIds.add(event.id);
      const stored = upsertObservation(options.db, classified.observation, options.context, mutationNow);
      result.observed += 1;

      if (classified.observation.observationState === "tombstoned") {
        result.tombstoned += 1;
        result.withdrawnAgendaEntries += withdrawPrivateAgendaForSource(options.db, event.id, mutationNow, options.context);
        continue;
      }
      if (classified.observation.classificationState === "allowlisted" && classified.publicEntry) {
        upsertPrivateAgendaEntry(options.db, {
          id: privateAgendaId(options.guildId, event.id),
          sourceProviderEventId: event.id,
          sourceObservationId: stored.observationId,
          guildId: options.guildId,
          projectionType: PROJECTION_TYPE,
          title: classified.publicEntry.title,
          summary: classified.publicEntry.summary,
          programKey: slugify(classified.publicEntry.program),
          seriesKey: classified.publicEntry.series == null ? null : slugify(classified.publicEntry.series),
          scheduledStartAt: classified.publicEntry.startAt,
          scheduledEndAt: classified.publicEntry.endAt,
          timezone: "Asia/Jakarta",
          now: mutationNow
        }, options.context);
        result.present += 1;
        result.pendingAgendaEntries += 1;
        continue;
      }

      if (classified.observation.observationState === "present") {
        result.present += 1;
        if (classified.observation.classificationState === "unknown") result.unknown += 1;
        if (classified.observation.classificationState !== "allowlisted") {
          result.rejected += 1;
          result.withdrawnAgendaEntries += withdrawPrivateAgendaForSource(options.db, event.id, mutationNow, options.context);
        }
      } else {
        result.rejected += 1;
      }
    }

    result.disappeared = markDisappearedObservations(
      options.db,
      options.guildId,
      seenProviderEventIds,
      observedAt,
      mutationNow,
      options.context
    );
    const disappearedRows = options.db.prepare(
      `SELECT provider_event_id FROM discord_scheduled_event_observations_current
        WHERE guild_id = ? AND observation_state = 'disappeared' AND updated_at = ?`
    ).all(options.guildId, mutationNow) as Array<{ provider_event_id: string }>;
    for (const row of disappearedRows) {
      result.withdrawnAgendaEntries += withdrawPrivateAgendaForSource(options.db, row.provider_event_id, mutationNow, options.context);
    }
    options.db.exec("COMMIT");
    return result;
  } catch (error) {
    options.db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeObservation(
  event: DiscordScheduledEvent,
  guildId: string,
  observedAt: string,
  unknownTitlePolicy: UnknownTitlePolicy
): { observation: DiscordScheduledEventObservation; publicEntry: ReturnType<typeof publicEntryFor> | null; snapshotUnsafe: boolean } {
  const base = {
    providerEventId: event.id,
    guildId,
    observedAt,
    source: SOURCE,
    sourceVersion: SOURCE_VERSION,
    statusCode: event.status,
    entityType: Number.isInteger(event.entity_type) ? event.entity_type : null,
    privacyLevel: Number.isInteger(event.privacy_level) ? event.privacy_level : null,
    scheduledStartAt: null as string | null,
    scheduledEndAt: null as string | null
  };

  if (!/^\d{17,20}$/.test(event.id) || !/^\d{17,20}$/.test(guildId)) {
    return {
      publicEntry: null,
      snapshotUnsafe: true,
      observation: {
        ...base,
        observationState: "present",
        normalizedTitle: null,
        classificationState: "invalid",
        classificationCategory: null,
        programKey: null,
        seriesKey: null,
        reasonCode: "invalid_discord_identity"
      }
    };
  }

  const classification = classifyLanguageEvent(event);

  if (event.status === 3 || event.status === 4) {
    if (!classification) {
      return {
        publicEntry: null,
        snapshotUnsafe: true,
        observation: {
          ...base,
          observationState: "present",
          normalizedTitle: null,
          classificationState: "invalid",
          classificationCategory: null,
          programKey: null,
          seriesKey: null,
          reasonCode: "unknown_completed_or_cancelled_event"
        }
      };
    }
    return {
      publicEntry: null,
      snapshotUnsafe: false,
      observation: {
        ...base,
        observationState: "tombstoned",
        normalizedTitle: null,
        classificationState: "withdrawn",
        classificationCategory: null,
        programKey: null,
        seriesKey: null,
        reasonCode: event.status === 4 ? "discord_event_cancelled" : "discord_event_completed"
      }
    };
  }

  if ((event.status !== 1 && event.status !== 2) || (event.entity_type !== 2 && event.entity_type !== 3) || event.privacy_level !== 2) {
    return {
      publicEntry: null,
      snapshotUnsafe: true,
      observation: {
        ...base,
        observationState: "present",
        normalizedTitle: null,
        classificationState: "invalid",
        classificationCategory: null,
        programKey: null,
        seriesKey: null,
        reasonCode: "invalid_event_boundary"
      }
    };
  }

  if (!classification) {
    if (unknownTitlePolicy === "record_shadow") {
      const schedule = normalizeUnknownSchedule(event);
      if (schedule) {
        return {
          publicEntry: null,
          snapshotUnsafe: false,
          observation: {
            ...base,
            observationState: "present",
            normalizedTitle: null,
            classificationState: "unknown",
            classificationCategory: null,
            programKey: null,
            seriesKey: null,
            scheduledStartAt: schedule.startAt,
            scheduledEndAt: schedule.endAt,
            reasonCode: "unknown_event_title"
          }
        };
      }
      return {
        publicEntry: null,
        snapshotUnsafe: true,
        observation: {
          ...base,
          observationState: "present",
          normalizedTitle: null,
          classificationState: "invalid",
          classificationCategory: null,
          programKey: null,
          seriesKey: null,
          reasonCode: "invalid_event_schedule"
        }
      };
    }
    return {
      publicEntry: null,
      snapshotUnsafe: true,
      observation: {
        ...base,
        observationState: "present",
        normalizedTitle: null,
        classificationState: "unknown",
        classificationCategory: null,
        programKey: null,
        seriesKey: null,
        reasonCode: "unknown_event_title"
      }
    };
  }

  try {
    const publicEntry = publicEntryFor(event, privateAgendaId(guildId, event.id), classification);
    return {
      publicEntry,
      snapshotUnsafe: false,
      observation: {
        ...base,
        observationState: "present",
        normalizedTitle: normalizeTitle(event.name),
        classificationState: "allowlisted",
        classificationCategory: classification.category,
        programKey: slugify(classification.program),
        seriesKey: classification.series == null ? null : slugify(classification.series),
        scheduledStartAt: publicEntry.startAt,
        scheduledEndAt: publicEntry.endAt,
        reasonCode: "allowlisted_language_club"
      }
    };
  } catch {
    return {
      publicEntry: null,
      snapshotUnsafe: true,
      observation: {
        ...base,
        observationState: "present",
        normalizedTitle: null,
        classificationState: "invalid",
        classificationCategory: null,
        programKey: null,
        seriesKey: null,
        reasonCode: "invalid_event_schedule"
      }
    };
  }
}

function normalizeUnknownSchedule(event: DiscordScheduledEvent): { startAt: string; endAt: string | null } | null {
  const start = new Date(event.scheduled_start_time);
  if (!Number.isFinite(start.getTime())) return null;
  const startAt = start.toISOString();
  if (event.scheduled_end_time == null) return { startAt, endAt: null };
  const end = new Date(event.scheduled_end_time);
  if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) return null;
  return { startAt, endAt: end.toISOString() };
}

function privateAgendaId(guildId: string, providerEventId: string): string {
  return `agenda-${createHash("sha256").update(`${guildId}:${providerEventId}`).digest("hex").slice(0, 40)}`;
}

function slugify(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
