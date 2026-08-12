import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { seedFoundationData } from "../src/app/repo/seeds.js";
import { getExternalEffectIntent, recoverExpiredExternalEffectIntents } from "../src/events/repo/external-effect-intent-repo.js";
import { getLanguageClubEventById, recordLateExternalEffectReference } from "../src/events/repo/language-club-event-repo.js";
import { configureLanguageClubGuild } from "../src/events/service/language-club-guild-config-service.js";
import { upsertLanguageClubCommand } from "../src/events/service/language-club-registry-service.js";
import { createLanguageClubEvent } from "../src/events/service/create-language-club-event.js";
import { reconcileLanguageClubEventEffects } from "../src/events/service/language-club-effect-reconciliation.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";

describe("Language Club durable Discord effects", () => {
  it("reuses both succeeded references on duplicate source replay", async () => {
    const db = createConfiguredDatabase();
    let scheduledCalls = 0;
    let announcementCalls = 0;
    const publisher = {
      createScheduledEvent: async () => {
        scheduledCalls += 1;
        return { scheduledEventId: "scheduled-1" };
      },
      publishAnnouncement: async () => {
        announcementCalls += 1;
        return { messageId: "message-1" };
      }
    };

    try {
      const input = baseInput("duplicate-replay");
      const first = await createLanguageClubEvent(input, { db, publisher, effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });
      const second = await createLanguageClubEvent(input, { db, publisher, effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });

      expect(first).toMatchObject({ status: "published", discordScheduledEventId: "scheduled-1", messageId: "message-1" });
      expect(second).toMatchObject({ status: "published", discordScheduledEventId: "scheduled-1", messageId: "message-1" });
      expect(scheduledCalls).toBe(1);
      expect(announcementCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it("backfills missing reminders on a published duplicate replay without duplicates", async () => {
    const db = createConfiguredDatabase();
    const publisher = {
      createScheduledEvent: async () => ({ scheduledEventId: "scheduled-reminders" }),
      publishAnnouncement: async () => ({ messageId: "message-reminders" })
    };
    try {
      const input = baseInput("reminder-backfill");
      const first = await createLanguageClubEvent(input, { db, publisher, now: new Date("2026-04-23T10:00:00.000Z"), effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });
      if (first.status !== "published") throw new Error("Expected published");
      db.prepare("DELETE FROM event_reminders WHERE event_id = ?").run(first.eventId);
      const replay = await createLanguageClubEvent(input, { db, publisher, now: new Date("2026-04-23T10:00:10.000Z"), effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });
      expect(replay).toMatchObject({ status: "published", eventId: first.eventId });
      expect(db.prepare("SELECT COUNT(*) AS count FROM event_reminders WHERE event_id = ?").get(first.eventId)).toEqual({ count: 2 });
      await createLanguageClubEvent(input, { db, publisher, now: new Date("2026-04-23T10:00:20.000Z"), effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM event_reminders WHERE event_id = ?").get(first.eventId)).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("does not blindly retry an ambiguous Scheduled Event timeout", async () => {
    const db = createConfiguredDatabase();
    let scheduledCalls = 0;
    const publisher = {
      createScheduledEvent: async () => {
        scheduledCalls += 1;
        throw new Error("Discord request timeout after provider accepted the request");
      },
      publishAnnouncement: async () => ({ messageId: "never" })
    };

    try {
      const input = baseInput("ambiguous-timeout");
      const first = await createLanguageClubEvent(input, { db, publisher, effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 } });
      expect(first.status).toBe("publish_failed");
      if (first.status !== "publish_failed") throw new Error("Expected publish_failed");

      const intent = db.prepare("SELECT id FROM external_effect_intents WHERE kind = ? AND authority_id = ?").get("discord_scheduled_event_create", first.eventId) as { id: string };
      expect(getExternalEffectIntent(db, intent.id)?.state).toBe("needs_reconciliation");

      const repaired = await reconcileLanguageClubEventEffects({
        db,
        event: getLanguageClubEventById(db, first.eventId)!,
        publisher,
        executionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 },
        hostDiscordUserIds: [],
        now: new Date("2026-04-23T10:00:10.000Z"),
        actorDiscordUserId: "user-1"
      });
      expect(repaired.status).toBe("incomplete");
      expect(scheduledCalls).toBe(1);

    } finally {
      db.close();
    }
  });

  it("repairs a retryable announcement after a restart without recreating the Scheduled Event", async () => {
    const db = createConfiguredDatabase();
    let scheduledCalls = 0;
    let announcementCalls = 0;
    let failAnnouncement = true;
    const publisher = {
      createScheduledEvent: async () => {
        scheduledCalls += 1;
        return { scheduledEventId: "scheduled-restart" };
      },
      publishAnnouncement: async () => {
        announcementCalls += 1;
        if (failAnnouncement) {
          failAnnouncement = false;
          const error = new Error("announcement was not attempted before worker shutdown") as Error & { outcome: string };
          error.outcome = "before_call";
          throw error;
        }
        return { messageId: "message-restart" };
      }
    };

    try {
      const first = await createLanguageClubEvent(baseInput("restart-repair"), { db, publisher, effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 }, now: new Date("2026-04-23T10:00:00.000Z") });
      expect(first).toMatchObject({ status: "publish_failed", discordScheduledEventId: "scheduled-restart" });
      if (first.status !== "publish_failed") throw new Error("Expected publish_failed");

      const repaired = await reconcileLanguageClubEventEffects({
        db,
        event: getLanguageClubEventById(db, first.eventId)!,
        publisher,
        executionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 },
        hostDiscordUserIds: [],
        now: new Date("2026-04-23T10:01:00.000Z"),
        actorDiscordUserId: "repair-operator",
        confirmedScheduledEventId: "scheduled-restart"
      });

      expect(repaired).toEqual({ status: "published", scheduledEventId: "scheduled-restart", messageId: "message-restart" });
      expect(scheduledCalls).toBe(1);
      expect(announcementCalls).toBe(2);
      expect(getLanguageClubEventById(db, first.eventId)).toMatchObject({ state: "published", discordScheduledEventId: "scheduled-restart", discordAnnouncementMessageId: "message-restart" });
    } finally {
      db.close();
    }
  });

  it("rejects a stale runtime token while finalizing an already-succeeded effect", async () => {
    const db = createConfiguredDatabase();
    const publisher = {
      createScheduledEvent: async () => ({ scheduledEventId: "scheduled-stale" }),
      publishAnnouncement: async () => ({ messageId: "message-stale" })
    };

    try {
      const first = await createLanguageClubEvent(baseInput("stale-finalizer"), {
        db,
        publisher,
        now: new Date("2026-04-23T10:00:00.000Z"),
        effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 }
      });
      if (first.status !== "published") throw new Error("Expected published");
      db.prepare("UPDATE events SET discord_scheduled_event_id = NULL, state = 'drafted', published_at = NULL, discord_announcement_message_id = NULL, announcement_message_id = NULL WHERE id = ?").run(first.eventId);
      db.prepare("UPDATE runtime_leases SET expires_at = '2026-04-23T10:00:00.000Z'").run();
      acquireRuntimeLease(db, { leaseKey: "runtime", ownerId: "runtime-takeover", now: "2026-04-23T10:00:30.000Z", leaseDurationMs: 86_400_000 });

      const repaired = await reconcileLanguageClubEventEffects({
        db,
        event: getLanguageClubEventById(db, first.eventId)!,
        publisher,
        executionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 },
        hostDiscordUserIds: [],
        now: new Date("2026-04-23T10:01:00.000Z"),
        actorDiscordUserId: "repair-operator",
        confirmedScheduledEventId: "scheduled-stale"
      });
      expect(repaired.status).toBe("incomplete");
      if (repaired.status !== "incomplete") throw new Error("Expected incomplete");
      expect(repaired.reason).toContain("stale");
    } finally {
      db.close();
    }
  });

  it("retains a provider reference when the lease expires before finalization", async () => {
    const db = createConfiguredDatabase();
    const publisher = {
      createScheduledEvent: async () => {
        db.prepare("UPDATE external_effect_intents SET lease_expires_at = '2026-04-23T09:59:59.000Z' WHERE kind = 'discord_scheduled_event_create'").run();
        recoverExpiredExternalEffectIntents(db, { now: "2026-04-23T10:00:00.000Z", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 });
        db.prepare("UPDATE external_effect_intents SET state = 'needs_reconciliation', lease_owner = NULL, lease_expires_at = NULL WHERE kind = 'discord_scheduled_event_create'").run();
        return { scheduledEventId: "scheduled-late" };
      },
      publishAnnouncement: async () => ({ messageId: "never" })
    };

    try {
      const result = await createLanguageClubEvent(baseInput("late-success"), {
        db,
        publisher,
        now: new Date("2026-04-23T10:00:00.000Z"),
        effectExecutionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1, leaseDurationMs: 1 }
      });
      expect(result.status).toBe("publish_failed");
      if (result.status !== "publish_failed") throw new Error("Expected publish_failed");
      const lateIntent = db.prepare("SELECT id, fencing_token, runtime_fencing_token FROM external_effect_intents WHERE kind = ? AND authority_id = ?").get("discord_scheduled_event_create", result.eventId) as { id: string; fencing_token: number; runtime_fencing_token: number };
      recordLateExternalEffectReference(db, { effectId: lateIntent.id, externalReference: "scheduled-late", fencingToken: lateIntent.fencing_token, runtimeFencingToken: lateIntent.runtime_fencing_token, occurredAt: "2026-04-23T10:00:00.000Z", error: "late provider response" });
      expect(db.prepare("SELECT state, external_reference FROM external_effect_intents WHERE kind = ? AND authority_id = ?").get("discord_scheduled_event_create", result.eventId)).toMatchObject({ state: "needs_reconciliation", external_reference: "scheduled-late" });

      const repaired = await reconcileLanguageClubEventEffects({
        db,
        event: getLanguageClubEventById(db, result.eventId)!,
        publisher: { ...publisher, publishAnnouncement: async () => ({ messageId: "message-late" }) },
        executionContext: { ownerId: "test-language-club", runtimeLeaseName: "runtime", runtimeOwnerId: "test-language-club", runtimeFencingToken: 1 },
        hostDiscordUserIds: [],
        now: new Date("2026-04-23T10:00:01.000Z"),
        actorDiscordUserId: "operator-1",
        confirmedScheduledEventId: "scheduled-late"
      });
      expect(repaired).toEqual({ status: "published", scheduledEventId: "scheduled-late", messageId: "message-late" });
    } finally {
      db.close();
    }
  });
});

