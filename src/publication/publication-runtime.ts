import type { AppConfig } from "../app/config/env.js";
import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import type {
  PublicationDispatchResult,
  PublicationJob,
  PublicationJobContext,
  PublicationObservation
} from "../app/runtime/job-runner.js";
import { runDiscordScheduledEventObservationSweep } from "../events/service/discord-scheduled-event-observation-sweep.js";
import {
  recoverExpiredPublicProjectionOutbox,
  type PublicProjectionOutboxState
} from "./public-projection-outbox-repo.js";
import {
  enqueueApprovedPublicProjection,
  enqueueCurrentPublicProjection,
  type ApprovedPublicProjectionEnqueuer,
  type EnqueueApprovedPublicProjectionResult
} from "./public-projection-enqueue-service.js";
import {
  dispatchOnePublicProjection,
  readPublicProjectionHead,
  reconcilePublicProjection,
  type PublicProjectionDispatcherOptions
} from "./public-projection-dispatcher.js";
import {
  getPublicProjectionRevision,
  synchronizePublicProjectionRevisionFloor
} from "./public-projection-revision-repo.js";
import type { PublicationOperatorDependencies } from "./publication-operator-adapter.js";

const MAX_RECONCILIATIONS_PER_SWEEP = 5;

export type PublicationRuntime = {
  job: PublicationJob;
  operator: PublicationOperatorDependencies;
};

