import type { SqliteDatabase } from "../app/repo/sqlite.js";

export const LANGUAGE_CLUB_AGENDA_PROJECTION_TYPE = "language_club_agenda_entry.v1" as const;

/** The read-only row shape used at the private/public publication boundary. */
export type PrivateAgendaProjectionRow = {
  agendaEntryId: string;
  sourceProviderEventId: string;
  sourceObservationId: string;
  guildId: string;
  projectionType: string;
  title: string;
  summary: string;
  programKey: string;
  seriesKey: string | null;
  scheduledStartAt: string;
  scheduledEndAt: string | null;
  timezone: string;
  agendaState: "pending" | "approved" | "withdrawn";
  agendaCreatedAt: string;
  agendaUpdatedAt: string;
  approvalState: "pending" | "approved" | "rejected" | "withdrawn" | null;
  approvalRequestedAt: string | null;
  approvalDecidedAt: string | null;
  approvalDecidedBy: string | null;
  observationProviderEventId: string | null;
  observationGuildId: string | null;
  observationId: string | null;
  observationLastObservedAt: string | null;
  observationSource: string | null;
  observationSourceVersion: number | null;
  observationState: "present" | "disappeared" | "tombstoned" | null;
  observationStatusCode: number | null;
  observationEntityType: number | null;
  observationPrivacyLevel: number | null;
  observationClassificationState: "allowlisted" | "unknown" | "invalid" | "withdrawn" | null;
  observationClassificationCategory: string | null;
  observationProgramKey: string | null;
  observationSeriesKey: string | null;
  observationScheduledStartAt: string | null;
  observationScheduledEndAt: string | null;
  observationUpdatedAt: string | null;
};

type PrivateAgendaProjectionSqlRow = {
  agenda_entry_id: string;
  source_provider_event_id: string;
  source_observation_id: string;
  guild_id: string;
  projection_type: string;
  title: string;
  summary: string;
  program_key: string;
  series_key: string | null;
  scheduled_start_at: string;
  scheduled_end_at: string | null;
  timezone: string;
  agenda_state: PrivateAgendaProjectionRow["agendaState"];
  agenda_created_at: string;
  agenda_updated_at: string;
  approval_state: PrivateAgendaProjectionRow["approvalState"];
  approval_requested_at: string | null;
  approval_decided_at: string | null;
  approval_decided_by: string | null;
  observation_provider_event_id: string | null;
  observation_guild_id: string | null;
  observation_id: string | null;
  observation_last_observed_at: string | null;
  observation_source: string | null;
  observation_source_version: number | null;
  observation_state: PrivateAgendaProjectionRow["observationState"];
  observation_status_code: number | null;
  observation_entity_type: number | null;
  observation_privacy_level: number | null;
  observation_classification_state: PrivateAgendaProjectionRow["observationClassificationState"];
  observation_classification_category: string | null;
  observation_program_key: string | null;
  observation_series_key: string | null;
  observation_scheduled_start_at: string | null;
  observation_scheduled_end_at: string | null;
  observation_updated_at: string | null;
};

/**
 * Read the private authority needed for an agenda projection. This repository
 * deliberately performs no writes and returns no raw Discord payload fields.
 */
