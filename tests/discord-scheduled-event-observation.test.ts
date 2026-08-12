import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { reconcileDiscordScheduledEventObservations } from "../src/events/service/discord-scheduled-event-observation-service.js";
import type { DiscordScheduledEvent } from "../src/publication/types.js";

const GUILD_ID = "123456789012345678";
const EVENT_ID = "234567890123456789";
const EVENT_ID_2 = "334567890123456789";
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe("Discord scheduled event observation reconciliation", () => {
  it("imports an allowlisted event, updates it idempotently, and keeps approval pending", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    const first = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    expect(first).toMatchObject({ observed: 1, present: 1, unknown: 0, rejected: 0, pendingAgendaEntries: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toMatchObject({ state: "pending" });
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'approved'").run();
    db.prepare("UPDATE publication_approvals SET state = 'approved', requested_at = '2026-08-12T09:00:00.000Z', decided_at = '2026-08-12T09:30:00.000Z', decided_by = 'operator-1', decision_reason = 'initial approval'").run();

    const second = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:00:30.000Z",
      now: () => new Date("2026-08-12T10:00:02.000Z")
    });
    expect(second.observed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT last_observed_at FROM discord_scheduled_event_observations_current").get()).toMatchObject({ last_observed_at: "2026-08-12T10:00:30.000Z" });
    expect(db.prepare("SELECT agenda_state, updated_at FROM private_agenda_entries").get()).toEqual({
      agenda_state: "approved",
      updated_at: "2026-08-12T10:00:01.000Z"
    });
    expect(db.prepare("SELECT state, decided_at FROM publication_approvals").get()).toEqual({
      state: "approved",
      decided_at: "2026-08-12T09:30:00.000Z"
    });

    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID, scheduled_start_time: "2026-08-20T11:00:00.000Z", scheduled_end_time: "2026-08-20T12:00:00.000Z" })],
      context,
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT scheduled_start_at FROM private_agenda_entries").get()).toMatchObject({ scheduled_start_at: "2026-08-20T11:00:00.000Z" });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toMatchObject({ agenda_state: "pending" });
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toMatchObject({ state: "pending" });
    expect(db.prepare("SELECT requested_at, decided_at, decided_by, decision_reason FROM publication_approvals").get()).toEqual({
      requested_at: "2026-08-12T10:01:01.000Z",
      decided_at: null,
      decided_by: null,
      decision_reason: null
    });

    const disappeared = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [],
      context,
      observedAt: "2026-08-12T10:02:00.000Z",
      now: () => new Date("2026-08-12T10:02:01.000Z")
    });
    expect(disappeared.disappeared).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 3 });

    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:03:00.000Z",
      now: () => new Date("2026-08-12T10:03:01.000Z")
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 4 });
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:04:00.000Z",
      now: () => new Date("2026-08-12T10:04:01.000Z")
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 4 });
  });

  it("rejects the entire snapshot when an unknown event is present and preserves the approved last-known-good row", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'approved'").run();
    db.prepare("UPDATE publication_approvals SET state = 'approved'").run();

    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID_2, name: "Japanese for beginner N5 — near miss" })],
      context,
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    })).toThrow("snapshot rejected");
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toMatchObject({ agenda_state: "approved" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT observation_state FROM discord_scheduled_event_observations_current WHERE provider_event_id = ?").get(EVENT_ID)).toMatchObject({ observation_state: "present" });
  });

  it("fails closed for an exact-title near miss without storing the title or approval", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID, name: "Japanese for beginner N5 — extra" })],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    })).toThrow("snapshot rejected");
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observations_current").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM publication_approvals").get()).toMatchObject({ count: 0 });
  });

  it("records a mixed known/unknown observe snapshot redacted, idempotently, and without approvals for unknowns", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    const known = Array.from({ length: 10 }, (_, index) => event({ id: discordId(10 + index) }));
    const unknown = Array.from({ length: 3 }, (_, index) => event({
      id: discordId(30 + index),
      name: `private raw title ${index}`
    }));
    const events = [...known, ...unknown];

    const first = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events,
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    expect(first).toMatchObject({ observed: 13, present: 13, unknown: 3, rejected: 3, pendingAgendaEntries: 10 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 13 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 10 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM publication_approvals").get()).toMatchObject({ count: 10 });
    const unknownRows = db.prepare(
      "SELECT normalized_title, classification_state, classification_category, program_key, series_key, scheduled_start_at, reason_code FROM discord_scheduled_event_observations_current WHERE classification_state = 'unknown' ORDER BY provider_event_id"
    ).all() as Array<Record<string, unknown>>;
    expect(unknownRows).toHaveLength(3);
    expect(unknownRows).toEqual([
      {
        normalized_title: null,
        classification_state: "unknown",
        classification_category: null,
        program_key: null,
        series_key: null,
        scheduled_start_at: "2026-08-20T10:00:00.000Z",
        reason_code: "unknown_event_title"
      },
      {
        normalized_title: null,
        classification_state: "unknown",
        classification_category: null,
        program_key: null,
        series_key: null,
        scheduled_start_at: "2026-08-20T10:00:00.000Z",
        reason_code: "unknown_event_title"
      },
      {
        normalized_title: null,
        classification_state: "unknown",
        classification_category: null,
        program_key: null,
        series_key: null,
        scheduled_start_at: "2026-08-20T10:00:00.000Z",
        reason_code: "unknown_event_title"
      }
    ]);
    expect(JSON.stringify(unknownRows)).not.toContain("private raw title");

    const second = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events,
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    });
    expect(second).toMatchObject({ observed: 13, unknown: 3, rejected: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 13 });
  });

  it("withdraws a previously allowlisted source when its title becomes unknown in shadow mode", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event()],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'approved'").run();
    db.prepare("UPDATE publication_approvals SET state = 'approved', decided_at = '2026-08-12T10:00:02.000Z', decided_by = 'operator', decision_reason = 'approved'").run();

    const changed = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ name: "Japanese for beginner N5 — unknown revision" })],
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    });
    expect(changed).toMatchObject({ unknown: 1, withdrawnAgendaEntries: 1 });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "withdrawn" });
    expect(db.prepare("SELECT state, decision_reason FROM publication_approvals").get()).toEqual({ state: "withdrawn", decision_reason: "source_withdrawn" });

    const repeated = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ name: "Japanese for beginner N5 — unknown revision" })],
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:02:00.000Z",
      now: () => new Date("2026-08-12T10:02:01.000Z")
    });
    expect(repeated.withdrawnAgendaEntries).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 2 });
  });

  it("records a valid active Discord event with an unknown title in shadow mode", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    const result = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID_2, status: 2, name: "active event title pending review" })],
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    expect(result).toMatchObject({ observed: 1, present: 1, unknown: 1, rejected: 1, pendingAgendaEntries: 0 });
    expect(db.prepare("SELECT status_code, observation_state, classification_state, normalized_title FROM discord_scheduled_event_observations_current").get()).toEqual({
      status_code: 2,
      observation_state: "present",
      classification_state: "unknown",
      normalized_title: null
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM publication_approvals").get()).toMatchObject({ count: 0 });
  });

  it("withdraws an unknown source when it disappears and rejects invalid or terminal unknowns before transaction", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ name: "unknown title" })],
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    const disappeared = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [],
      context,
      unknownTitlePolicy: "record_shadow",
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    });
    expect(disappeared.disappeared).toBe(1);
    expect(db.prepare("SELECT observation_state, classification_state, normalized_title FROM discord_scheduled_event_observations_current").get()).toEqual({ observation_state: "disappeared", classification_state: "withdrawn", normalized_title: null });

    for (const invalid of [
      event({ id: "not-a-discord-id", name: "invalid identity" }),
      event({ entity_type: 1, name: "invalid boundary" }),
      event({ scheduled_end_time: "2026-08-20T09:00:00.000Z", name: "invalid schedule" }),
      event({ status: 3, name: "unknown terminal" })
    ]) {
      expect(() => reconcileDiscordScheduledEventObservations({
        db,
        guildId: GUILD_ID,
        events: [invalid],
        context,
        unknownTitlePolicy: "record_shadow",
        observedAt: "2026-08-12T10:02:00.000Z",
        now: () => new Date("2026-08-12T10:02:01.000Z")
      })).toThrow("snapshot rejected");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 2 });
  });

  it("rejects identical and conflicting duplicate Discord IDs before mutation", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'approved'").run();
    db.prepare("UPDATE publication_approvals SET state = 'approved'").run();

    const identical = [event({ id: EVENT_ID }), event({ id: EVENT_ID })];
    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: identical,
      context,
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    })).toThrow("duplicate scheduled-event identity");

    const conflicting = [event({ id: EVENT_ID }), event({ id: EVENT_ID, name: "Japanese for beginner N4" })];
    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: conflicting,
      context,
      observedAt: "2026-08-12T10:02:00.000Z",
      now: () => new Date("2026-08-12T10:02:01.000Z")
    })).toThrow("duplicate scheduled-event identity");

    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toMatchObject({ agenda_state: "approved" });
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toMatchObject({ state: "approved" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observations_current").get()).toMatchObject({ count: 1 });
  });

  it("records completed events as tombstones and missing events as disappeared", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID }), event({ id: EVENT_ID_2, name: "English practice session" })],
      context,
      observedAt: "2026-08-12T10:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    });
    db.prepare("UPDATE publication_approvals SET state = 'approved', requested_at = '2026-08-12T09:00:00.000Z', decided_at = '2026-08-12T09:30:00.000Z', decided_by = 'operator-1', decision_reason = 'initial approval'").run();
    const tombstone = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID, status: 3 }), event({ id: EVENT_ID_2, name: "English practice session" })],
      context,
      observedAt: "2026-08-12T10:01:00.000Z",
      now: () => new Date("2026-08-12T10:01:01.000Z")
    });
    expect(tombstone.tombstoned).toBe(1);
    expect(db.prepare("SELECT observation_state FROM discord_scheduled_event_observations_current WHERE provider_event_id = ?").get(EVENT_ID)).toMatchObject({ observation_state: "tombstoned" });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries WHERE source_provider_event_id = ?").get(EVENT_ID)).toMatchObject({ agenda_state: "withdrawn" });
    expect(db.prepare("SELECT state FROM publication_approvals WHERE agenda_entry_id IN (SELECT id FROM private_agenda_entries WHERE source_provider_event_id = ?)").get(EVENT_ID)).toMatchObject({ state: "withdrawn" });
    expect(db.prepare("SELECT decided_at, decided_by, decision_reason FROM publication_approvals WHERE agenda_entry_id IN (SELECT id FROM private_agenda_entries WHERE source_provider_event_id = ?)").get(EVENT_ID)).toEqual({
      decided_at: "2026-08-12T10:01:01.000Z",
      decided_by: null,
      decision_reason: "source_withdrawn"
    });

    const disappeared = reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [],
      context,
      observedAt: "2026-08-12T10:02:00.000Z",
      now: () => new Date("2026-08-12T10:02:01.000Z")
    });
    expect(disappeared.disappeared).toBe(1);
    expect(db.prepare("SELECT observation_state, classification_state FROM discord_scheduled_event_observations_current WHERE provider_event_id = ?").get(EVENT_ID_2)).toMatchObject({
      observation_state: "disappeared",
      classification_state: "withdrawn"
    });
  });

  it("rejects mutations after a runtime lease takeover", () => {
    const db = testDb();
    const first = acquireRuntimeLease(db, { leaseKey: "observation-runtime", ownerId: "worker-a", now: "2026-08-12T10:00:00.000Z", leaseDurationMs: 100 });
    expect(first).not.toBeNull();
    const replacement = acquireRuntimeLease(db, { leaseKey: "observation-runtime", ownerId: "worker-b", now: "2026-08-12T10:00:00.101Z", leaseDurationMs: 60_000 });
    expect(replacement).not.toBeNull();
    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context: {
        runtimeLeaseName: "observation-runtime",
        runtimeOwnerId: "worker-a",
        runtimeFencingToken: first?.fencingToken ?? 0
      },
      observedAt: "2026-08-12T10:00:00.101Z",
      now: () => new Date("2026-08-12T10:00:00.101Z")
    })).toThrow("Runtime lease");
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observation_history").get()).toMatchObject({ count: 0 });
  });

  it("uses the trusted mutation clock for lease validity, not provider observation time", () => {
    const db = testDb();
    const context = leaseContext(db, "worker-a", "2026-08-12T10:00:00.000Z");
    expect(() => reconcileDiscordScheduledEventObservations({
      db,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context,
      observedAt: "2099-01-01T00:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:01.000Z")
    })).not.toThrow();

    const shortDb = testDb();
    const shortLease = acquireRuntimeLease(shortDb, { leaseKey: "observation-runtime", ownerId: "worker-a", now: "2026-08-12T10:00:00.000Z", leaseDurationMs: 100 });
    expect(shortLease).not.toBeNull();
    expect(() => reconcileDiscordScheduledEventObservations({
      db: shortDb,
      guildId: GUILD_ID,
      events: [event({ id: EVENT_ID })],
      context: {
        runtimeLeaseName: shortLease!.leaseKey,
        runtimeOwnerId: shortLease!.ownerId,
        runtimeFencingToken: shortLease!.fencingToken
      },
      observedAt: "1970-01-01T00:00:00.000Z",
      now: () => new Date("2026-08-12T10:00:00.101Z")
    })).toThrow("Runtime lease");
  });
});

function testDb() {
  const db = createSqliteConnection(":memory:");
  dbs.push(db);
  runMigrations(db);
  return db;
}

function leaseContext(db: ReturnType<typeof createSqliteConnection>, ownerId: string, now: string) {
  const lease = acquireRuntimeLease(db, { leaseKey: "observation-runtime", ownerId, now, leaseDurationMs: 600_000 });
  if (!lease) throw new Error("test lease unavailable");
  return { runtimeLeaseName: lease.leaseKey, runtimeOwnerId: lease.ownerId, runtimeFencingToken: lease.fencingToken };
}

function event(overrides: Partial<DiscordScheduledEvent> = {}): DiscordScheduledEvent {
  return {
    id: EVENT_ID,
    name: "Japanese for beginner N5",
    scheduled_start_time: "2026-08-20T10:00:00.000Z",
    scheduled_end_time: "2026-08-20T11:00:00.000Z",
    status: 1,
    entity_type: 3,
    privacy_level: 2,
    guild_id: GUILD_ID,
    ...overrides
  };
}

function discordId(offset: number): string {
  return String(BigInt(EVENT_ID) + BigInt(offset));
}
