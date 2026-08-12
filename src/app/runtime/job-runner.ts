import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../repo/sqlite.js";
import { listDuePendingReminderJobs } from "../../events/repo/event-reminder-repo.js";
import { recoverExpiredExternalEffectIntents } from "../../events/repo/external-effect-intent-repo.js";
import {
  deliverDueEventReminders,
  type ReminderDiscordPublisher,
  type ReminderDeliverySweepResult
} from "../../events/service/reminder-delivery-service.js";
import type { OperationalMetrics } from "./operational-metrics.js";

export type ReminderSweepResult = {
  discoveredDueReminders: number;
  jobRunId: string;
};

export class BackgroundJobRunner {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: {
      mode?: "observe" | "operate";
      metrics?: OperationalMetrics;
      isLeaseValid?: () => boolean;
      ownerId?: string;
      runtimeLeaseName?: string;
      runtimeOwnerId?: string;
      runtimeFencingToken?: number;
      leaseDurationMs?: number;
      heartbeatIntervalMs?: number;
    } = {}
  ) {}

  runReminderSweep(now: Date = new Date()): ReminderSweepResult {
    const nowIso = now.toISOString();
    const dueReminders = listDuePendingReminderJobs(this.db, nowIso);
    const jobRunId = randomUUID();

    if (this.options.mode !== "observe") {
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
      this.options.metrics?.recordJobSweep(dueReminders.length > 0 ? "noop" : "completed");
      this.options.metrics?.refreshFromDatabase(this.db);
    }

    return {
      discoveredDueReminders: dueReminders.length,
      jobRunId
    };
  }

  async deliverReminderSweep(publisher: ReminderDiscordPublisher, now: Date = new Date()): Promise<ReminderDeliverySweepResult> {
    const nowIso = now.toISOString();
    if (this.options.mode === "observe" || this.options.isLeaseValid?.() === false) {
      const result = { discoveredDueReminders: listDuePendingReminderJobs(this.db, nowIso).length, delivered: 0, failed: 0 };
      this.options.metrics?.recordJobSweep("noop");
      this.options.metrics?.refreshFromDatabase(this.db);
      return result;
    }
    if (!this.options.runtimeLeaseName || !this.options.runtimeOwnerId || !this.options.runtimeFencingToken) {
      throw new Error("Runtime lease context is required for operate-mode reminder delivery.");
    }
    recoverExpiredExternalEffectIntents(this.db, {
      now,
      runtimeLeaseName: this.options.runtimeLeaseName,
      runtimeOwnerId: this.options.runtimeOwnerId,
      runtimeFencingToken: this.options.runtimeFencingToken
    });
    const result = await deliverDueEventReminders(this.db, publisher, {
      now,
      ownerId: this.options.runtimeOwnerId,
      runtimeLeaseName: this.options.runtimeLeaseName,
      runtimeOwnerId: this.options.runtimeOwnerId,
      runtimeFencingToken: this.options.runtimeFencingToken,
      leaseDurationMs: this.options.leaseDurationMs,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs
    });
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
        "reminder_delivery_sweep",
        `reminder_delivery_sweep:${nowIso}`,
        result.failed > 0 ? "completed_with_failures" : "completed",
        nowIso,
        nowIso,
        `due_reminders=${result.discoveredDueReminders};delivered=${result.delivered};failed=${result.failed}`,
        null
      );

    this.options.metrics?.recordJobSweep(result.failed > 0 ? "completed_with_failures" : "completed");
    this.options.metrics?.refreshFromDatabase(this.db);

    return result;
  }
}
