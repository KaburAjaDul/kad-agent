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
import type { PublicationMode, PublicationOutcome, PublicationReconciliationOutcome } from "./operational-metrics.js";

export type ReminderSweepResult = {
  discoveredDueReminders: number;
  jobRunId: string;
};

/**
 * Narrow seam for the publication worker. The runtime owns scheduling and
 * safety policy; the publication implementation owns reconciliation and
 * dispatch details. Keeping the payload opaque prevents logs or metrics from
 * accidentally acquiring private event content.
 */
export type PublicationJobContext = {
  now: Date;
  mode: PublicationMode;
  canDispatch: boolean;
  requestTimeoutMs?: number;
  leaseDurationMs?: number;
  leaseHeartbeatIntervalMs?: number;
  runtimeLeaseName?: string;
  runtimeOwnerId?: string;
  runtimeFencingToken?: number;
};

export type PublicationObservation = {
  reconciliationOutcome?: PublicationReconciliationOutcome;
  /** Number of redacted unknown-title rows in the latest successful sweep. */
  unknownEvents?: number;
  revision?: number;
  outboxStateCounts?: Record<string, number>;
};

export type PublicationDispatchResult = {
  outcome?: PublicationOutcome;
  revision?: number;
  outboxStateCounts?: Record<string, number>;
};

export type PublicationJob = {
  reconcile: (context: PublicationJobContext) => Promise<PublicationObservation | void>;
  dispatch?: (context: PublicationJobContext, observation: PublicationObservation | void) => Promise<PublicationDispatchResult | void>;
};

export type PublicationSweepResult = {
  mode: PublicationMode;
  observed: boolean;
  dispatched: boolean;
  reconciliationOutcome?: PublicationReconciliationOutcome;
  unknownEvents?: number;
  publicationOutcome?: PublicationOutcome;
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
      publicationMode?: PublicationMode;
      publication?: PublicationJob;
      publicationRequestTimeoutMs?: number;
      publicationLeaseDurationMs?: number;
      publicationLeaseHeartbeatIntervalMs?: number;
    } = {}
  ) {}

  async runPublicationSweep(now: Date = new Date()): Promise<PublicationSweepResult> {
    const mode = this.options.publicationMode ?? "disabled";
    this.options.metrics?.setPublicationMode(mode);
    if (mode === "disabled" || !this.options.publication) {
      this.options.metrics?.setPublicationObservationStatus("disabled");
      this.options.metrics?.recordPublicationOutcome("skipped");
      return { mode, observed: false, dispatched: false, publicationOutcome: "skipped" };
    }

    const context: PublicationJobContext = {
      now,
      mode,
      canDispatch: mode === "active"
        && this.options.mode === "operate"
        && this.options.isLeaseValid?.() !== false,
      requestTimeoutMs: this.options.publicationRequestTimeoutMs,
      leaseDurationMs: this.options.publicationLeaseDurationMs,
      leaseHeartbeatIntervalMs: this.options.publicationLeaseHeartbeatIntervalMs,
      runtimeLeaseName: this.options.runtimeLeaseName,
      runtimeOwnerId: this.options.runtimeOwnerId,
      runtimeFencingToken: this.options.runtimeFencingToken
    };
    if (!context.canDispatch && mode === "active") {
      this.options.metrics?.setPublicationObservationStatus("blocked");
      this.options.metrics?.recordPublicationOutcome("refused");
      return { mode, observed: false, dispatched: false, publicationOutcome: "refused" };
    }

    this.options.metrics?.setPublicationObservationStatus("running");
    try {
      const observation = await this.options.publication.reconcile(context);
      const reconciliationOutcome = observation?.reconciliationOutcome ?? "success";
      this.options.metrics?.recordPublicationReconciliation(reconciliationOutcome);
      this.options.metrics?.setPublicationUnknownEvents(observation?.unknownEvents ?? 0);
      if (observation?.revision !== undefined) this.options.metrics?.setPublicationRevision(observation.revision);
      if (observation?.outboxStateCounts) this.options.metrics?.setPublicationOutboxStateCounts(observation.outboxStateCounts);
      this.options.metrics?.setPublicationObservationStatus("succeeded");
      this.options.metrics?.refreshFromDatabase(this.db);

      // Observe mode deliberately has no dispatch branch. Even if a worker
      // accidentally provides a dispatch callback, it is never invoked.
      if (mode === "observe" || !this.options.publication.dispatch) {
        const outcome: PublicationOutcome = mode === "observe" ? "skipped" : "refused";
        this.options.metrics?.recordPublicationOutcome(outcome);
        return { mode, observed: true, dispatched: false, reconciliationOutcome, unknownEvents: observation?.unknownEvents ?? 0, publicationOutcome: outcome };
      }

      const dispatched = await this.options.publication.dispatch(context, observation);
      const publicationOutcome = dispatched?.outcome ?? "success";
      this.options.metrics?.recordPublicationOutcome(publicationOutcome);
      if (dispatched?.revision !== undefined) this.options.metrics?.setPublicationRevision(dispatched.revision);
      if (dispatched?.outboxStateCounts) this.options.metrics?.setPublicationOutboxStateCounts(dispatched.outboxStateCounts);
      this.options.metrics?.refreshFromDatabase(this.db);
      return { mode, observed: true, dispatched: true, reconciliationOutcome, unknownEvents: observation?.unknownEvents ?? 0, publicationOutcome };
    } catch {
      this.options.metrics?.setPublicationObservationStatus("failed");
      this.options.metrics?.recordPublicationReconciliation("failed");
      this.options.metrics?.recordPublicationOutcome("failed");
      this.options.metrics?.refreshFromDatabase(this.db);
      return { mode, observed: false, dispatched: false, reconciliationOutcome: "failed", publicationOutcome: "failed" };
    }
  }

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
