import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { foundationCommands } from "../src/discord/discord/command-catalog.js";
import { handlePublicationOperatorCommand } from "../src/publication/publication-operator-adapter.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { reconcileDiscordScheduledEventObservations } from "../src/events/service/discord-scheduled-event-observation-service.js";
import type { DiscordScheduledEvent } from "../src/publication/types.js";

const GUILD_ID = "123456789012345678";
const EVENT_ID = "234567890123456789";
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T10:00:01.000Z"));
});

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  vi.useRealTimers();
});

describe("Discord publication operator adapter", () => {
  it("registers an administrator-only guild command with bounded decision inputs", () => {
    const command = foundationCommands.find((item) => item.name === "publication");
    expect(command).toMatchObject({
      name: "publication",
      dm_permission: false,
      default_member_permissions: "8"
    });
    expect(command?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "pending", type: 1 }),
      expect.objectContaining({ name: "decide", type: 1 })
    ]));
    const commandOptions = command?.options as unknown as Array<{ name: string; options?: unknown[] }> | undefined;
    const decide = commandOptions?.find((option) => option.name === "decide");
    expect(decide?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "item", min_value: 1, max_value: 20 }),
      expect.objectContaining({ name: "reason", required: true, max_length: 1000 })
    ]));
  });

  it("lists private pending titles only to an authorized admin with an active lease", async () => {
    const db = testDb();
    const context = seedObservedEvent(db);
    const interaction = fakeInteraction("pending", {}, { administrator: true });

    await handlePublicationOperatorCommand(interaction, db, {
      mode: "active",
      allowedGuildIds: [GUILD_ID],
      getRuntimeLeaseContext: () => context
    });

    expect(interaction.messages[0]).toContain("Japanese Study Club");
    expect(interaction.messages[0]).toContain("1.");
    expect(interaction.messages[0]).not.toContain(EVENT_ID);
    expect(interaction.messages[0]).not.toContain("agenda-");
    expect(interaction.payloads[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it("resolves the current snapshot by list position and atomically invokes the approval enqueue boundary", async () => {
    const db = testDb();
    const context = seedObservedEvent(db);
    const queued: unknown[] = [];
    const interaction = fakeInteraction("decide", { item: 1, decision: "approve", reason: "Staff reviewed current public fields." }, { administrator: true });

    await handlePublicationOperatorCommand(interaction, db, {
      mode: "active",
      allowedGuildIds: [GUILD_ID],
      getRuntimeLeaseContext: () => context,
      enqueueApprovedProjection: (record) => {
        queued.push(record);
        return undefined;
      }
    });

    expect(interaction.messages[0]).toContain("approve");
    expect(queued).toHaveLength(1);
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toEqual({ state: "approved" });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "approved" });
  });

  it("fails closed when dependencies, role, or the current snapshot are unsafe", async () => {
    const db = testDb();
    const context = seedObservedEvent(db);

    const missing = fakeInteraction("pending", {}, { administrator: true });
    await handlePublicationOperatorCommand(missing, db, { allowedGuildIds: [GUILD_ID], getRuntimeLeaseContext: () => context });
    expect(missing.messages[0]).toContain("dinonaktifkan");

    const nonAdmin = fakeInteraction("pending", {}, { administrator: false });
    await handlePublicationOperatorCommand(nonAdmin, db, { mode: "active", allowedGuildIds: [GUILD_ID], getRuntimeLeaseContext: () => context });
    expect(nonAdmin.messages[0]).toContain("administrator");

    const stale = fakeInteraction("decide", { item: 1, decision: "reject", reason: "Stale source must not be decided." }, { administrator: true });
    db.prepare("UPDATE discord_scheduled_event_observations_current SET classification_state = 'unknown'").run();
    await handlePublicationOperatorCommand(stale, db, { mode: "active", allowedGuildIds: [GUILD_ID], getRuntimeLeaseContext: () => context });
    expect(stale.messages[0]).toContain("berubah");
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toEqual({ state: "pending" });
  });
});

function testDb() {
  const db = createSqliteConnection(":memory:");
  dbs.push(db);
  runMigrations(db);
  return db;
}

function seedObservedEvent(db: ReturnType<typeof createSqliteConnection>) {
  const lease = acquireRuntimeLease(db, {
    leaseKey: "publication-runtime",
    ownerId: "kaddy:test",
    now: "2026-08-12T10:00:00.000Z",
    leaseDurationMs: 600_000
  });
  if (!lease) throw new Error("test lease unavailable");
  const context = {
    runtimeLeaseName: lease.leaseKey,
    runtimeOwnerId: lease.ownerId,
    runtimeFencingToken: lease.fencingToken
  };
  reconcileDiscordScheduledEventObservations({
    db,
    guildId: GUILD_ID,
    events: [{
      id: EVENT_ID,
      name: "Japanese for beginner N5",
      scheduled_start_time: "2026-08-20T10:00:00.000Z",
      scheduled_end_time: "2026-08-20T11:00:00.000Z",
      status: 1,
      entity_type: 3,
      privacy_level: 2,
      guild_id: GUILD_ID
    } satisfies DiscordScheduledEvent],
    context,
    observedAt: "2026-08-12T10:00:00.000Z",
    now: () => new Date("2026-08-12T10:00:01.000Z")
  });
  return context;
}

function fakeInteraction(
  subcommand: string,
  values: { item?: number; decision?: string; reason?: string },
  options: { administrator: boolean }
) {
  const messages: string[] = [];
  const payloads: Array<{ allowedMentions?: unknown }> = [];
  const interaction = {
    guildId: GUILD_ID,
    user: { id: "987654321098765432" },
    memberPermissions: { has: () => options.administrator },
    options: {
      getSubcommand: () => subcommand,
      getInteger: () => values.item ?? null,
      getString: (name: string) => name === "decision" ? values.decision ?? null : values.reason ?? null
    },
    deferred: false,
    replied: false,
    reply: async (payload: { content: string; allowedMentions?: unknown }) => {
      messages.push(payload.content);
      payloads.push(payload);
    },
    followUp: async (payload: { content: string; allowedMentions?: unknown }) => {
      messages.push(payload.content);
      payloads.push(payload);
    },
    messages,
    payloads
  } as unknown as ChatInputCommandInteraction & { messages: string[]; payloads: Array<{ allowedMentions?: unknown }> };
  return interaction;
}