export function readPrivateAgendaProjectionRows(
  db: SqliteDatabase,
  options: { guildId?: string } = {}
): PrivateAgendaProjectionRow[] {
  const whereGuild = options.guildId == null ? "" : " AND p.guild_id = ?";
  const params = options.guildId == null ? [] : [options.guildId];
  const rows = db.prepare(
    `SELECT
       p.id AS agenda_entry_id,
       p.source_provider_event_id,
       p.source_observation_id,
       p.guild_id,
       p.projection_type,
       p.title,
       p.summary,
       p.program_key,
       p.series_key,
       p.scheduled_start_at,
       p.scheduled_end_at,
       p.timezone,
       p.agenda_state,
       p.created_at AS agenda_created_at,
       p.updated_at AS agenda_updated_at,
       a.state AS approval_state,
       a.requested_at AS approval_requested_at,
       a.decided_at AS approval_decided_at,
       a.decided_by AS approval_decided_by,
       o.provider_event_id AS observation_provider_event_id,
       o.guild_id AS observation_guild_id,
       o.observation_id,
       o.last_observed_at AS observation_last_observed_at,
       o.source AS observation_source,
       o.source_version AS observation_source_version,
       o.observation_state,
       o.status_code AS observation_status_code,
       o.entity_type AS observation_entity_type,
       o.privacy_level AS observation_privacy_level,
       o.classification_state AS observation_classification_state,
       o.classification_category AS observation_classification_category,
       o.program_key AS observation_program_key,
       o.series_key AS observation_series_key,
       o.scheduled_start_at AS observation_scheduled_start_at,
       o.scheduled_end_at AS observation_scheduled_end_at,
       o.updated_at AS observation_updated_at
     FROM private_agenda_entries AS p
     LEFT JOIN publication_approvals AS a
       ON a.agenda_entry_id = p.id
      AND a.projection_type = p.projection_type
     LEFT JOIN discord_scheduled_event_observations_current AS o
       ON o.provider_event_id = p.source_provider_event_id
      AND o.guild_id = p.guild_id
     WHERE p.projection_type = ?${whereGuild}
     ORDER BY p.id ASC`
  ).all(LANGUAGE_CLUB_AGENDA_PROJECTION_TYPE, ...params) as PrivateAgendaProjectionSqlRow[];

  return rows.map((row) => ({
    agendaEntryId: row.agenda_entry_id,
    sourceProviderEventId: row.source_provider_event_id,
    sourceObservationId: row.source_observation_id,
    guildId: row.guild_id,
    projectionType: row.projection_type,
    title: row.title,
    summary: row.summary,
    programKey: row.program_key,
    seriesKey: row.series_key,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    timezone: row.timezone,
    agendaState: row.agenda_state,
    agendaCreatedAt: row.agenda_created_at,
    agendaUpdatedAt: row.agenda_updated_at,
    approvalState: row.approval_state,
    approvalRequestedAt: row.approval_requested_at,
    approvalDecidedAt: row.approval_decided_at,
    approvalDecidedBy: row.approval_decided_by,
    observationProviderEventId: row.observation_provider_event_id,
    observationGuildId: row.observation_guild_id,
    observationId: row.observation_id,
    observationLastObservedAt: row.observation_last_observed_at,
    observationSource: row.observation_source,
    observationSourceVersion: row.observation_source_version,
    observationState: row.observation_state,
    observationStatusCode: row.observation_status_code,
    observationEntityType: row.observation_entity_type,
    observationPrivacyLevel: row.observation_privacy_level,
    observationClassificationState: row.observation_classification_state,
    observationClassificationCategory: row.observation_classification_category,
    observationProgramKey: row.observation_program_key,
    observationSeriesKey: row.observation_series_key,
    observationScheduledStartAt: row.observation_scheduled_start_at,
    observationScheduledEndAt: row.observation_scheduled_end_at,
    observationUpdatedAt: row.observation_updated_at
  }));
}

/** Read only rows which have crossed both approval gates. */
export function readApprovedPrivateAgendaRows(
  db: SqliteDatabase,
  options: { guildId?: string } = {}
): PrivateAgendaProjectionRow[] {
  return readPrivateAgendaProjectionRows(db, options).filter(
    (row) => row.agendaState === "approved" && row.approvalState === "approved"
  );
}

/** Withdrawn rows are read separately so their opaque tombstones can be kept. */
export function readWithdrawnPrivateAgendaRows(
  db: SqliteDatabase,
  options: { guildId?: string } = {}
): PrivateAgendaProjectionRow[] {
  return readPrivateAgendaProjectionRows(db, options).filter(
    (row) => row.agendaState === "withdrawn" && row.approvalState === "withdrawn"
  );
}
