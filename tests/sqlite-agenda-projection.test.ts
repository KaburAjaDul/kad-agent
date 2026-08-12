import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { buildSqliteAgendaProjection as assembleSqliteAgendaProjection, type SqliteAgendaProjectionOptions } from "../src/publication/sqlite-agenda-projection.js";
import { publicAgendaId } from "../src/publication/ids.js";

const GUILD_ID = "123456789012345678";
const EVENT_A = "234567890123456789";
const EVENT_B = "334567890123456789";
const PUBLIC_KEY = "test-public-agenda-key-2026";
const TEST_NOW = () => new Date("2026-08-12T12:00:00.000Z");
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe("SQLite agenda projection assembler", () => {
  it("builds a complete, deterministic snapshot from approved private rows", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A, start: "2026-08-20T04:00:00.000Z", updated: "2026-08-12T10:00:00.000Z" });
    insertAgenda(db, { eventId: EVENT_B, start: "2026-08-19T04:00:00.000Z", updated: "2026-08-12T10:00:00.000Z", category: "french" });

    const projection = buildSqliteAgendaProjection({
      db,
      publicIdKey: PUBLIC_KEY,
      revision: 41,
      observedAt: "2026-08-12T10:00:00.000Z"
    });

    expect(projection).toEqual({
      schemaVersion: "v1",
      observedAt: "2026-08-12T10:00:00.000Z",
      revision: 41,
      entries: [
        expect.objectContaining({
          id: publicAgendaId(PUBLIC_KEY, EVENT_B),
          title: "French Study Club",
          summary: "A practical French practice session for learners.",
          program: "French Study Club",
          series: null,
          status: "scheduled",
          joinUrl: "https://discord.gg/RUFFbEaeDx",
          source: "discord_scheduled_event"
        }),
        expect.objectContaining({ id: publicAgendaId(PUBLIC_KEY, EVENT_A), status: "scheduled" })
      ],
      tombstones: []
    });
    expect(JSON.stringify(projection)).not.toContain(EVENT_A);
    expect(JSON.stringify(projection)).not.toContain(EVENT_B);
    expect(JSON.stringify(projection)).not.toContain("agenda-");
    expect(Object.keys(projection.entries[0] ?? {}).sort()).toEqual([
      "endAt", "id", "joinUrl", "program", "series", "source", "startAt", "status", "summary", "timezone", "title"
    ]);
  });

  it("emits opaque tombstones for withdrawn records and excludes pending records", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A, state: "withdrawn", approvalState: "withdrawn", start: "2026-08-20T04:00:00.000Z" });
    insertAgenda(db, { eventId: EVENT_B, state: "pending", approvalState: "pending", start: "2026-08-21T04:00:00.000Z" });
    const projection = buildSqliteAgendaProjection({ db, publicIdKey: PUBLIC_KEY, revision: 42 });
    expect(projection.entries).toEqual([]);
    expect(projection.tombstones).toEqual([publicAgendaId(PUBLIC_KEY, EVENT_A)]);
  });

  it("fails closed for unknown labels, stale approvals, and source mismatch", () => {
    const unknown = testDb();
    insertAgenda(unknown, { eventId: EVENT_A, category: "unknown" });
    expect(() => buildSqliteAgendaProjection({ db: unknown, publicIdKey: PUBLIC_KEY, revision: 1 })).toThrow("unknown public label");

    const stale = testDb();
    insertAgenda(stale, { eventId: EVENT_A, updated: "2026-08-12T11:00:00.000Z", decided: "2026-08-12T10:00:00.000Z" });
    expect(() => buildSqliteAgendaProjection({ db: stale, publicIdKey: PUBLIC_KEY, revision: 1 })).toThrow("stale");

    const mismatch = testDb();
    insertAgenda(mismatch, { eventId: EVENT_A, sourceObservationId: "observation-other" });
    expect(() => buildSqliteAgendaProjection({ db: mismatch, publicIdKey: PUBLIC_KEY, revision: 1 })).toThrow("source observation mismatch");
  });

  it("requires an explicit monotonic revision and canonical public times", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A });
    expect(() => buildSqliteAgendaProjection({ db, publicIdKey: PUBLIC_KEY, revision: -1 })).toThrow("revision");
    expect(() => buildSqliteAgendaProjection({ db, publicIdKey: PUBLIC_KEY, revision: 1, observedAt: "2026-08-12" })).toThrow("canonical observedAt");
  });

  it("derives observedAt from the newest source timestamp and rejects stale caller values", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A, updated: "2026-08-12T10:00:00.000Z" });
    insertAgenda(db, { eventId: EVENT_B, updated: "2026-08-12T10:05:00.000Z", category: "french" });
    expect(buildSqliteAgendaProjection({ db, publicIdKey: PUBLIC_KEY, revision: 1 }).observedAt).toBe("2026-08-12T10:05:00.000Z");
    expect(() => buildSqliteAgendaProjection({
      db,
      publicIdKey: PUBLIC_KEY,
      revision: 2,
      observedAt: "2026-08-12T10:04:00.000Z"
    })).toThrow("newest source observation");
  });

  it("rejects source timestamps beyond the explicit future skew", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A, updated: "2026-08-12T11:00:00.000Z" });
    expect(() => buildSqliteAgendaProjection({
      db,
      publicIdKey: PUBLIC_KEY,
      revision: 1,
      observedAt: "2026-08-12T11:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:00.000Z")
    })).toThrow("too far in the future");
  });

  it("rejects missing or invalid source timestamps instead of falling back to epoch", () => {
    const db = testDb();
    insertAgenda(db, { eventId: EVENT_A });
    db.prepare("UPDATE discord_scheduled_event_observations_current SET last_observed_at = ''").run();
    expect(() => buildSqliteAgendaProjection({ db, publicIdKey: PUBLIC_KEY, revision: 1 })).toThrow("source observation timestamp");
  });
});

