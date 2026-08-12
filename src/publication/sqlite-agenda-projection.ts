import { publicAgendaId } from "./ids.js";
import {
  LANGUAGE_CLUB_AGENDA_PROJECTION_TYPE,
  readApprovedPrivateAgendaRows,
  readWithdrawnPrivateAgendaRows,
  type PrivateAgendaProjectionRow
} from "./private-agenda-projection-repo.js";
import type { AgendaProjection, PublicAgendaEntry } from "./types.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";

const PUBLIC_JOIN_URL = "https://discord.gg/RUFFbEaeDx" as const;
const SOURCE = "discord_scheduled_event" as const;
const TIMEZONE = "Asia/Jakarta" as const;
/** Provider timestamps may be slightly ahead of the local clock, but not arbitrarily. */
export const MAX_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

type PublicAllowlist = {
  category: string;
  programKey: string;
  program: string;
  seriesKey: string | null;
  series: string | null;
  title: string;
  summary: string;
};

/** Exact, reviewed M0 labels. Unknown slugs are never rendered publicly. */
export const LANGUAGE_CLUB_PUBLIC_ALLOWLIST: Readonly<Record<string, PublicAllowlist>> = {
  japanese_n5: {
    category: "japanese_n5",
    programKey: "japanese-study-club",
    program: "Japanese Study Club",
    seriesKey: "n5",
    series: "N5",
    title: "Japanese Study Club — N5",
    summary: "A welcoming Japanese practice session for N5 learners."
  },
  japanese_n4: {
    category: "japanese_n4",
    programKey: "japanese-study-club",
    program: "Japanese Study Club",
    seriesKey: "n4",
    series: "N4",
    title: "Japanese Study Club — N4",
    summary: "Guided Japanese practice for N4 learners."
  },
  japanese_n3: {
    category: "japanese_n3",
    programKey: "japanese-study-club",
    program: "Japanese Study Club",
    seriesKey: "n3",
    series: "N3",
    title: "Japanese Study Club — N3",
    summary: "Guided Japanese practice for N3 learners."
  },
  japanese_advanced: {
    category: "japanese_advanced",
    programKey: "japanese-study-club",
    program: "Japanese Study Club",
    seriesKey: "advanced",
    series: "Advanced",
    title: "Japanese Study Club — advanced",
    summary: "Japanese conversation and study for advanced learners."
  },
  japanese_immersive: {
    category: "japanese_immersive",
    programKey: "japanese-study-club",
    program: "Japanese Study Club",
    seriesKey: "immersive",
    series: "Immersive",
    title: "Japanese Study Club — immersive",
    summary: "An immersive Japanese practice session for active learners."
  },
  arabic: {
    category: "arabic",
    programKey: "arabic-study-club",
    program: "Arabic Study Club",
    seriesKey: null,
    series: null,
    title: "Arabic Study Club",
    summary: "A practical Arabic practice session for learners."
  },
  french: {
    category: "french",
    programKey: "french-study-club",
    program: "French Study Club",
    seriesKey: null,
    series: null,
    title: "French Study Club",
    summary: "A practical French practice session for learners."
  },
  english: {
    category: "english",
    programKey: "english-study-club",
    program: "English Study Club",
    seriesKey: null,
    series: null,
    title: "English Study Club",
    summary: "A supportive English practice session for learners."
  },
  ielts: {
    category: "ielts",
    programKey: "english-study-club",
    program: "English Study Club",
    seriesKey: "ielts-writing",
    series: "IELTS Writing",
    title: "IELTS Writing study session",
    summary: "A practical study session for IELTS learners."
  },
  mandarin: {
    category: "mandarin",
    programKey: "mandarin-study-club",
    program: "Mandarin Study Club",
    seriesKey: null,
    series: null,
    title: "Mandarin Study Club",
    summary: "A practical Mandarin practice session for learners."
  }
};

export type SqliteAgendaProjectionOptions = {
  db: SqliteDatabase;
  publicIdKey: string;
  /** Supplied by the durable revision repository; this function never invents one. */
  revision: number;
  /** Snapshot clock supplied by the caller for deterministic/canonical output. */
  observedAt?: string;
  guildId?: string;
  /** Injectable local clock used only for bounded future-timestamp validation. */
  now?: () => Date;
};

export function buildSqliteAgendaProjection(options: SqliteAgendaProjectionOptions): AgendaProjection {
  assertRevision(options.revision);
  if (!options.publicIdKey) throw new Error("Public agenda ID key is required.");
  const rows = [
    ...readApprovedPrivateAgendaRows(options.db, { guildId: options.guildId }),
    ...readWithdrawnPrivateAgendaRows(options.db, { guildId: options.guildId })
  ];
  const observedAt = resolveObservedAt(rows, options.observedAt, options.now);
  const entries: PublicAgendaEntry[] = [];
  const tombstones = new Set<string>();

  for (const row of rows) {
    if (row.agendaState === "withdrawn") {
      if (row.approvalState === "withdrawn") {
        tombstones.add(publicAgendaId(options.publicIdKey, assertProviderId(row.sourceProviderEventId)));
      } else if (row.approvalState != null) {
        throw new Error("Withdrawn agenda entry approval state mismatch.");
      }
      continue;
    }
    entries.push(buildApprovedEntry(row, options.publicIdKey));
  }

  const orderedEntries = entries.sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id));
  const orderedTombstones = [...tombstones].sort();
  return {
    schemaVersion: "v1",
    observedAt,
    revision: options.revision,
    entries: orderedEntries,
    tombstones: orderedTombstones
  };
}

/** Explicitly named alias used by projection workers. */
export const assembleSqliteAgendaProjection = buildSqliteAgendaProjection;

