import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import {
  runDiscordScheduledEventObservationPeriodic,
  runDiscordScheduledEventObservationSweep
} from "../src/events/service/discord-scheduled-event-observation-sweep.js";
import type { DiscordFetch } from "../src/publication/discord-client.js";
import type { DiscordScheduledEvent } from "../src/publication/types.js";

const GUILD_ID = "123456789012345678";
const EVENT_ID = "234567890123456789";
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe("Discord scheduled-event observation sweep", () => {
  it("fetches the exact guild REST snapshot before mutating private SQLite", async () => {
    const db = testDb();
    const context = leaseContext(db);
    const urls: string[] = [];
    const order: string[] = [];
    const result = await runDiscordScheduledEventObservationSweep({
      db,
      token: "bot-token",
      guildId: GUILD_ID,
      guildName: "KaburAjaDulu",
      context,
      fetchImpl: sequenceFetch([
        [{ id: GUILD_ID, name: "KaburAjaDulu" }],
        [event()]
      ], urls, order),
      maxAttempts: 1,
      clock: () => {
        order.push("clock");
        return new Date("2026-08-12T10:00:00.000Z");
      }
    });

    expect(urls).toEqual([
      "https://discord.com/api/v10/users/@me/guilds",
      `https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events?with_user_count=false`
    ]);
    expect(result).toMatchObject({ observed: 1, present: 1, pendingAgendaEntries: 1, observedAt: "2026-08-12T10:00:00.000Z" });
    expect(order).toEqual(["rest", "rest", "clock"]);
    expect(db.prepare("SELECT last_observed_at, updated_at FROM discord_scheduled_event_observations_current").get()).toMatchObject({
      last_observed_at: "2026-08-12T10:00:00.000Z",
      updated_at: "2026-08-12T10:00:00.000Z"
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observations_current").get()).toMatchObject({ count: 1 });
  });

  it.each([
    ["REST failure", [[{ id: GUILD_ID, name: "KaburAjaDulu" }], { status: 503, body: { error: "unavailable" } }]],
    ["guild identity mismatch", [[{ id: GUILD_ID, name: "Other Guild" }], []]],
    ["event schema failure", [[{ id: GUILD_ID, name: "KaburAjaDulu" }], [{ ...event(), unsupported: true }]]],
    ["event guild identity mismatch", [[{ id: GUILD_ID, name: "KaburAjaDulu" }], [{ ...event(), guild_id: EVENT_ID }]]],
    ["duplicate event identity", [[{ id: GUILD_ID, name: "KaburAjaDulu" }], [event(), event()]]],
    ["unknown event classification", [[{ id: GUILD_ID, name: "KaburAjaDulu" }], [{ ...event(), name: "Japanese for beginner N5 — near miss" }]]]
  ] as const)("fails closed on %s before any SQLite mutation", async (_label, bodies) => {
    const db = testDb();
    const context = leaseContext(db);
    const fetchImpl = sequenceFetch(bodies);

    await expect(runDiscordScheduledEventObservationSweep({
      db,
      token: "bot-token",
      guildId: GUILD_ID,
      guildName: "KaburAjaDulu",
      context,
      fetchImpl,
      maxAttempts: 1,
      clock: () => new Date("2026-08-12T10:00:00.000Z")
    })).rejects.toThrow();

    expect(db.prepare("SELECT COUNT(*) AS count FROM discord_scheduled_event_observations_current").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 0 });
  });

  it("runs a bounded sequence of complete snapshots and aggregates counts without a trailing sleep", async () => {
    const db = testDb();
    const context = leaseContext(db);
    const sleeps: number[] = [];
    const result = await runDiscordScheduledEventObservationPeriodic({
      db,
      token: "bot-token",
      guildId: GUILD_ID,
      guildName: "KaburAjaDulu",
      context,
      intervalMs: 4_000,
      maxSweeps: 2,
      fetchImpl: sequenceFetch([
        [{ id: GUILD_ID, name: "KaburAjaDulu" }],
        [event()],
        [{ id: GUILD_ID, name: "KaburAjaDulu" }],
        []
      ]),
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      maxAttempts: 1,
      clock: () => new Date("2026-08-12T10:00:00.000Z")
    });

    expect(result).toMatchObject({ observed: 1, present: 1, disappeared: 1, pendingAgendaEntries: 1, lastObservedAt: "2026-08-12T10:00:00.000Z" });
    expect(sleeps).toEqual([4_000]);
  });

  it("rejects an invalid target before touching the REST client", async () => {
    const db = testDb();
    const context = leaseContext(db);
    let calls = 0;
    const fetchImpl: DiscordFetch = async () => {
      calls += 1;
      return new Response("[]");
    };

    await expect(runDiscordScheduledEventObservationSweep({
      db,
      token: "bot-token",
      guildId: "not-a-snowflake",
      guildName: "KaburAjaDulu",
      context,
      fetchImpl
    })).rejects.toThrow("target guild ID");
    expect(calls).toBe(0);
  });
});

function testDb() {
  const db = createSqliteConnection(":memory:");
  dbs.push(db);
  runMigrations(db);
  return db;
}

function leaseContext(db: ReturnType<typeof createSqliteConnection>) {
  const lease = acquireRuntimeLease(db, { ownerId: "sweep-test", now: "2026-08-12T10:00:00.000Z", leaseDurationMs: 600_000 });
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

type ResponseSpec = { status: number; body: unknown };

function isResponseSpec(value: unknown): value is ResponseSpec {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function sequenceFetch(
  bodies: readonly unknown[],
  urls: string[] = [],
  activity: string[] = []
): DiscordFetch {
  let index = 0;
  return async (input) => {
    activity.push("rest");
    urls.push(String(input));
    const body = bodies[index++];
    if (isResponseSpec(body)) {
      return new Response(JSON.stringify(body.body), { status: body.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(body ?? []), { status: 200, headers: { "content-type": "application/json" } });
  };
}
