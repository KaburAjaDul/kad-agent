import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { seedFoundationData } from "../src/app/repo/seeds.js";
import { BackgroundJobRunner } from "../src/app/runtime/job-runner.js";
import { classifyEventTemplate } from "../src/events/service/classify-event-template.js";
import {
  claimReminderJobLease,
  insertReminderJob,
  listDuePendingReminderJobs,
  markReminderJobSent,
  resolveReminderJobReconciliation,
  recoverExpiredSendingReminderJobs
} from "../src/events/repo/event-reminder-repo.js";
import { buildReminderJobRecord } from "../src/events/service/reminder-job-factory.js";
import { deliverDueEventReminders } from "../src/events/service/reminder-delivery-service.js";

describe("event policy classification", () => {
  it("allows only the seeded language club template in E1", () => {
    expect(classifyEventTemplate("language_club_default")).toMatchObject({
      approvalClass: "routine_auto_publish",
      eventType: "language_club",
      classification: "routine_language_club"
    });

    expect(classifyEventTemplate("cerita_aja_dulu_featured")).toMatchObject({
      approvalClass: "hard_stop"
    });

    expect(classifyEventTemplate("unsupported_custom_template")).toMatchObject({
      approvalClass: "hard_stop"
    });
  });

  it("delivers due assigned club reminders idempotently, stores message IDs, and records failures", async () => {
    const db = createSqliteConnection(":memory:");
    const sentMessages: Array<{ channelId: string; content: string }> = [];

    try {
      runMigrations(db);
      seedFoundationData(db);
      const runtimeA = acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker-a", now: "2026-04-24T11:30:00.000Z", leaseDurationMs: 3_600_000 });
      insertTestEvent(db, "event_1");
      insertTestEvent(db, "event_2");

      const dueReminder = buildReminderJobRecord({
        eventId: "event_1",
        reminderType: "t_minus_1h",
        audienceKind: "attendee",
        scheduledFor: "2026-04-24T11:30:00.000Z",
        payload: {
          targetChannelId: "announcement-1",
          languageClubDisplayName: "English Club",
          scheduledStartAt: "2026-04-24T12:30:00.000Z",
          hostVoiceChannelId: "voice-1"
        },
        now: new Date("2026-04-23T10:00:00.000Z")
      });
      const failingReminder = buildReminderJobRecord({
        eventId: "event_2",
        reminderType: "t_minus_24h",
        audienceKind: "attendee",
        scheduledFor: "2026-04-24T11:00:00.000Z",
        payload: {},
        now: new Date("2026-04-23T10:00:00.000Z")
      });

      insertReminderJob(db, dueReminder);
      insertReminderJob(db, failingReminder);

      let releasePublisher: (() => void) | undefined;
      const publisherGate = new Promise<void>((resolve) => {
        releasePublisher = resolve;
      });
      const firstSweepPromise = deliverDueEventReminders(
        db,
        {
          publishReminder: async (payload) => {
            sentMessages.push(payload);
            await publisherGate;
            return { messageId: "message-1" };
          }
        },
        { now: new Date("2026-04-24T11:31:00.000Z"), ownerId: "reminder-delivery", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: runtimeA?.fencingToken ?? 0 }
      );
      const concurrentSweep = await deliverDueEventReminders(
        db,
        {
          publishReminder: async (payload) => {
            sentMessages.push(payload);
            return { messageId: "message-concurrent-duplicate" };
          }
        },
        { now: new Date("2026-04-24T11:31:30.000Z"), ownerId: "reminder-delivery", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: runtimeA?.fencingToken ?? 0 }
      );
      releasePublisher?.();
      const firstSweep = await firstSweepPromise;
      const repeatedSweep = await deliverDueEventReminders(
        db,
        {
          publishReminder: async (payload) => {
            sentMessages.push(payload);
            return { messageId: "message-repeated-duplicate" };
          }
        },
        { now: new Date("2026-04-24T11:32:00.000Z"), ownerId: "reminder-delivery", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: runtimeA?.fencingToken ?? 0 }
      );
      const rows = db
        .prepare("SELECT id, state, discord_message_id, delivered_at, delivery_error FROM event_reminders ORDER BY id ASC")
        .all() as Array<{
        id: string;
        state: string;
        discord_message_id: string | null;
        delivered_at: string | null;
        delivery_error: string | null;
      }>;

      expect(firstSweep).toEqual({ discoveredDueReminders: 2, delivered: 1, failed: 1 });
      expect(concurrentSweep).toEqual({ discoveredDueReminders: 0, delivered: 0, failed: 0 });
      expect(repeatedSweep).toEqual({ discoveredDueReminders: 0, delivered: 0, failed: 0 });
      expect(sentMessages).toEqual([
        {
          channelId: "announcement-1",
          content: expect.stringContaining("English Club")
        }
      ]);
      expect(sentMessages[0]?.content).toContain("2026-04-24T12:30:00.000Z");
      expect(sentMessages[0]?.content).toContain("<#voice-1>");
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: dueReminder.id,
            state: "sent",
            discord_message_id: "message-1",
            delivered_at: "2026-04-24T11:31:00.000Z"
          }),
          expect.objectContaining({
            id: failingReminder.id,
            state: "send_failed",
            delivery_error: "Reminder payload is missing targetChannelId."
          })
        ])
      );
    } finally {
      db.close();
    }
  });

  it("redacts and bounds provider failures in reminder storage", async () => {
    const db = createSqliteConnection(":memory:");
    const providerError = `Bearer abc.secret.value?token=private 123456789012345678 ${"provider-detail ".repeat(60)}`;

    try {
      runMigrations(db);
      seedFoundationData(db);
      const runtime = acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker", now: "2026-04-24T11:31:00.000Z", leaseDurationMs: 3_600_000 });
      insertTestEvent(db, "event_redaction");

      const reminder = buildReminderJobRecord({
        eventId: "event_redaction",
        reminderType: "t_minus_1h",
        audienceKind: "attendee",
        scheduledFor: "2026-04-24T11:30:00.000Z",
        payload: { targetChannelId: "announcement-1" },
        now: new Date("2026-04-23T10:00:00.000Z")
      });
      insertReminderJob(db, reminder);

      const result = await deliverDueEventReminders(
        db,
        {
          publishReminder: async () => {
            throw new Error(providerError);
          }
        },
        { now: new Date("2026-04-24T11:31:00.000Z"), ownerId: "reminder-delivery", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", runtimeFencingToken: runtime?.fencingToken ?? 0 }
      );
      const row = db
        .prepare("SELECT delivery_error FROM event_reminders WHERE id = ?")
        .get(reminder.id) as { delivery_error: string | null };

      expect(result).toEqual({ discoveredDueReminders: 1, delivered: 0, failed: 1 });
      expect(row.delivery_error).toBeTypeOf("string");
      expect(row.delivery_error).not.toContain("abc.secret.value");
      expect(row.delivery_error).not.toContain("private");
      expect(row.delivery_error).not.toContain("123456789012345678");
      expect(row.delivery_error?.length ?? 0).toBeLessThanOrEqual(500);
    } finally {
      db.close();
    }
  });

  it("moves a late Discord success to reconciliation instead of claiming delivery", async () => {
    const db = createSqliteConnection(":memory:");

    try {
      runMigrations(db);
      seedFoundationData(db);
      const runtime = acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker-a", now: "2026-04-24T11:31:00.000Z", leaseDurationMs: 3_600_000 });
      insertTestEvent(db, "event_late_success");
      const reminder = buildReminderJobRecord({
        eventId: "event_late_success",
        reminderType: "t_minus_1h",
        audienceKind: "attendee",
        scheduledFor: "2026-04-24T11:30:00.000Z",
        payload: { targetChannelId: "announcement-1" },
        now: new Date("2026-04-23T10:00:00.000Z")
      });
      insertReminderJob(db, reminder);

      const times = [
        new Date("2026-04-24T11:31:00.000Z"),
        new Date("2026-04-24T11:31:00.100Z")
      ];
      const result = await deliverDueEventReminders(
        db,
        { publishReminder: async () => ({ messageId: "message-after-expiry" }) },
        {
          now: () => times.shift() ?? new Date("2026-04-24T11:31:00.100Z"),
          ownerId: "worker-a",
          runtimeLeaseName: "test-runtime",
          runtimeOwnerId: "worker-a",
          runtimeFencingToken: runtime?.fencingToken ?? 0,
          leaseDurationMs: 50
        }
      );
      const row = db.prepare(
        "SELECT state, discord_message_id, delivered_at, needs_reconciliation_at FROM event_reminders WHERE id = ?"
      ).get(reminder.id);

      expect(result).toEqual({ discoveredDueReminders: 1, delivered: 0, failed: 1 });
      expect(row).toEqual({
        state: "needs_reconciliation",
        discord_message_id: "message-after-expiry",
        delivered_at: null,
        needs_reconciliation_at: "2026-04-24T11:31:00.100Z"
      });
    } finally {
      db.close();
    }
  });

  it("fences a stale reminder finalizer after recovery and takeover", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      seedFoundationData(db);
      const runtimeA = acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker-a", now: "2026-04-24T11:30:00.000Z", leaseDurationMs: 100 });
      insertTestEvent(db, "event_fenced_reminder");
      const reminder = buildReminderJobRecord({
        eventId: "event_fenced_reminder",
        reminderType: "event_start",
        audienceKind: "staff",
        scheduledFor: "2026-04-24T11:30:00.000Z",
        payload: { targetChannelId: "announcement-1" },
        now: new Date("2026-04-23T10:00:00.000Z")
      });
      insertReminderJob(db, reminder);
      const leaseA = claimReminderJobLease(db, reminder.id, "2026-04-24T11:30:00.000Z", { ownerId: "worker-a", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: runtimeA?.fencingToken ?? 0, leaseDurationMs: 10_000 });
      expect(leaseA?.fencingToken).toBe(1);
      const runtimeB = acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker-b", now: "2026-04-24T11:30:00.101Z", leaseDurationMs: 10_000 });
      expect(runtimeB?.fencingToken).toBe(2);
      expect(markReminderJobSent(db, reminder.id, "2026-04-24T11:30:00.102Z", "stale", { ownerId: "worker-a", fencingToken: leaseA?.fencingToken ?? 0, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: runtimeA?.fencingToken ?? 0 })).toBe(false);
      expect(markReminderJobSent(db, reminder.id, "2026-04-24T11:30:00.103Z", "stale-b", { ownerId: "worker-a", fencingToken: leaseA?.fencingToken ?? 0, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker-b", runtimeFencingToken: runtimeB?.fencingToken ?? 0 })).toBe(false);
    } finally {
      db.close();
    }
  });
});

