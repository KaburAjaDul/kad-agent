import { loadAppConfig, type AppConfig } from "../config/env.js";
import { createOperationalLogger } from "../lib/operational-logger.js";
import { runMigrations } from "../repo/migrations.js";
import { seedFoundationData } from "../repo/seeds.js";
import { createSqliteConnection } from "../repo/sqlite.js";
import { BackgroundJobRunner } from "./job-runner.js";
import { startDiscordRuntime } from "../../discord/runtime/start-discord-runtime.js";
import { startHealthServer, type HealthServer } from "./health-server.js";

export async function startApplication(appConfig: AppConfig = loadAppConfig()): Promise<void> {
  const logger = createOperationalLogger({ level: appConfig.logLevel });
  const db = createSqliteConnection(appConfig.databasePath);
  let healthServer: HealthServer | undefined;

  try {
    healthServer = await startHealthServer(appConfig.health);
    const appliedMigrations = runMigrations(db);
    const seededRows = seedFoundationData(db);
    const jobRunner = new BackgroundJobRunner(db);

    if (appConfig.botDryRun) {
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

    const discordRuntime = await startDiscordRuntime(appConfig, db);
    healthServer.setReady(true);
    let inFlightSweep: Promise<unknown> | undefined;

    const intervalHandle = setInterval(() => {
      if (inFlightSweep) {
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

    const shutdown = createGracefulShutdown({
      markNotReady: () => healthServer?.setReady(false),
      clearInterval: () => clearInterval(intervalHandle),
      waitForInFlightSweep: async () => {
        await inFlightSweep;
      },
      destroyDiscord: discordRuntime.destroy,
      closeDatabase: () => db.close(),
      closeHealth: () => healthServer?.close()
    });

    const requestShutdown = (signal: "SIGINT" | "SIGTERM") => {
      void shutdown().catch((error: unknown) => {
        logger.error("application_shutdown_failed", { signal, error });
        process.exitCode = 1;
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
  closeDatabase: () => void;
  closeHealth: () => Promise<void> | undefined;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= (async () => {
      deps.markNotReady();
      deps.clearInterval();
      const cleanupSteps: Array<() => void | Promise<void>> = [
        deps.waitForInFlightSweep,
        deps.destroyDiscord,
        deps.closeDatabase,
        async () => {
          await deps.closeHealth();
        }
      ];
      const errors: unknown[] = [];

      for (const cleanup of cleanupSteps) {
        try {
          await cleanup();
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