function buildSqliteAgendaProjection(options: SqliteAgendaProjectionOptions): ReturnType<typeof assembleSqliteAgendaProjection> {
  return assembleSqliteAgendaProjection({ now: TEST_NOW, ...options });
}

function testDb() {
  const db = createSqliteConnection(":memory:");
  runMigrations(db);
  dbs.push(db);
  return db;
}

function insertAgenda(
  db: ReturnType<typeof createSqliteConnection>,
  options: {
    eventId: string;
    category?: string;
    state?: "pending" | "approved" | "withdrawn";
    approvalState?: "pending" | "approved" | "withdrawn";
    sourceObservationId?: string;
    start?: string;
    updated?: string;
    decided?: string;
  }
): void {
  const category = options.category ?? "english";
  const labels: Record<string, { programKey: string; seriesKey: string | null; title: string; summary: string }> = {
    english: { programKey: "english-study-club", seriesKey: null, title: "English Study Club", summary: "A supportive English practice session for learners." },
    french: { programKey: "french-study-club", seriesKey: null, title: "French Study Club", summary: "A practical French practice session for learners." },
    unknown: { programKey: "unknown", seriesKey: null, title: "Internal staff notes", summary: "private" }
  };
  const label = labels[category] ?? labels.unknown;
  const state = options.state ?? "approved";
  const approvalState = options.approvalState ?? "approved";
  const start = options.start ?? "2026-08-20T04:00:00.000Z";
  const updated = options.updated ?? "2026-08-12T10:00:00.000Z";
  const decided = options.decided ?? "2026-08-12T10:30:00.000Z";
  const observationId = options.sourceObservationId ?? `observation-${options.eventId}`;
  const currentObservationId = `observation-${options.eventId}`;
  const agendaId = `agenda-${options.eventId}`;

  db.prepare(`INSERT INTO discord_scheduled_event_observation_history
    (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
     status_code, entity_type, privacy_level, normalized_title, classification_state,
     classification_category, program_key, series_key, scheduled_start_at, scheduled_end_at,
     reason_code, observation_fingerprint, created_at)
    VALUES (?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, ?, ?, NULL, 'test', ?, ?)`
  ).run(currentObservationId, options.eventId, GUILD_ID, updated, "english practice session", category, label.programKey, label.seriesKey, start, `fingerprint-${options.eventId}`, updated);
  if (observationId !== currentObservationId) {
    db.prepare(`INSERT INTO discord_scheduled_event_observation_history
      (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
       status_code, entity_type, privacy_level, normalized_title, classification_state,
       classification_category, program_key, series_key, scheduled_start_at, scheduled_end_at,
       reason_code, observation_fingerprint, created_at)
      VALUES (?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, ?, ?, NULL, 'test', ?, ?)`
    ).run(observationId, options.eventId, GUILD_ID, updated, "english practice session", category, label.programKey, label.seriesKey, start, `fingerprint-other-${options.eventId}`, updated);
  }
  db.prepare(`INSERT INTO discord_scheduled_event_observations_current
    (provider_event_id, guild_id, observation_id, first_observed_at, last_observed_at, source,
     source_version, observation_state, status_code, entity_type, privacy_level, normalized_title,
     classification_state, classification_category, program_key, series_key, scheduled_start_at,
     scheduled_end_at, reason_code, updated_at)
    VALUES (?, ?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, ?, ?, NULL, 'test', ?)`
  ).run(options.eventId, GUILD_ID, currentObservationId, updated, updated, "english practice session", category, label.programKey, label.seriesKey, start, updated);
  db.prepare(`INSERT INTO private_agenda_entries
    (id, source_provider_event_id, source_observation_id, guild_id, projection_type, title, summary,
     program_key, series_key, scheduled_start_at, scheduled_end_at, timezone, agenda_state,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, 'language_club_agenda_entry.v1', ?, ?, ?, ?, ?, NULL, 'Asia/Jakarta', ?, ?, ?)`
  ).run(agendaId, options.eventId, observationId, GUILD_ID, label.title, label.summary, label.programKey, label.seriesKey, start, state, updated, updated);
  db.prepare(`INSERT INTO publication_approvals
    (id, agenda_entry_id, projection_type, state, requested_at, requested_by, decided_at, decided_by, decision_reason)
    VALUES (?, ?, 'language_club_agenda_entry.v1', ?, ?, 'test', ?, 'operator', 'approved')`
  ).run(`approval-${agendaId}`, agendaId, approvalState, updated, state === "withdrawn" ? updated : decided);
}