export type CreatePublicationRuntimeOptions = {
  db: SqliteDatabase;
  appConfig: AppConfig;
  context: RuntimeLeaseContext;
  isLeaseValid: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Assemble the private observation, approval, and projection workers for one
 * already-fenced Kaddy process. Disabled mode returns no runtime at all.
 */
export function createPublicationRuntime(options: CreatePublicationRuntimeOptions): PublicationRuntime | undefined {
  const publication = options.appConfig.publication;
  if (!publication || publication.mode === "disabled") return undefined;
  if (!options.appConfig.discord.botToken || !publication.targetGuildId || !publication.targetGuildName) {
    throw new Error("Publication observation requires the configured Discord bot and exact target guild identity.");
  }

  const getContext = (): RuntimeLeaseContext | null => options.isLeaseValid() ? options.context : null;
  const enqueuer = createOperatorEnqueuer(options);

  const job: PublicationJob = {
    reconcile: async (jobContext) => reconcilePublicationRuntime(options, jobContext),
    dispatch: publication.mode === "active"
      ? async (jobContext) => dispatchPublicationRuntime(options, jobContext)
      : undefined
  };

  return {
    job,
    operator: {
      mode: publication.mode,
      allowedGuildIds: options.appConfig.discord.allowedGuildIds,
      getRuntimeLeaseContext: getContext,
      enqueueApprovedProjection: enqueuer
    }
  };
}

async function reconcilePublicationRuntime(
  options: CreatePublicationRuntimeOptions,
  jobContext: PublicationJobContext
): Promise<PublicationObservation> {
  const context = requireContext(options, jobContext);
  const publication = options.appConfig.publication;
  if (!publication?.targetGuildId || !publication.targetGuildName || !options.appConfig.discord.botToken) {
    throw new Error("Publication observation configuration is incomplete.");
  }

  await synchronizeRemoteRevision(options, context);

  const observation = await runDiscordScheduledEventObservationSweep({
    db: options.db,
    token: options.appConfig.discord.botToken,
    guildId: publication.targetGuildId,
    guildName: publication.targetGuildName,
    context,
    fetchImpl: options.fetchImpl,
    timeoutMs: publication.requestTimeoutMs,
    clock: options.now
  });

  let reconciliationOutcome: PublicationObservation["reconciliationOutcome"] = "success";
  if (publication.mode === "active") {
    enqueueObservedSnapshotIfInitialized(options, context, observation.observedAt);
    recoverExpiredPublicProjectionOutbox(options.db, { ...context, now: currentDate(options) });
    for (const id of listReconciliationIds(options.db)) {
      const result = await reconcilePublicProjection(dispatcherOptions(options, context), id);
      if (result.kind === "retryable") reconciliationOutcome = "stale";
      else if (result.kind === "dead_letter") reconciliationOutcome = "mismatch";
      else if (result.kind === "succeeded") reconciliationOutcome = "operator_resolved";
    }
  }

  return {
    reconciliationOutcome,
    revision: getPublicProjectionRevision(options.db)?.revision,
    outboxStateCounts: queryOutboxStateCounts(options.db)
  };
}

async function dispatchPublicationRuntime(
  options: CreatePublicationRuntimeOptions,
  jobContext: PublicationJobContext
): Promise<PublicationDispatchResult> {
  const context = requireContext(options, jobContext);
  const result = await dispatchOnePublicProjection(dispatcherOptions(options, context));
  const outcome: PublicationDispatchResult["outcome"] = result.kind === "published"
    ? "success"
    : result.kind === "needs_reconciliation"
      ? "reconciled"
      : result.kind === "no_work"
        ? "skipped"
        : result.kind === "retryable" || result.kind === "stale_claim"
          ? "failed"
          : "refused";
  return {
    outcome,
    revision: getPublicProjectionRevision(options.db)?.revision,
    outboxStateCounts: queryOutboxStateCounts(options.db)
  };
}

function createOperatorEnqueuer(options: CreatePublicationRuntimeOptions): ApprovedPublicProjectionEnqueuer | undefined {
  const publication = options.appConfig.publication;
  if (!publication || publication.mode === "disabled" || !publication.publicIdKey || !publication.targetGuildId) return undefined;
  let lastResult: EnqueueApprovedPublicProjectionResult | undefined;
  return {
    get lastResult() { return lastResult; },
    enqueue(record): undefined {
      lastResult = enqueueApprovedPublicProjection({
        db: options.db,
        publicIdKey: publication.publicIdKey as string,
        guildId: publication.targetGuildId,
        now: currentDate(options),
        ...options.context
      }, record);
      return undefined;
    }
  };
}

function dispatcherOptions(
  options: CreatePublicationRuntimeOptions,
  context: RuntimeLeaseContext
): PublicProjectionDispatcherOptions {
  const publication = options.appConfig.publication;
  if (publication?.mode !== "active" || !publication.endpoint || !publication.publicAgendaEndpoint
      || !publication.keyId || !publication.signingPrivateKey) {
    throw new Error("Active publication dispatcher configuration is incomplete.");
  }
  return {
    db: options.db,
    ownerId: options.context.runtimeOwnerId,
    endpoint: publication.endpoint,
    reconciliationEndpoint: publication.publicAgendaEndpoint,
    keyId: publication.keyId,
    signingPrivateKey: publication.signingPrivateKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: publication.requestTimeoutMs,
    leaseDurationMs: publication.leaseDurationMs,
    leaseHeartbeatIntervalMs: publication.leaseHeartbeatIntervalMs,
    now: options.now,
    ...context
  };
}

/**
 * Refresh the public snapshot after every trusted full REST observation, but
 * only after an operator approval has initialized the revision stream. This
 * keeps the first cutover fail-closed while ensuring cancellations,
 * disappearances, and changed fields promptly revoke the prior public view.
 */
function enqueueObservedSnapshotIfInitialized(
  options: CreatePublicationRuntimeOptions,
  context: RuntimeLeaseContext,
  observedAt: string
): void {
  const publication = options.appConfig.publication;
  if (!publication?.publicIdKey || !publication.targetGuildId) {
    throw new Error("Active publication snapshot configuration is incomplete.");
  }
  const initialized = options.db.prepare(
    "SELECT 1 AS initialized FROM public_projection_outbox LIMIT 1"
  ).get() as { initialized?: number } | undefined;
  if (initialized?.initialized !== 1) return;

  const trigger = options.db.prepare(
    `SELECT id FROM private_agenda_entries
      WHERE guild_id = ? AND projection_type = 'language_club_agenda_entry.v1'
      ORDER BY updated_at DESC, id ASC LIMIT 1`
  ).get(publication.targetGuildId) as { id?: string } | undefined;
  if (!trigger?.id) {
    throw new Error("Initialized publication has no private agenda trigger row.");
  }

  options.db.exec("BEGIN IMMEDIATE");
  try {
    enqueueCurrentPublicProjection({
      db: options.db,
      publicIdKey: publication.publicIdKey,
      guildId: publication.targetGuildId,
      triggerAgendaEntryId: trigger.id,
      observedAt,
      now: currentDate(options),
      ...context
    });
    options.db.exec("COMMIT");
  } catch (error) {
    try { options.db.exec("ROLLBACK"); } catch { /* preserve snapshot error */ }
    throw error;
  }
}

async function synchronizeRemoteRevision(
  options: CreatePublicationRuntimeOptions,
  context: RuntimeLeaseContext
): Promise<void> {
  const publication = options.appConfig.publication;
  if (!publication?.endpoint || !publication.publicAgendaEndpoint) {
    throw new Error("Publication head synchronization endpoints are incomplete.");
  }
  const remote = await readPublicProjectionHead({
    endpoint: publication.endpoint,
    reconciliationEndpoint: publication.publicAgendaEndpoint,
    fetchImpl: options.fetchImpl,
    timeoutMs: publication.requestTimeoutMs
  });
  synchronizePublicProjectionRevisionFloor(options.db, {
    ...context,
    revisionFloor: remote.revision,
    now: currentDate(options)
  });
}

function requireContext(
  options: CreatePublicationRuntimeOptions,
  jobContext: PublicationJobContext
): RuntimeLeaseContext {
  if (!options.isLeaseValid()
      || jobContext.runtimeLeaseName !== options.context.runtimeLeaseName
      || jobContext.runtimeOwnerId !== options.context.runtimeOwnerId
      || jobContext.runtimeFencingToken !== options.context.runtimeFencingToken) {
    throw new Error("Publication runtime lease context is no longer active.");
  }
  return options.context;
}

function listReconciliationIds(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT id FROM public_projection_outbox
      WHERE state = 'needs_reconciliation'
      ORDER BY updated_at ASC, id ASC LIMIT ?`
  ).all(MAX_RECONCILIATIONS_PER_SWEEP) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function queryOutboxStateCounts(db: SqliteDatabase): Partial<Record<PublicProjectionOutboxState, number>> {
  const rows = db.prepare(
    "SELECT state, COUNT(*) AS count FROM public_projection_outbox GROUP BY state"
  ).all() as Array<{ state: PublicProjectionOutboxState; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
}

function currentDate(options: CreatePublicationRuntimeOptions): Date {
  return options.now?.() ?? new Date();
}
