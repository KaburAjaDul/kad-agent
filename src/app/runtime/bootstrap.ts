import { loadAppConfig, type AppConfig } from "../config/env.js";
import { createOperationalLogger } from "../lib/operational-logger.js";
import { runMigrations } from "../repo/migrations.js";
import { seedFoundationData } from "../repo/seeds.js";
import { createSqliteConnection } from "../repo/sqlite.js";
import { acquireRuntimeLease, releaseRuntimeLease, renewRuntimeLease, type RuntimeLease } from "../repo/runtime-lease-repo.js";
import { randomUUID } from "node:crypto";
import { BackgroundJobRunner, type PublicationJob } from "./job-runner.js";
import { startDiscordRuntime } from "../../discord/runtime/start-discord-runtime.js";
import { startHealthServer, type HealthServer } from "./health-server.js";
import { createOperationalMetrics } from "./operational-metrics.js";
import { createPublicationRuntime } from "../../publication/publication-runtime.js";
import type { PublicationOperatorDependencies } from "../../publication/publication-operator-adapter.js";

export type ApplicationRuntimeOptions = {
  failStop?: (code: number) => void;
  /** Optional publication implementation; runtime policy remains here. */
  publication?: PublicationJob;
  publicationOperator?: PublicationOperatorDependencies;
};

export async function startApplication(
  appConfig: AppConfig = loadAppConfig(),
  runtimeOptions: ApplicationRuntimeOptions = {}
): Promise<void> {
  const logger = createOperationalLogger({ level: appConfig.logLevel });
  const metrics = createOperationalMetrics({ databasePath: appConfig.databasePath });
  metrics.setPublicationMode(appConfig.botDryRun ? "disabled" : (appConfig.publication?.mode ?? "disabled"));
  const db = createSqliteConnection(appConfig.databasePath);
  let healthServer: HealthServer | undefined;

  try {
    healthServer = await startHealthServer({ ...appConfig.health, metrics, exposePrivateMetrics: appConfig.metricsExposePrivate });
    const appliedMigrations = runMigrations(db);
    const seededRows = seedFoundationData(db);
    metrics.refreshFromDatabase(db);
    let leaseValid = true;
    let jobRunner: BackgroundJobRunner;

    if (appConfig.botDryRun) {
      jobRunner = new BackgroundJobRunner(db, {
        mode: "operate",
        metrics,
        isLeaseValid: () => leaseValid,
        // Dry-run is a hard publication stop, regardless of an accidentally
        // supplied publication implementation or configuration.
        publicationMode: "disabled"
      });
      const reminderSweep = jobRunner.runReminderSweep();
      healthServer.setReady(true);

      logger.info("foundation_ready", {
        status: "foundation_ready",
        mode: "dry-run",
        e1ConfigSource: "sqlite",
        appliedMigrations,
        seededRows,
        reminderSweep
      });

      await healthServer.close();
      db.close();
      return;
    }

    const ownerId = `kaddy:${process.pid}:${randomUUID()}`;
    const lease = acquireRuntimeLease(db, {
      ownerId,
      leaseDurationMs: appConfig.runtimeLease?.durationMs ?? 30_000
    });
    if (!lease) {
      metrics.recordLeaseConflict();
      throw new Error("Kaddy runtime lease is already held by another owner.");
    }
    metrics.setLeaseState("held");
    const runtimeLeaseContext = {
      runtimeLeaseName: lease.leaseKey,
      runtimeOwnerId: lease.ownerId,
      runtimeFencingToken: lease.fencingToken
    };
    const defaultPublicationRuntime = runtimeOptions.publication
      ? undefined
      : createPublicationRuntime({
          db,
          appConfig,
          context: runtimeLeaseContext,
          isLeaseValid: () => leaseValid
        });
    const publicationJob = runtimeOptions.publication ?? defaultPublicationRuntime?.job;
    const publicationOperator = runtimeOptions.publicationOperator ?? defaultPublicationRuntime?.operator;
    jobRunner = new BackgroundJobRunner(db, {
      mode: appConfig.runtimeMode ?? "observe",
      metrics,
      isLeaseValid: () => leaseValid,
      ownerId: lease.ownerId,
      runtimeLeaseName: lease.leaseKey,
      runtimeOwnerId: lease.ownerId,
      runtimeFencingToken: lease.fencingToken,
      leaseDurationMs: appConfig.runtimeLease?.durationMs ?? 30_000,
      heartbeatIntervalMs: appConfig.runtimeLease?.heartbeatIntervalMs ?? 10_000,
      publicationMode: appConfig.publication?.mode ?? "disabled",
      publication: publicationJob,
      publicationRequestTimeoutMs: appConfig.publication?.requestTimeoutMs,
      publicationLeaseDurationMs: appConfig.publication?.leaseDurationMs,
      publicationLeaseHeartbeatIntervalMs: appConfig.publication?.leaseHeartbeatIntervalMs
    });
    let discordRuntime: Awaited<ReturnType<typeof startDiscordRuntime>>;
    let shutdown: (() => Promise<void>) | undefined;
    const failStop = runtimeOptions.failStop ?? ((code: number) => process.exit(code));
    const markLeaseLost = () => {
      if (!leaseValid) return;
      leaseValid = false;
      metrics.recordLeaseLoss();
      metrics.setLeaseState("lost");
      healthServer?.setReady(false);
      discordRuntime?.setLeaseValid(false);
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (discordRuntime && !shutdown) {
        void discordRuntime.destroy().catch((error: unknown) => logger.error("discord_destroy_after_lease_loss_failed", { error }));
      }
    };
    const failStopOnLeaseLoss = createLeaseLossFailStopHandler({
      markLeaseLost,
      shutdown: () => shutdown?.() ?? Promise.resolve(),
      failStop,
      onError: (error) => logger.error("runtime_lease_loss_shutdown_failed", { error })
    });
    let leaseHeartbeat: NodeJS.Timeout | undefined;
    leaseHeartbeat = setInterval(() => {
      const renewed = renewRuntimeLease(db, {
        ownerId,
        fencingToken: lease.fencingToken,
        leaseDurationMs: appConfig.runtimeLease?.durationMs ?? 30_000
      });
      if (!renewed) failStopOnLeaseLoss();
    }, appConfig.runtimeLease?.heartbeatIntervalMs ?? 10_000);
    try {
      discordRuntime = await withTimeout(
        startDiscordRuntime(appConfig, db, {
          lease,
          metrics,
          publicationOperator,
          onReadinessChange: (ready) => healthServer?.setReady(ready && leaseValid)
        }),
        appConfig.startupTimeoutMs ?? 30_000,
        "Kaddy Discord runtime startup timed out."
      );
    } catch (error) {
      clearInterval(leaseHeartbeat);
      releaseRuntimeLease(db, { ownerId, fencingToken: lease.fencingToken });
      throw error;
    }
    let inFlightSweep: Promise<unknown> | undefined;
    let inFlightPublicationSweep: Promise<unknown> | undefined;

    const intervalHandle = setInterval(() => {
      if (inFlightSweep || !leaseValid || !discordRuntime.isReady()) {
        return;
      }

      const sweep = jobRunner
        .deliverReminderSweep(discordRuntime)
        .catch((error: unknown) => {
          logger.error("reminder_delivery_sweep_failed", { error });
        });
      const trackedSweep = sweep.finally(() => {
        if (inFlightSweep === trackedSweep) {
          inFlightSweep = undefined;
        }
      });
      inFlightSweep = trackedSweep;
    }, appConfig.jobPollIntervalMs);

    const publicationIntervalHandle = publicationJob
      && (appConfig.publication?.mode ?? "disabled") !== "disabled"
      ? setInterval(() => {
        // Publication observation uses authenticated Discord REST and the
        // signed projection endpoint. It must continue reconciling public
        // withdrawals even while the Gateway session is reconnecting.
        if (inFlightPublicationSweep || !leaseValid) return;
        const publicationSweep = jobRunner
          .runPublicationSweep()
          .catch((error: unknown) => {
            logger.error("publication_sweep_failed", { error });
          });
        const trackedPublicationSweep = publicationSweep.finally(() => {
          if (inFlightPublicationSweep === trackedPublicationSweep) {
            inFlightPublicationSweep = undefined;
          }
        });
        inFlightPublicationSweep = trackedPublicationSweep;
      }, publicationIntervalMs(appConfig))
      : undefined;

    shutdown = createGracefulShutdown({
      markNotReady: () => healthServer?.setReady(false),
      clearInterval: () => {
        clearInterval(intervalHandle);
        if (publicationIntervalHandle) clearInterval(publicationIntervalHandle);
      },
      waitForInFlightSweep: async () => {
        await inFlightSweep;
        await inFlightPublicationSweep;
      },
      destroyDiscord: discordRuntime.destroy,
      releaseLease: () => {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        metrics.setLeaseState("lost");
        releaseRuntimeLease(db, { ownerId, fencingToken: lease.fencingToken });
      },
      closeDatabase: () => db.close(),
      closeHealth: () => healthServer?.close(),
      timeoutMs: appConfig.shutdownTimeoutMs ?? 10_000
    });

    const requestShutdown = (signal: "SIGINT" | "SIGTERM") => {
      void shutdown().catch((error: unknown) => {
        logger.error("application_shutdown_failed", { signal, error });
        process.exit(1);
      });
    };

    process.once("SIGINT", () => requestShutdown("SIGINT"));
    process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  } catch (error) {
    healthServer?.setReady(false);
    await healthServer?.close();
    db.close();
    throw error;
  }
}

