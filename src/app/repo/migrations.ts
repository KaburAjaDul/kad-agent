import type { SqliteDatabase } from "./sqlite.js";

type Migration = {
  id: string;
  sql: string;
};

const FOUNDATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  discord_guild_id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  discord_channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(discord_guild_id)
);

CREATE TABLE IF NOT EXISTS members (
  discord_user_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(discord_guild_id)
);

CREATE TABLE IF NOT EXISTS event_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  default_approval_class TEXT NOT NULL,
  classification TEXT NOT NULL,
  is_seeded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  template_id TEXT,
  template_key TEXT,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  classification TEXT NOT NULL,
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  target_channel_id TEXT,
  announcement_message_id TEXT,
  published_at TEXT,
  created_by_discord_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES event_templates(id)
);

CREATE TABLE IF NOT EXISTS event_state_transitions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_discord_user_id TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS event_reminders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  audience_kind TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  state TEXT NOT NULL,
  job_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  last_attempted_at TEXT,
  delivered_at TEXT,
  delivery_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_by_discord_user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  request_reason TEXT,
  request_fingerprint TEXT NOT NULL,
  source_interaction_id TEXT,
  approver_discord_user_id TEXT,
  decision_at TEXT,
  decision_reason TEXT,
  executed_at TEXT,
  execution_result TEXT,
  execution_error TEXT,
  supersedes_request_id TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (supersedes_request_id) REFERENCES approval_requests(id)
);