function createConfiguredDatabase() {
  const db = createSqliteConnection(":memory:");
  runMigrations(db);
  seedFoundationData(db);
  acquireRuntimeLease(db, { leaseKey: "runtime", ownerId: "test-language-club", now: "2026-04-23T10:00:00.000Z", leaseDurationMs: 86_400_000 });
  db.prepare("UPDATE runtime_leases SET expires_at = '9999-01-01T00:00:00.000Z' WHERE lease_key = 'runtime'").run();
  configureLanguageClubGuild(db, {
    guildId: "guild-1",
    announcementChannelId: "announcement-1",
    hostVoiceChannelId: "voice-1",
    defaultTimezone: "Asia/Jakarta",
    actorDiscordUserId: "admin-1",
    staffRoleIds: ["staff-role"]
  });
  upsertLanguageClubCommand(db, {
    guildId: "guild-1",
    clubKey: "english",
    displayName: "English Club",
    defaultHostVoiceChannelId: null,
    actorDiscordUserId: "admin-1"
  });
  return db;
}

function baseInput(sourceInteractionId: string) {
  return {
    guildId: "guild-1",
    actorDiscordUserId: "user-1",
    actorRoleIds: ["staff-role"],
    sourceInteractionId,
    clubKey: "english",
    date: "2026-04-24",
    time: "19:30"
  };
}
