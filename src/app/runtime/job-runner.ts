import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../repo/sqlite.js";
import { listDuePendingReminderJobs } from "../../events/repo/event-reminder-repo.js";

export type ReminderSweepResult = {
  discoveredDueReminders: number;
  jobRunId: string;
};

export class BackgroundJobRunner {
  constructor(private readonly db: SqliteDatabase) {}

  runReminderSweep(now: Date = new Date()): ReminderSweepResult {
    const nowIso = now.toISOString();
    const dueReminders = listDuePendingReminderJobs(this.db, nowIso);
    const jobRunId = randomUUID();

    this.db
      .prepare(
        `
          INSERT INTO job_runs (
            id,
            job_name,
            job_key,
            state,
            started_at,
            finished_at,
            result_summary,
            error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        jobRunId,
        "reminder_sweep",
        `reminder_sweep:${nowIso}`,
        dueReminders.length > 0 ? "noop" : "completed",
        nowIso,
        nowIso,
        `due_reminders=${dueReminders.length};delivery=deferred_until_event_slice`,
        null
      );

    return {
      discoveredDueReminders: dueReminders.length,
      jobRunId
    };
  }
}