CREATE TABLE IF NOT EXISTS activity_text_daily (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (guild_id, channel_id, member_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS activity_voice_daily (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  connected_minutes INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (guild_id, channel_id, member_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  job_key TEXT,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_summary TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_state ON events(state);
CREATE INDEX IF NOT EXISTS idx_event_reminders_due ON event_reminders(state, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs(job_name, started_at);
CREATE INDEX IF NOT EXISTS idx_activity_text_daily_date ON activity_text_daily(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_activity_voice_daily_date ON activity_voice_daily(snapshot_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(event_id, action_type) WHERE state = 'pending';
`;

const EVENT_SLICE_E1_MIGRATION_SQL = `
PRAGMA defer_foreign_keys = ON;

CREATE TABLE event_templates_e1_new (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  default_approval_class TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  classification TEXT NOT NULL,
  is_seeded INTEGER NOT NULL DEFAULT 0,
  title_template TEXT NOT NULL,
  description_template TEXT NOT NULL,
  default_timezone TEXT NOT NULL,
  default_duration_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (template_key, template_version)
);

INSERT INTO event_templates_e1_new (
  id,
  template_key,
  template_version,
  name,
  event_type,
  default_approval_class,
  approval_class,
  classification,
  is_seeded,
  title_template,
  description_template,
  default_timezone,
  default_duration_minutes,
  created_at
)
SELECT
  id,
  template_key,
  1,
  name,
  event_type,
  default_approval_class,
  default_approval_class,
  classification,
  is_seeded,
  '',
  '',
  'UTC',
  60,
  created_at
FROM event_templates;

INSERT INTO event_templates_e1_new (
  id,
  template_key,
  template_version,
  name,
  event_type,
  default_approval_class,
  approval_class,
  classification,
  is_seeded,
  title_template,
  description_template,
  default_timezone,
  default_duration_minutes,
  created_at
)
SELECT
  'legacy-template-' || template_key,
  template_key,
  1,
  template_key,
  'legacy_unknown',
  'hard_stop',
  'hard_stop',
  'legacy_unclassified',
  0,
  '',
  '',
  'UTC',
  60,
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT DISTINCT template_key
  FROM events
  WHERE template_key IS NOT NULL
    AND TRIM(template_key) <> ''
) AS legacy_event_templates
WHERE NOT EXISTS (
  SELECT 1
  FROM event_templates_e1_new AS existing
  WHERE existing.template_key = legacy_event_templates.template_key
    AND existing.template_version = 1
);

DROP TABLE event_templates;

ALTER TABLE event_templates_e1_new RENAME TO event_templates;

CREATE TABLE events_e1_new (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  classification TEXT NOT NULL,
  scheduled_start_at TEXT NOT NULL,
  scheduled_end_at TEXT NOT NULL,
  target_channel_id TEXT,
  announcement_message_id TEXT,
  published_at TEXT,
  created_by_discord_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  announcement_channel_id TEXT NOT NULL,
  host_voice_channel_id TEXT,
  template_version INTEGER NOT NULL,
  scheduling_scope_key TEXT NOT NULL,
  timezone TEXT NOT NULL,
  source_interaction_id TEXT NOT NULL,
  drafted_at TEXT NOT NULL,
  publish_failed_at TEXT,
  publish_error TEXT,
  discord_announcement_message_id TEXT,
  discord_scheduled_event_id TEXT,
  google_calendar_event_id TEXT,
  FOREIGN KEY (template_id) REFERENCES event_templates(id),
  UNIQUE (guild_id, event_type, scheduling_scope_key, scheduled_start_at)
);

INSERT INTO events_e1_new (
  id,
  guild_id,
  template_id,
  template_key,
  title,
  description,
  state,
  event_type,
  approval_class,
  classification,
  scheduled_start_at,
  scheduled_end_at,
  target_channel_id,
  announcement_message_id,
  published_at,
  created_by_discord_user_id,
  created_at,
  updated_at,
  announcement_channel_id,
  host_voice_channel_id,
  template_version,
  scheduling_scope_key,
  timezone,
  source_interaction_id,
  drafted_at,
  publish_failed_at,
  publish_error,
  discord_announcement_message_id,
  discord_scheduled_event_id,
  google_calendar_event_id
)
SELECT
  legacy.id,
  legacy.guild_id,
  COALESCE(template_by_id.id, template_by_key.id),
  COALESCE(NULLIF(legacy.template_key, ''), template_by_id.template_key, template_by_key.template_key),
  legacy.title,
  COALESCE(legacy.description, ''),
  legacy.state,
  COALESCE(NULLIF(legacy.event_type, ''), template_by_id.event_type, template_by_key.event_type, 'legacy_unknown'),
  COALESCE(
    NULLIF(legacy.approval_class, ''),
    template_by_id.approval_class,
    template_by_key.approval_class,
    NULLIF(template_by_id.default_approval_class, ''),
    NULLIF(template_by_key.default_approval_class, ''),
    'hard_stop'
  ),
  COALESCE(NULLIF(legacy.classification, ''), template_by_id.classification, template_by_key.classification, 'legacy_unclassified'),
  COALESCE(legacy.scheduled_start_at, legacy.created_at, ''),
  COALESCE(legacy.scheduled_end_at, legacy.scheduled_start_at, legacy.created_at, ''),
  legacy.target_channel_id,
  legacy.announcement_message_id,
  legacy.published_at,
  legacy.created_by_discord_user_id,
  COALESCE(legacy.created_at, ''),
  COALESCE(legacy.updated_at, legacy.published_at, legacy.created_at, ''),
  COALESCE(NULLIF(legacy.target_channel_id, ''), ''),
  NULL,
  1,
  COALESCE(
    NULLIF(legacy.template_key, ''),
    template_by_id.template_key,
    template_by_key.template_key,
    ''
  ),
  'UTC',
  '',
  COALESCE(legacy.created_at, ''),
  NULL,
  NULL,
  legacy.announcement_message_id,
  NULL,
  NULL
FROM events AS legacy
LEFT JOIN event_templates AS template_by_id
  ON template_by_id.id = legacy.template_id
LEFT JOIN event_templates AS template_by_key
  ON template_by_key.template_key = legacy.template_key
 AND template_by_key.template_version = 1;

DROP TABLE events;

ALTER TABLE events_e1_new RENAME TO events;

CREATE INDEX idx_events_state ON events(state);

ALTER TABLE event_state_transitions RENAME TO event_state_transitions_legacy;

CREATE TABLE event_state_transitions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_discord_user_id TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

INSERT INTO event_state_transitions (
  id,
  event_id,
  from_state,
  to_state,
  actor_discord_user_id,
  reason,
  occurred_at
)
SELECT
  id,
  event_id,
  from_state,
  to_state,
  COALESCE(NULLIF(actor_discord_user_id, ''), 'system'),
  reason,
  occurred_at
FROM event_state_transitions_legacy;

DROP TABLE event_state_transitions_legacy;
`;

const EVENT_SLICE_E1_SETUP_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS language_club_guild_config (
  guild_id TEXT PRIMARY KEY,
  announcement_channel_id TEXT NOT NULL,
  host_voice_channel_id TEXT NOT NULL,
  default_timezone TEXT NOT NULL,
  configured_by_discord_user_id TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  updated_by_discord_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS language_club_staff_roles (
  guild_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  added_by_discord_user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, discord_role_id),
  FOREIGN KEY (guild_id) REFERENCES language_club_guild_config(guild_id)
);
`;

const EVENT_SLICE_E1_5_SQL = `
CREATE TABLE IF NOT EXISTS event_hosts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  assigned_by_discord_user_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id),
  UNIQUE (event_id, discord_user_id)
);
`;

const EVENT_SLICE_E2_ASSIGNED_LANGUAGE_CLUBS_SQL = `
CREATE TABLE IF NOT EXISTS language_clubs (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  club_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  default_host_voice_channel_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  configured_by_discord_user_id TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  updated_by_discord_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, club_key)
);

ALTER TABLE events ADD COLUMN language_club_id TEXT;
ALTER TABLE events ADD COLUMN language_club_key TEXT;
ALTER TABLE events ADD COLUMN language_club_display_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_language_club_schedule
  ON events(guild_id, event_type, language_club_id, scheduled_start_at)
  WHERE language_club_id IS NOT NULL;
`;

const EVENT_SLICE_E2_REMINDER_DELIVERY_SQL = `
ALTER TABLE event_reminders ADD COLUMN discord_message_id TEXT;

UPDATE event_reminders
SET state = CASE state
  WHEN 'scheduled' THEN 'pending'
  WHEN 'leased' THEN 'sending'
  WHEN 'delivered' THEN 'sent'
  WHEN 'failed' THEN 'send_failed'
  ELSE state
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_reminders_event_job_key
  ON event_reminders(event_id, job_key);
`;

const RUNTIME_DURABILITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS runtime_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_effect_intents (
  id TEXT PRIMARY KEY,
  deterministic_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'retryable', 'needs_reconciliation', 'cancelled', 'dead_letter')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  runtime_fencing_token INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  external_reference TEXT,
  last_error TEXT,
  last_attempted_at TEXT,
  succeeded_at TEXT,
  cancelled_at TEXT,
  needs_reconciliation_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_effect_intents_due
  ON external_effect_intents(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_external_effect_intents_authority
  ON external_effect_intents(authority_id, guild_id);

ALTER TABLE event_reminders ADD COLUMN lease_owner TEXT;
ALTER TABLE event_reminders ADD COLUMN lease_expires_at TEXT;
ALTER TABLE event_reminders ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_reminders ADD COLUMN runtime_fencing_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_reminders ADD COLUMN heartbeat_at TEXT;
ALTER TABLE event_reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_reminders ADD COLUMN next_attempt_at TEXT;
ALTER TABLE event_reminders ADD COLUMN needs_reconciliation_at TEXT;
ALTER TABLE event_reminders ADD COLUMN dead_lettered_at TEXT;

UPDATE event_reminders
SET next_attempt_at = COALESCE(next_attempt_at, scheduled_for),
    attempts = COALESCE(attempts, 0);

CREATE INDEX IF NOT EXISTS idx_event_reminders_retry_due
  ON event_reminders(state, next_attempt_at);
`;

const DISCORD_OBSERVATION_AND_PROJECTION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS discord_scheduled_event_observation_history (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'discord_rest_reconciliation'),
  source_version INTEGER NOT NULL CHECK (source_version = 1),
  observation_state TEXT NOT NULL CHECK (observation_state IN ('present', 'disappeared', 'tombstoned')),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 1 AND 4),
  entity_type INTEGER CHECK (entity_type IS NULL OR entity_type IN (2, 3)),
  privacy_level INTEGER CHECK (privacy_level IS NULL OR privacy_level = 2),
  normalized_title TEXT,
  classification_state TEXT NOT NULL CHECK (classification_state IN ('allowlisted', 'unknown', 'invalid', 'withdrawn')),
  classification_category TEXT,
  program_key TEXT,
  series_key TEXT,
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  reason_code TEXT NOT NULL,
  observation_fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_observation_history_source_identity
  ON discord_scheduled_event_observation_history(id, provider_event_id, guild_id);

CREATE TABLE IF NOT EXISTS discord_scheduled_event_observations_current (
  provider_event_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'discord_rest_reconciliation'),
  source_version INTEGER NOT NULL CHECK (source_version = 1),
  observation_state TEXT NOT NULL CHECK (observation_state IN ('present', 'disappeared', 'tombstoned')),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 1 AND 4),
  entity_type INTEGER CHECK (entity_type IS NULL OR entity_type IN (2, 3)),
  privacy_level INTEGER CHECK (privacy_level IS NULL OR privacy_level = 2),
  normalized_title TEXT,
  classification_state TEXT NOT NULL CHECK (classification_state IN ('allowlisted', 'unknown', 'invalid', 'withdrawn')),
  classification_category TEXT,
  program_key TEXT,
  series_key TEXT,
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  reason_code TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (observation_id, provider_event_id, guild_id)
    REFERENCES discord_scheduled_event_observation_history(id, provider_event_id, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_observation_history_guild_time
  ON discord_scheduled_event_observation_history(guild_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_discord_observation_current_state
  ON discord_scheduled_event_observations_current(guild_id, observation_state, classification_state);

CREATE TABLE IF NOT EXISTS private_agenda_entries (
  id TEXT PRIMARY KEY,
  source_provider_event_id TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  projection_type TEXT NOT NULL CHECK (projection_type = 'language_club_agenda_entry.v1'),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  program_key TEXT NOT NULL,
  series_key TEXT,
  scheduled_start_at TEXT NOT NULL,
  scheduled_end_at TEXT,
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Jakarta'),
  agenda_state TEXT NOT NULL CHECK (agenda_state IN ('pending', 'approved', 'withdrawn')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_provider_event_id, projection_type),
  FOREIGN KEY (source_observation_id, source_provider_event_id, guild_id)
    REFERENCES discord_scheduled_event_observation_history(id, provider_event_id, guild_id)
);

CREATE TABLE IF NOT EXISTS publication_approvals (
  id TEXT PRIMARY KEY,
  agenda_entry_id TEXT NOT NULL,
  projection_type TEXT NOT NULL CHECK (projection_type = 'language_club_agenda_entry.v1'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_at TEXT NOT NULL,
  requested_by TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  FOREIGN KEY (agenda_entry_id) REFERENCES private_agenda_entries(id),
  UNIQUE (agenda_entry_id, projection_type)
);

CREATE TABLE IF NOT EXISTS public_projection_outbox (
  id TEXT PRIMARY KEY,
  projection_type TEXT NOT NULL CHECK (projection_type = 'language_club_agenda_entry.v1'),
  agenda_entry_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'published', 'failed', 'withdrawn')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT,
  FOREIGN KEY (agenda_entry_id) REFERENCES private_agenda_entries(id),
  UNIQUE (projection_type, agenda_entry_id, projection_revision)
);

CREATE TABLE IF NOT EXISTS public_projection_revisions (
  projection_type TEXT PRIMARY KEY CHECK (projection_type = 'language_club_agenda_entry.v1'),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_projection_checkpoints (
  checkpoint_key TEXT PRIMARY KEY,
  projection_type TEXT NOT NULL CHECK (projection_type = 'language_club_agenda_entry.v1'),
  last_revision INTEGER NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
  last_observation_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_projection_tombstones (
  projection_type TEXT NOT NULL CHECK (projection_type = 'language_club_agenda_entry.v1'),
  public_entry_id TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (projection_type, public_entry_id)
);
`;

const migrations: Migration[] = [
  {
    id: "0001_foundation",
    sql: FOUNDATION_MIGRATION_SQL
  },
  {
    id: "0002_event_slice_e1",
    sql: EVENT_SLICE_E1_MIGRATION_SQL
  },
  {
    id: "0003_event_slice_e1_setup_config",
    sql: EVENT_SLICE_E1_SETUP_CONFIG_SQL
  },
  {
    id: "0004_event_slice_e1_5_host_snapshot",
    sql: EVENT_SLICE_E1_5_SQL
  },
  {
    id: "0005_event_slice_e2_assigned_language_clubs",
    sql: EVENT_SLICE_E2_ASSIGNED_LANGUAGE_CLUBS_SQL
  },
  {
    id: "0006_event_slice_e2_reminder_delivery",
    sql: EVENT_SLICE_E2_REMINDER_DELIVERY_SQL
  },
  {
    id: "0007_runtime_durability",
    sql: RUNTIME_DURABILITY_MIGRATION_SQL
  },
  {
    id: "0008_discord_observations_and_projection",
    sql: DISCORD_OBSERVATION_AND_PROJECTION_MIGRATION_SQL
  }
];

export function runMigrations(db: SqliteDatabase): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedMigrationIds = new Set(
    db
      .prepare("SELECT id FROM schema_migrations ORDER BY id ASC")
      .all()
      .map((row) => String((row as { id: string }).id))
  );

  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (appliedMigrationIds.has(migration.id)) {
      continue;
    }

    db.exec("BEGIN");

    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}