function insertTestEvent(db: ReturnType<typeof createSqliteConnection>, eventId: string): void {
  db.prepare(
    `
      INSERT INTO events (
        id,
        guild_id,
        template_id,
        template_key,
        template_version,
        title,
        description,
        state,
        event_type,
        approval_class,
        classification,
        announcement_channel_id,
        host_voice_channel_id,
        scheduling_scope_key,
        timezone,
        scheduled_start_at,
        scheduled_end_at,
        target_channel_id,
        announcement_message_id,
        published_at,
        created_by_discord_user_id,
        source_interaction_id,
        drafted_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    eventId,
    "guild_1",
    "0195c2c0-0000-7000-8000-000000000001",
    "language_club_default",
    1,
    "Weekly Language Club",
    "Foundation test event",
    "published",
    "language_club",
    "routine_auto_publish",
    "routine_language_club",
    "channel_announcement_1",
    "channel_voice_1",
    eventId,
    "Asia/Jakarta",
    "2026-04-24T12:00:00.000Z",
    "2026-04-24T13:30:00.000Z",
    "channel_announcement_1",
    null,
    null,
    "user_1",
    `interaction_${eventId}`,
    "2026-04-23T10:00:00.000Z",
    "2026-04-23T10:00:00.000Z",
    "2026-04-23T10:00:00.000Z"
  );
}

describe("reminder job foundation", () => {
  it("represents one routine reminder in storage and the job runner can discover it", () => {
    const db = createSqliteConnection(":memory:");

    try {
      runMigrations(db);
      seedFoundationData(db);

      db.prepare(
        `
          INSERT INTO events (
            id,
            guild_id,
            template_id,
            template_key,
            template_version,
            title,
            description,
            state,
            event_type,
            approval_class,
            classification,
            announcement_channel_id,
            host_voice_channel_id,
            scheduling_scope_key,
            timezone,
            scheduled_start_at,
            scheduled_end_at,
            target_channel_id,
            announcement_message_id,
            published_at,
            created_by_discord_user_id,
            source_interaction_id,
            drafted_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        "event_1",
        "guild_1",
        "0195c2c0-0000-7000-8000-000000000001",
        "language_club_default",
        1,
        "Weekly Language Club",
        "Foundation test event",
        "draft",
        "language_club",
        "routine_auto_publish",
        "routine_language_club",
        "channel_announcement_1",
        "channel_voice_1",
        "language_club_default",
        "Asia/Jakarta",
        "2026-04-24T12:00:00.000Z",
        "2026-04-24T13:30:00.000Z",
        "channel_announcement_1",
        null,
        null,
        "user_1",
        "interaction_1",
        "2026-04-23T10:00:00.000Z",
        "2026-04-23T10:00:00.000Z",
        "2026-04-23T10:00:00.000Z"
      );

      const reminderJob = buildReminderJobRecord({
        eventId: "event_1",
        reminderType: "event_start",
        audienceKind: "staff",
        scheduledFor: "2026-04-23T10:05:00.000Z",
        payload: {
          note: "Routine reminder foundation coverage"
        },
        now: new Date("2026-04-23T10:00:00.000Z")
      });

      insertReminderJob(db, reminderJob);

      const dueReminders = listDuePendingReminderJobs(db, "2026-04-23T10:10:00.000Z");
      const runner = new BackgroundJobRunner(db);
      const sweepResult = runner.runReminderSweep(new Date("2026-04-23T10:10:00.000Z"));
      const jobRunCount = Number(
        (db.prepare("SELECT COUNT(*) as count FROM job_runs").get() as { count: number } | undefined)?.count ?? 0
      );

      expect(dueReminders).toHaveLength(1);
      expect(dueReminders[0]).toMatchObject({
        eventId: "event_1",
        reminderType: "event_start",
        audienceKind: "staff",
        state: "pending"
      });
      expect(reminderJob.jobKey).toBe("event_reminder:event_1:event_start:staff:2026-04-23T10:05:00.000Z");
      expect(sweepResult.discoveredDueReminders).toBe(1);
      expect(jobRunCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("schedules reminder rows idempotently by generated reminder key", () => {
    const db = createSqliteConnection(":memory:");

    try {
      runMigrations(db);
      seedFoundationData(db);
      insertTestEvent(db, "event_1");

      const reminderJob = buildReminderJobRecord({
        eventId: "event_1",
        reminderType: "t_minus_1h",
        audienceKind: "attendee",
        scheduledFor: "2026-04-24T11:30:00.000Z",
        payload: { targetChannelId: "announcement-1" },
        now: new Date("2026-04-23T10:00:00.000Z")
      });

      insertReminderJob(db, reminderJob);
      insertReminderJob(db, reminderJob);

      const reminderCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM event_reminders WHERE event_id = ? AND job_key = ?").get(
          "event_1",
          reminderJob.jobKey
        ) as { count: number } | undefined)?.count ?? 0
      );

      expect(reminderCount).toBe(1);
    } finally {
      db.close();
    }
  });
});
