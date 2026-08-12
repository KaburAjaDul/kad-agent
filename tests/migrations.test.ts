import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { seedFoundationData } from "../src/app/repo/seeds.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();

    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("foundation database", () => {
  it("refuses to upgrade a non-empty legacy projection outbox without canonical hashing", () => {
    const db = createSqliteConnection(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE public_projection_outbox (
          id TEXT PRIMARY KEY,
          projection_type TEXT NOT NULL,
          agenda_entry_id TEXT NOT NULL,
          projection_revision INTEGER NOT NULL,
          state TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          published_at TEXT,
          last_error TEXT
        );
      `);
      const migrationIds = [
        "0001_foundation", "0002_event_slice_e1", "0003_event_slice_e1_setup_config",
        "0004_event_slice_e1_5_host_snapshot", "0005_event_slice_e2_assigned_language_clubs",
        "0006_event_slice_e2_reminder_delivery", "0007_runtime_durability",
        "0008_discord_observations_and_projection"
      ];
      const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
      for (const id of migrationIds) insert.run(id, "2026-08-12T10:00:00.000Z");
      db.prepare(
        `INSERT INTO public_projection_outbox
          (id, projection_type, agenda_entry_id, projection_revision, state, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("legacy-1", "language_club_agenda_entry.v1", "agenda-1", 1, "pending", "{}", "2026-08-12T10:00:00.000Z", "2026-08-12T10:00:00.000Z");

      expect(() => runMigrations(db)).toThrow(/refuses non-empty legacy public_projection_outbox/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?").get("0009_public_projection_outbox_durability")).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("creates E1 event schema and seeded language club template", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "kad-agent-foundation-"));
    tempDirectories.push(tempDirectory);

    const db = createSqliteConnection(join(tempDirectory, "foundation.sqlite"));

    try {
      const appliedMigrations = runMigrations(db);
      const insertedSeedRows = seedFoundationData(db);
      const tableNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all()
        .map((row) => String((row as { name: string }).name));
      const seededTemplateCount = Number(
        (db.prepare("SELECT COUNT(*) as count FROM event_templates").get() as { count: number } | undefined)?.count ?? 0
      );
      const eventColumns = db.prepare("PRAGMA table_info(events)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const eventHostColumns = db.prepare("PRAGMA table_info(event_hosts)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const reminderColumns = db.prepare("PRAGMA table_info(event_reminders)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const templateColumns = db.prepare("PRAGMA table_info(event_templates)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const templateUniqueIndexes = listUniqueIndexes(db, "event_templates");
      const eventUniqueIndexes = listUniqueIndexes(db, "events");
      const eventHostUniqueIndexes = listUniqueIndexes(db, "event_hosts");
      const publicProjectionOutboxUniqueIndexes = listUniqueIndexes(db, "public_projection_outbox");
      const seededTemplateId = String(
        (
          db.prepare("SELECT id FROM event_templates WHERE template_key = ? AND template_version = ?").get(
            "language_club_default",
            1
          ) as { id: string } | undefined
        )?.id ?? ""
      );
      const seededTemplate = db
        .prepare(
          `
            SELECT
              template_key,
              template_version,
              event_type,
              approval_class,
              classification,
              title_template,
              description_template,
              default_timezone,
              default_duration_minutes
            FROM event_templates
          `
        )
        .get() as
        | {
            template_key: string;
            template_version: number;
            event_type: string;
            approval_class: string;
            classification: string;
            title_template: string;
            description_template: string;
            default_timezone: string;
            default_duration_minutes: number;
          }
        | undefined;

      expect(appliedMigrations).toEqual([
        "0001_foundation",
        "0002_event_slice_e1",
        "0003_event_slice_e1_setup_config",
        "0004_event_slice_e1_5_host_snapshot",
        "0005_event_slice_e2_assigned_language_clubs",
        "0006_event_slice_e2_reminder_delivery",
        "0007_runtime_durability",
        "0008_discord_observations_and_projection",
        "0009_public_projection_outbox_durability"
      ]);
      expect(insertedSeedRows).toBe(1);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "activity_text_daily",
          "activity_voice_daily",
          "approval_requests",
          "event_hosts",
          "event_reminders",
          "event_state_transitions",
          "event_templates",
          "events",
          "job_runs",
          "language_club_guild_config",
          "language_clubs",
          "language_club_staff_roles",
          "runtime_leases",
          "external_effect_intents",
          "discord_scheduled_event_observation_history",
          "discord_scheduled_event_observations_current",
          "private_agenda_entries",
          "publication_approvals",
          "public_projection_outbox",
          "public_projection_revisions",
          "public_projection_checkpoints",
          "public_projection_tombstones",
          "schema_migrations"
        ])
      );
      expect(seededTemplateCount).toBe(1);
      expect(eventColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "announcement_channel_id", notnull: 1 }),
          expect.objectContaining({ name: "host_voice_channel_id", notnull: 0 }),
          expect.objectContaining({ name: "template_id", notnull: 1 }),
          expect.objectContaining({ name: "template_key", notnull: 1 }),
          expect.objectContaining({ name: "template_version", notnull: 1 }),
          expect.objectContaining({ name: "scheduling_scope_key", notnull: 1 }),
          expect.objectContaining({ name: "language_club_id", notnull: 0 }),
          expect.objectContaining({ name: "language_club_key", notnull: 0 }),
          expect.objectContaining({ name: "language_club_display_name", notnull: 0 })
        ])
      );
      expect(templateColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "template_key", notnull: 1 }),
          expect.objectContaining({ name: "template_version", notnull: 1 }),
          expect.objectContaining({ name: "event_type", notnull: 1 }),
          expect.objectContaining({ name: "approval_class", notnull: 1 })
        ])
      );
      expect(eventHostColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "event_id", notnull: 1 }),
          expect.objectContaining({ name: "discord_user_id", notnull: 1 }),
          expect.objectContaining({ name: "display_order", notnull: 1 }),
          expect.objectContaining({ name: "assigned_by_discord_user_id", notnull: 1 }),
          expect.objectContaining({ name: "assigned_at", notnull: 1 })
        ])
      );
      expect(reminderColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "state", notnull: 1 }),
          expect.objectContaining({ name: "job_key", notnull: 1 }),
          expect.objectContaining({ name: "discord_message_id", notnull: 0 }),
          expect.objectContaining({ name: "lease_owner", notnull: 0 }),
          expect.objectContaining({ name: "lease_expires_at", notnull: 0 }),
          expect.objectContaining({ name: "fencing_token", notnull: 1 }),
          expect.objectContaining({ name: "runtime_fencing_token", notnull: 1 }),
          expect.objectContaining({ name: "attempts", notnull: 1 }),
          expect.objectContaining({ name: "next_attempt_at", notnull: 0 })
        ])
      );
      expect(templateUniqueIndexes).toContainEqual(["template_key", "template_version"]);
      expect(templateUniqueIndexes).not.toContainEqual(["template_key"]);
      expect(eventUniqueIndexes).toContainEqual([
        "guild_id",
        "event_type",
        "scheduling_scope_key",
        "scheduled_start_at"
      ]);
      expect(eventHostUniqueIndexes).toContainEqual(["event_id", "discord_user_id"]);
      expect(publicProjectionOutboxUniqueIndexes).toContainEqual([
        "projection_type",
        "projection_revision"
      ]);
      expect(seededTemplate).toEqual({
        template_key: "language_club_default",
        template_version: 1,
        event_type: "language_club",
        approval_class: "routine_auto_publish",
        classification: "routine_language_club",
        title_template: "Language Club KAD — {day_name}, {date_label}",
        description_template:
          "Yuk latihan ngobrol santai bareng komunitas KAD pada {day_name}, {date_label} pukul {time_label} ({timezone_label}).",
        default_timezone: "Asia/Jakarta",
        default_duration_minutes: 90
      });

      db.prepare(
        `
          INSERT INTO event_templates (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        "template_v2",
        "language_club_default",
        2,
        "Language Club Default v2",
        "language_club",
        "routine_auto_publish",
        "routine_auto_publish",
        "routine_language_club",
        1,
        "Title v2",
        "Description v2",
        "Asia/Jakarta",
        90,
        "2026-01-02T00:00:00.000Z"
      );

      expect(() =>
        db.prepare(
          `
            INSERT INTO event_templates (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          "template_duplicate",
          "language_club_default",
          1,
          "Duplicate Template",
          "language_club",
          "routine_auto_publish",
          "routine_auto_publish",
          "routine_language_club",
          1,
          "Duplicate title",
          "Duplicate description",
          "Asia/Jakarta",
          90,
          "2026-01-03T00:00:00.000Z"
        )
      ).toThrow(/UNIQUE/);

      db.prepare(
        `
          INSERT INTO events (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        "event_1",
        "guild_1",
        seededTemplateId,
        "language_club_default",
        "Weekly Language Club",
        "Test event",
        "drafted",
        "language_club",
        "routine_auto_publish",
        "routine_language_club",
        "2026-04-25T12:00:00.000Z",
        "2026-04-25T13:30:00.000Z",
        "channel_1",
        null,
        null,
        "user_1",
        "2026-04-23T10:00:00.000Z",
        "2026-04-23T10:00:00.000Z",
        "channel_1",
        "voice_1",
        1,
        "language_club_channel:voice_1",
        "Asia/Jakarta",
        "interaction_1",
        "2026-04-23T10:00:00.000Z",
        null,
        null,
        null,
        null,
        null
      );

      db.prepare(
        `
          INSERT INTO events (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        "event_different_scope",
        "guild_1",
        seededTemplateId,
        "language_club_default",
        "Language Club Different Scope",
        "Same time, different host channel",
        "drafted",
        "language_club",
        "routine_auto_publish",
        "routine_language_club",
        "2026-04-25T12:00:00.000Z",
        "2026-04-25T13:30:00.000Z",
        "channel_1",
        null,
        null,
        "user_2",
        "2026-04-23T10:05:00.000Z",
        "2026-04-23T10:05:00.000Z",
        "channel_1",
        "voice_2",
        1,
        "language_club_channel:voice_2",
        "Asia/Jakarta",
        "interaction_2",
        "2026-04-23T10:05:00.000Z",
        null,
        null,
        null,
        null,
        null
      );

      expect(() =>
        db.prepare(
          `
            INSERT INTO events (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          "event_2",
          "guild_1",
          seededTemplateId,
          "language_club_default",
          "Duplicate Weekly Language Club",
          "Duplicate test event",
          "drafted",
          "language_club",
          "routine_auto_publish",
          "routine_language_club",
          "2026-04-25T12:00:00.000Z",
          "2026-04-25T13:30:00.000Z",
          "channel_1",
          null,
          null,
          "user_3",
          "2026-04-23T10:05:00.000Z",
          "2026-04-23T10:05:00.000Z",
          "channel_1",
          "voice_1",
          1,
          "language_club_channel:voice_1",
          "Asia/Jakarta",
          "interaction_3",
          "2026-04-23T10:05:00.000Z",
          null,
          null,
          null,
          null,
          null
        )
      ).toThrow(/UNIQUE/);

      db.prepare(
        `
          INSERT INTO event_hosts (
            id,
            event_id,
            discord_user_id,
            display_order,
            assigned_by_discord_user_id,
            assigned_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
      ).run("event_host_1", "event_1", "host_user_1", 1, "user_1", "2026-04-23T10:00:00.000Z");

      expect(() =>
        db.prepare(
          `
            INSERT INTO event_hosts (
              id,
              event_id,
              discord_user_id,
              display_order,
              assigned_by_discord_user_id,
              assigned_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
        ).run("event_host_2", "event_1", "host_user_1", 2, "user_1", "2026-04-23T10:01:00.000Z")
      ).toThrow(/UNIQUE/);

      expect(() =>
        db.prepare(
          `
            INSERT INTO events (
              id,
              guild_id,
              template_id,
              template_key,
              title,
              state,
              event_type,
              approval_class,
              classification,
              scheduled_start_at,
              scheduled_end_at,
              created_by_discord_user_id,
              created_at,
              updated_at,
              announcement_channel_id,
              template_version,
              scheduling_scope_key,
              timezone,
              source_interaction_id,
              drafted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          "event_missing_required",
          "guild_2",
          seededTemplateId,
          "language_club_default",
          "Missing Description",
          "drafted",
          "language_club",
          "routine_auto_publish",
          "routine_language_club",
          "2026-04-26T12:00:00.000Z",
          "2026-04-26T13:30:00.000Z",
          "user_3",
          "2026-04-23T10:10:00.000Z",
          "2026-04-23T10:10:00.000Z",
          "channel_2",
          1,
          "language_club_default",
          "Asia/Jakarta",
          "interaction_3",
          "2026-04-23T10:10:00.000Z"
        )
      ).toThrow(/NOT NULL/);
    } finally {
      db.close();
    }
  });

  it("enforces observation source integrity at the SQLite boundary", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      expect(() => db.prepare(
        `INSERT INTO discord_scheduled_event_observation_history (
          id, provider_event_id, guild_id, observed_at, source, source_version,
          observation_state, status_code, entity_type, privacy_level,
          classification_state, reason_code, observation_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("observation-invalid", "123456789012345678", "123456789012345678", "2026-08-12T10:00:00.000Z", "other_source", 1, "present", 1, 3, 2, "unknown", "test", "fingerprint-invalid", "2026-08-12T10:00:00.000Z")).toThrow(/CHECK/);

      db.prepare(
        `INSERT INTO discord_scheduled_event_observation_history (
          id, provider_event_id, guild_id, observed_at, source, source_version,
          observation_state, status_code, entity_type, privacy_level,
          classification_state, reason_code, observation_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("observation-valid", "123456789012345678", "123456789012345678", "2026-08-12T10:00:00.000Z", "discord_rest_reconciliation", 1, "present", 1, 3, 2, "allowlisted", "test", "fingerprint-valid", "2026-08-12T10:00:00.000Z");
      expect(() => db.prepare(
        `INSERT INTO private_agenda_entries (
          id, source_provider_event_id, source_observation_id, guild_id,
          projection_type, title, summary, program_key, scheduled_start_at,
          timezone, agenda_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("agenda-invalid", "999999999999999999", "observation-valid", "123456789012345678", "language_club_agenda_entry.v1", "Title", "Summary", "program", "2026-08-12T10:00:00.000Z", "Asia/Jakarta", "pending", "2026-08-12T10:00:00.000Z", "2026-08-12T10:00:00.000Z")).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});

function listUniqueIndexes(db: ReturnType<typeof createSqliteConnection>, tableName: string): string[][] {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;

  return indexes
    .filter((index) => index.unique === 1 && index.origin !== "pk")
    .map((index) =>
      (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
}