export function createGracefulShutdown(deps: {
  markNotReady: () => void;
  clearInterval: () => void;
  waitForInFlightSweep: () => Promise<void>;
  destroyDiscord: () => Promise<void>;
  releaseLease?: () => void | Promise<void>;
  closeDatabase: () => void;
  closeHealth: () => Promise<void> | undefined;
  timeoutMs?: number;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= (async () => {
      deps.markNotReady();
      deps.clearInterval();
      const cleanupSteps: Array<() => void | Promise<void>> = [
        deps.waitForInFlightSweep,
        deps.destroyDiscord,
        ...(deps.releaseLease ? [deps.releaseLease] : []),
        deps.closeDatabase,
        async () => {
          await deps.closeHealth();
        }
      ];
      const errors: unknown[] = [];
      const deadline = Date.now() + (deps.timeoutMs ?? 30_000);

      for (const cleanup of cleanupSteps) {
        try {
          await withTimeout(Promise.resolve(cleanup()), Math.max(1, deadline - Date.now()), "Kaddy shutdown step timed out.");
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more Kaddy shutdown steps failed.");
      }
    })();
    return shutdownPromise;
  };
}

export function createLeaseLossFailStopHandler(deps: {
  markLeaseLost: () => void;
  shutdown: () => Promise<void>;
  failStop: (code: number) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let triggered = false;
  return () => {
    if (triggered) return;
    triggered = true;
    deps.markLeaseLost();
    void deps.shutdown()
      .catch((error: unknown) => {
        deps.onError?.(error);
      })
      .finally(() => deps.failStop(1));
  };
}

function publicationIntervalMs(appConfig: AppConfig): number {
  const publication = appConfig.publication;
  if (!publication || publication.mode === "disabled") return appConfig.jobPollIntervalMs;
  return publication.mode === "active" ? publication.publishIntervalMs : publication.observationIntervalMs;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
