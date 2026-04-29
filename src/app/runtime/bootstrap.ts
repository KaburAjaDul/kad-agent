import { loadAppConfig, type AppConfig } from "../config/env.js";
import { runMigrations } from "../repo/migrations.js";
import { seedFoundationData } from "../repo/seeds.js";
import { createSqliteConnection } from "../repo/sqlite.js";
import { BackgroundJobRunner } from "./job-runner.js";
import { startDiscordRuntime } from "../../discord/runtime/start-discord-runtime.js";

export async function startApplication(appConfig: AppConfig = loadAppConfig()): Promise<void> {
  const db = createSqliteConnection(appConfig.databasePath);

  try {
    const appliedMigrations = runMigrations(db);
    const seededRows = seedFoundationData(db);
    const jobRunner = new BackgroundJobRunner(db);

    if (appConfig.botDryRun) {
      const reminderSweep = jobRunner.runReminderSweep();

      console.info(
        JSON.stringify({
            status: "foundation_ready",
            mode: "dry-run",
            databasePath: appConfig.databasePath,
            e1ConfigSource: "sqlite",
            appliedMigrations,
            seededRows,
            reminderSweep
        })
      );

      db.close();
      return;
    }

    const discordRuntime = await startDiscordRuntime(appConfig, db);
    let reminderSweepInFlight = false;

    const intervalHandle = setInterval(() => {
      if (reminderSweepInFlight) {
        return;
      }

      reminderSweepInFlight = true;
      void jobRunner
        .deliverReminderSweep(discordRuntime)
        .catch((error: unknown) => {
          console.error("Reminder delivery sweep failed", error);
        })
        .finally(() => {
          reminderSweepInFlight = false;
        });
    }, appConfig.jobPollIntervalMs);

    const shutdown = async () => {
      clearInterval(intervalHandle);
      await discordRuntime.destroy();
      db.close();
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown();
    });

    process.once("SIGTERM", () => {
      void shutdown();
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
