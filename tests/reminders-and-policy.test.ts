import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { seedFoundationData } from "../src/app/repo/seeds.js";
import { BackgroundJobRunner } from "../src/app/runtime/job-runner.js";
import { classifyEventTemplate } from "../src/events/service/classify-event-template.js";
import { insertReminderJob, listDuePendingReminderJobs } from "../src/events/repo/event-reminder-repo.js";
import { buildReminderJobRecord } from "../src/events/service/reminder-job-factory.js";

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
});

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
        state: "scheduled"
      });
      expect(reminderJob.jobKey).toBe("event_reminder:event_1:event_start:staff:2026-04-23T10:05:00.000Z");
      expect(sweepResult.discoveredDueReminders).toBe(1);
      expect(jobRunCount).toBe(1);
    } finally {
      db.close();
    }
  });
});
