import { createHash } from "node:crypto";
import type { RuntimeLeaseContext } from "../../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";

export type ObservationState = "present" | "disappeared" | "tombstoned";
export type ClassificationState = "allowlisted" | "unknown" | "invalid" | "withdrawn";

export type DiscordScheduledEventObservation = {
  providerEventId: string;
  guildId: string;
  observedAt: string;
  source: string;
  sourceVersion: number;
  observationState: ObservationState;
  statusCode: number;
  entityType: number | null;
  privacyLevel: number | null;
  normalizedTitle: string | null;
  classificationState: ClassificationState;
  classificationCategory: string | null;
  programKey: string | null;
  seriesKey: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  reasonCode: string;
};

export type StoredDiscordScheduledEventObservation = DiscordScheduledEventObservation & {
  id: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observationId: string;
  updatedAt: string;
};

export type PrivateAgendaEntryInput = {
  id: string;
  sourceProviderEventId: string;
  sourceObservationId: string;
  guildId: string;
  projectionType: "language_club_agenda_entry.v1";
  title: string;
  summary: string;
  programKey: string;
  seriesKey: string | null;
  scheduledStartAt: string;
  scheduledEndAt: string | null;
  timezone: "Asia/Jakarta";
  now: string;
};

export function upsertObservation(
  db: SqliteDatabase,
  observation: DiscordScheduledEventObservation,
  context: RuntimeLeaseContext,
  mutationNow: string
): { observationId: string; inserted: boolean } {
  assertActiveLease(db, context, mutationNow);
  const existing = db.prepare(
    `SELECT observation_id, first_observed_at, source, source_version, observation_state, status_code,
            entity_type, privacy_level, normalized_title, classification_state,
            classification_category, program_key, series_key, scheduled_start_at,
            scheduled_end_at, reason_code
       FROM discord_scheduled_event_observations_current
      WHERE provider_event_id = ?`
  ).get(observation.providerEventId) as CurrentObservationRow | undefined;
  const unchanged = existing != null && sameObservationState(existing, observation);
  const fingerprint = unchanged ? null : observationFingerprint(observation, existing);
  const observationId = unchanged ? existing.observation_id : `observation-${fingerprint}`;
  let inserted = false;
  if (!unchanged && fingerprint) {
    const insertResult = db.prepare(
      `INSERT INTO discord_scheduled_event_observation_history (
         id, provider_event_id, guild_id, observed_at, source, source_version,
         observation_state, status_code, entity_type, privacy_level,
         normalized_title, classification_state, classification_category,
         program_key, series_key, scheduled_start_at, scheduled_end_at,
         reason_code, observation_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      observationId,
      observation.providerEventId,
      observation.guildId,
      observation.observedAt,
      observation.source,
      observation.sourceVersion,
      observation.observationState,
      observation.statusCode,
      observation.entityType,
      observation.privacyLevel,
      observation.normalizedTitle,
      observation.classificationState,
      observation.classificationCategory,
      observation.programKey,
      observation.seriesKey,
      observation.scheduledStartAt,
      observation.scheduledEndAt,
      observation.reasonCode,
      fingerprint,
      mutationNow
    ) as { changes?: number };
    inserted = Number(insertResult.changes ?? 0) === 1;
  }
  const firstObservedAt = existing?.first_observed_at ?? observation.observedAt;
  const currentResult = db.prepare(
    `INSERT INTO discord_scheduled_event_observations_current (
       provider_event_id, guild_id, observation_id, first_observed_at,
       last_observed_at, source, source_version, observation_state, status_code,
       entity_type, privacy_level, normalized_title, classification_state,
       classification_category, program_key, series_key, scheduled_start_at,
       scheduled_end_at, reason_code, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider_event_id) DO UPDATE SET
       guild_id = excluded.guild_id,
       observation_id = excluded.observation_id,
       last_observed_at = excluded.last_observed_at,
       source = excluded.source,
       source_version = excluded.source_version,
       observation_state = excluded.observation_state,
       status_code = excluded.status_code,
       entity_type = excluded.entity_type,
       privacy_level = excluded.privacy_level,
       normalized_title = excluded.normalized_title,
       classification_state = excluded.classification_state,
       classification_category = excluded.classification_category,
       program_key = excluded.program_key,
       series_key = excluded.series_key,
       scheduled_start_at = excluded.scheduled_start_at,
       scheduled_end_at = excluded.scheduled_end_at,
       reason_code = excluded.reason_code,
       updated_at = excluded.updated_at`
  ).run(
    observation.providerEventId,
    observation.guildId,
    observationId,
    firstObservedAt,
    observation.observedAt,
    observation.source,
    observation.sourceVersion,
    observation.observationState,
    observation.statusCode,
    observation.entityType,
    observation.privacyLevel,
    observation.normalizedTitle,
    observation.classificationState,
    observation.classificationCategory,
    observation.programKey,
    observation.seriesKey,
    observation.scheduledStartAt,
    observation.scheduledEndAt,
    observation.reasonCode,
    mutationNow
  ) as { changes?: number };
  if (Number(currentResult.changes ?? 0) !== 1) {
    throw new Error("Discord observation current-state write was not applied.");
  }
  return { observationId, inserted };
}

export function listCurrentObservations(db: SqliteDatabase, guildId: string): StoredDiscordScheduledEventObservation[] {
  const rows = db.prepare(
    `SELECT provider_event_id, guild_id, observation_id, first_observed_at,
            last_observed_at, source, source_version, observation_state,
            status_code, entity_type, privacy_level, normalized_title,
            classification_state, classification_category, program_key,
            series_key, scheduled_start_at, scheduled_end_at, reason_code,
            updated_at
       FROM discord_scheduled_event_observations_current
      WHERE guild_id = ?
      ORDER BY provider_event_id ASC`
  ).all(guildId) as ObservationRow[];
  return rows.map(mapCurrentRow);
}

export function markDisappearedObservations(
  db: SqliteDatabase,
  guildId: string,
  seenProviderEventIds: ReadonlySet<string>,
  observedAt: string,
  mutationNow: string,
  context: RuntimeLeaseContext
): number {
  assertActiveLease(db, context, mutationNow);
  const candidates = db.prepare(
    `SELECT provider_event_id, status_code, entity_type, privacy_level,
            normalized_title, classification_category, program_key, series_key,
            scheduled_start_at, scheduled_end_at
       FROM discord_scheduled_event_observations_current
      WHERE guild_id = ? AND observation_state = 'present'`
  ).all(guildId) as Array<{
    provider_event_id: string;
    status_code: number;
    entity_type: number | null;
    privacy_level: number | null;
    normalized_title: string | null;
    classification_category: string | null;
    program_key: string | null;
    series_key: string | null;
    scheduled_start_at: string | null;
    scheduled_end_at: string | null;
  }>;
  let count = 0;
  for (const candidate of candidates) {
    if (seenProviderEventIds.has(candidate.provider_event_id)) continue;
    upsertObservation(db, {
      providerEventId: candidate.provider_event_id,
      guildId,
      observedAt,
      source: "discord_rest_reconciliation",
      sourceVersion: 1,
      observationState: "disappeared",
      statusCode: candidate.status_code,
      entityType: candidate.entity_type,
      privacyLevel: candidate.privacy_level,
      normalizedTitle: candidate.normalized_title,
      classificationState: "withdrawn",
      classificationCategory: candidate.classification_category,
      programKey: candidate.program_key,
      seriesKey: candidate.series_key,
      scheduledStartAt: candidate.scheduled_start_at,
      scheduledEndAt: candidate.scheduled_end_at,
      reasonCode: "not_returned_by_reconciliation"
    }, context, mutationNow);
    count += 1;
  }
  return count;
}

export function upsertPrivateAgendaEntry(db: SqliteDatabase, input: PrivateAgendaEntryInput, context: RuntimeLeaseContext): void {
  assertActiveLease(db, context, input.now);
  db.prepare(
    `INSERT INTO private_agenda_entries (
       id, source_provider_event_id, source_observation_id, guild_id,
       projection_type, title, summary, program_key, series_key,
       scheduled_start_at, scheduled_end_at, timezone, agenda_state,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (source_provider_event_id, projection_type) DO UPDATE SET
       source_observation_id = excluded.source_observation_id,
       title = excluded.title,
       summary = excluded.summary,
       program_key = excluded.program_key,
       series_key = excluded.series_key,
       scheduled_start_at = excluded.scheduled_start_at,
       scheduled_end_at = excluded.scheduled_end_at,
       timezone = excluded.timezone,
       agenda_state = CASE
         WHEN private_agenda_entries.agenda_state = 'approved'
          AND private_agenda_entries.title = excluded.title
          AND private_agenda_entries.summary = excluded.summary
          AND private_agenda_entries.program_key = excluded.program_key
          AND COALESCE(private_agenda_entries.series_key, '') = COALESCE(excluded.series_key, '')
          AND private_agenda_entries.scheduled_start_at = excluded.scheduled_start_at
          AND COALESCE(private_agenda_entries.scheduled_end_at, '') = COALESCE(excluded.scheduled_end_at, '')
          AND private_agenda_entries.timezone = excluded.timezone
         THEN 'approved'
         ELSE 'pending'
       END,
       updated_at = excluded.updated_at`
  ).run(
    input.id,
    input.sourceProviderEventId,
    input.sourceObservationId,
    input.guildId,
    input.projectionType,
    input.title,
    input.summary,
    input.programKey,
    input.seriesKey,
    input.scheduledStartAt,
    input.scheduledEndAt,
    input.timezone,
    input.now,
    input.now
  );
  db.prepare(
    `INSERT INTO publication_approvals (
       id, agenda_entry_id, projection_type, state, requested_at
     ) VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT (agenda_entry_id, projection_type) DO UPDATE SET
       state = CASE
         WHEN publication_approvals.state = 'approved'
          AND (SELECT agenda_state FROM private_agenda_entries WHERE id = excluded.agenda_entry_id) = 'approved'
         THEN 'approved'
         ELSE 'pending'
       END,
       requested_at = CASE
         WHEN publication_approvals.state = 'approved'
          AND (SELECT agenda_state FROM private_agenda_entries WHERE id = excluded.agenda_entry_id) = 'approved'
         THEN publication_approvals.requested_at
         ELSE excluded.requested_at
       END,
       decided_at = CASE
         WHEN publication_approvals.state = 'approved'
          AND (SELECT agenda_state FROM private_agenda_entries WHERE id = excluded.agenda_entry_id) = 'approved'
         THEN publication_approvals.decided_at
         ELSE NULL
       END,
       decided_by = CASE
         WHEN publication_approvals.state = 'approved'
          AND (SELECT agenda_state FROM private_agenda_entries WHERE id = excluded.agenda_entry_id) = 'approved'
         THEN publication_approvals.decided_by
         ELSE NULL
       END,
       decision_reason = CASE
         WHEN publication_approvals.state = 'approved'
          AND (SELECT agenda_state FROM private_agenda_entries WHERE id = excluded.agenda_entry_id) = 'approved'
         THEN publication_approvals.decision_reason
         ELSE NULL
       END`
  ).run(`approval-${input.id}`, input.id, input.projectionType, input.now);
}

export function withdrawPrivateAgendaForSource(
  db: SqliteDatabase,
  sourceProviderEventId: string,
  now: string,
  context: RuntimeLeaseContext
): number {
  assertActiveLease(db, context, now);
  const result = db.prepare(
    `UPDATE private_agenda_entries
        SET agenda_state = 'withdrawn', updated_at = ?
      WHERE source_provider_event_id = ? AND agenda_state <> 'withdrawn'`
  ).run(now, sourceProviderEventId) as { changes?: number };
  db.prepare(
    `UPDATE publication_approvals
        SET state = 'withdrawn', decided_at = ?, decided_by = NULL, decision_reason = 'source_withdrawn'
      WHERE agenda_entry_id IN (SELECT id FROM private_agenda_entries WHERE source_provider_event_id = ?)
        AND state <> 'withdrawn'`
  ).run(now, sourceProviderEventId);
  return Number(result.changes ?? 0);
}

function assertActiveLease(db: SqliteDatabase, context: RuntimeLeaseContext, now: string): void {
  const row = db.prepare(
    `SELECT 1 AS active
       FROM runtime_leases
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`
  ).get(context.runtimeLeaseName, context.runtimeOwnerId, context.runtimeFencingToken, now) as { active?: number } | undefined;
  if (row?.active !== 1) throw new Error("Runtime lease is not active for Discord observation mutation.");
}

function observationFingerprint(observation: DiscordScheduledEventObservation, previous?: CurrentObservationRow): string {
  const canonical = JSON.stringify({
    previousObservationId: previous?.observation_id ?? null,
    previousObservationState: previous?.observation_state ?? null,
    providerEventId: observation.providerEventId,
    guildId: observation.guildId,
    source: observation.source,
    sourceVersion: observation.sourceVersion,
    observationState: observation.observationState,
    statusCode: observation.statusCode,
    entityType: observation.entityType,
    privacyLevel: observation.privacyLevel,
    normalizedTitle: observation.normalizedTitle,
    classificationState: observation.classificationState,
    classificationCategory: observation.classificationCategory,
    programKey: observation.programKey,
    seriesKey: observation.seriesKey,
    scheduledStartAt: observation.scheduledStartAt,
    scheduledEndAt: observation.scheduledEndAt,
    reasonCode: observation.reasonCode
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sameObservationState(existing: CurrentObservationRow, observation: DiscordScheduledEventObservation): boolean {
  return existing.observation_state === observation.observationState
    && existing.status_code === observation.statusCode
    && existing.entity_type === observation.entityType
    && existing.privacy_level === observation.privacyLevel
    && existing.normalized_title === observation.normalizedTitle
    && existing.classification_state === observation.classificationState
    && existing.classification_category === observation.classificationCategory
    && existing.program_key === observation.programKey
    && existing.series_key === observation.seriesKey
    && existing.scheduled_start_at === observation.scheduledStartAt
    && existing.scheduled_end_at === observation.scheduledEndAt
    && existing.reason_code === observation.reasonCode
    && existing.source === observation.source
    && existing.source_version === observation.sourceVersion;
}

type ObservationRow = {
  provider_event_id: string;
  guild_id: string;
  observation_id: string;
  first_observed_at: string;
  last_observed_at: string;
  source: string;
  source_version: number;
  observation_state: ObservationState;
  status_code: number;
  entity_type: number | null;
  privacy_level: number | null;
  normalized_title: string | null;
  classification_state: ClassificationState;
  classification_category: string | null;
  program_key: string | null;
  series_key: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  reason_code: string;
  updated_at: string;
};

type CurrentObservationRow = Pick<ObservationRow,
  "observation_id" | "first_observed_at" | "observation_state" | "status_code" |
  "entity_type" | "privacy_level" | "normalized_title" | "classification_state" |
  "classification_category" | "program_key" | "series_key" | "scheduled_start_at" |
  "scheduled_end_at" | "reason_code" | "source" | "source_version"
>;

function mapCurrentRow(row: ObservationRow): StoredDiscordScheduledEventObservation {
  return {
    id: row.observation_id,
    providerEventId: row.provider_event_id,
    guildId: row.guild_id,
    observedAt: row.last_observed_at,
    observationId: row.observation_id,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    source: row.source,
    sourceVersion: row.source_version,
    observationState: row.observation_state,
    statusCode: row.status_code,
    entityType: row.entity_type,
    privacyLevel: row.privacy_level,
    normalizedTitle: row.normalized_title,
    classificationState: row.classification_state,
    classificationCategory: row.classification_category,
    programKey: row.program_key,
    seriesKey: row.series_key,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    reasonCode: row.reason_code,
    updatedAt: row.updated_at
  };
}