function buildApprovedEntry(row: PrivateAgendaProjectionRow, publicIdKey: string): PublicAgendaEntry {
  if (row.projectionType !== LANGUAGE_CLUB_AGENDA_PROJECTION_TYPE) throw new Error("Unsupported public projection type.");
  if (row.approvalDecidedAt == null || row.approvalDecidedBy == null || row.approvalDecidedBy.trim() === "") {
    throw new Error("Approved agenda entry has incomplete publication approval.");
  }
  const decidedAt = canonicalIso(row.approvalDecidedAt, "approval decision time");
  const requestedAt = canonicalIso(row.approvalRequestedAt ?? "", "approval request time");
  const agendaUpdatedAt = canonicalIso(row.agendaUpdatedAt, "agenda update time");
  if (decidedAt < requestedAt || decidedAt < agendaUpdatedAt) throw new Error("Publication approval is stale for the private agenda entry.");

  const sourceId = assertProviderId(row.sourceProviderEventId);
  if (row.observationProviderEventId !== sourceId
    || row.observationGuildId !== row.guildId
    || row.observationId !== row.sourceObservationId
    || row.observationSource !== "discord_rest_reconciliation"
    || row.observationSourceVersion !== 1
    || row.observationState !== "present"
    || row.observationClassificationState !== "allowlisted"
    || row.observationStatusCode !== 1 && row.observationStatusCode !== 2
    || row.observationEntityType !== 2 && row.observationEntityType !== 3
    || row.observationPrivacyLevel !== 2
    || row.observationScheduledStartAt !== row.scheduledStartAt
    || row.observationScheduledEndAt !== row.scheduledEndAt
    || row.observationProgramKey !== row.programKey
    || row.observationSeriesKey !== row.seriesKey) {
    throw new Error("Approved agenda entry source observation mismatch.");
  }

  const allowlisted = row.observationClassificationCategory == null ? undefined : LANGUAGE_CLUB_PUBLIC_ALLOWLIST[row.observationClassificationCategory];
  if (!allowlisted
    || allowlisted.programKey !== row.programKey
    || allowlisted.seriesKey !== row.seriesKey) {
    throw new Error("Approved agenda entry contains an unknown public label.");
  }

  const startAt = canonicalIso(row.scheduledStartAt, "scheduled start time");
  const endAt = row.scheduledEndAt == null ? null : canonicalIso(row.scheduledEndAt, "scheduled end time");
  if (endAt != null && Date.parse(endAt) <= Date.parse(startAt)) throw new Error("Agenda end time must follow its start time.");
  if (row.timezone !== TIMEZONE) throw new Error("Agenda timezone is not public-safe.");
  assertPublicText(row.title, 200, "title");
  assertPublicText(row.summary, 1000, "summary");

  return {
    id: publicAgendaId(publicIdKey, sourceId),
    // Title and summary are approved private fields. Keep them participant-
    // facing and bounded, while program/series remain exact allowlist labels.
    title: row.title,
    summary: row.summary,
    startAt,
    endAt,
    timezone: TIMEZONE,
    status: row.observationStatusCode === 2 ? "active" : "scheduled",
    program: allowlisted.program,
    series: allowlisted.series,
    joinUrl: PUBLIC_JOIN_URL,
    source: SOURCE
  };
}

function assertProviderId(value: string): string {
  if (!/^\d{17,20}$/.test(value)) throw new Error("Agenda source identity is not a Discord ID.");
  return value;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Projection revision must be a non-negative safe integer.");
}

function canonicalIso(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`Invalid canonical ${label}.`);
  return value;
}

function maxIso(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>((latest, value) => latest == null || value > latest ? value : latest, undefined);
}

function resolveObservedAt(
  rows: readonly PrivateAgendaProjectionRow[],
  suppliedObservedAt: string | undefined,
  nowImpl: (() => Date) | undefined
): string {
  const sourceTimes = rows.map((row) => {
    if (row.observationLastObservedAt == null || row.observationLastObservedAt.trim() === "") {
      throw new Error("Projection source observation timestamp is missing.");
    }
    const sourceTime = canonicalIso(row.observationLastObservedAt, "source observation time");
    assertNotTooFarInFuture(sourceTime, nowImpl);
    return sourceTime;
  });
  const derived = maxIso(sourceTimes);
  const fallback = "1970-01-01T00:00:00.000Z";
  if (derived == null) {
    const emptySnapshot = canonicalIso(suppliedObservedAt ?? fallback, "observedAt");
    assertNotTooFarInFuture(emptySnapshot, nowImpl);
    return emptySnapshot;
  }
  const supplied = suppliedObservedAt == null ? undefined : canonicalIso(suppliedObservedAt, "observedAt");
  if (supplied != null && supplied !== derived) {
    throw new Error("Supplied observedAt does not match the newest source observation timestamp.");
  }
  return supplied ?? derived;
}

function assertNotTooFarInFuture(value: string, nowImpl: (() => Date) | undefined): void {
  const now = nowImpl?.() ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Projection local clock is invalid.");
  if (Date.parse(value) > nowMs + MAX_SOURCE_FUTURE_SKEW_MS) {
    throw new Error("Projection source timestamp is too far in the future.");
  }
}

function assertPublicText(value: string, maximumLength: number, label: string): void {
  const pattern = new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{N} .,'’—–!?()/:+-]{1,${maximumLength - 1}}$`, "u");
  if (!pattern.test(value) || /\b\d{17,20}\b|(?:agenda|observation|approval)-[A-Za-z0-9_-]+/i.test(value)) {
    throw new Error(`Agenda ${label} is not public-safe.`);
  }
}
