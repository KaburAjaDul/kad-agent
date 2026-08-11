import { loadAppConfig } from "./app/config/env.js";
import { createOperationalLogger } from "./app/lib/operational-logger.js";
import { startApplication } from "./app/runtime/bootstrap.js";
import { assertLiveDiscordCommandEnabled } from "./app/runtime/live-discord-command-guard.js";

const logger = createOperationalLogger();

try {
  const cliDryRun = process.argv.includes("--dry-run");
  const preflightConfig = loadAppConfig({
    requireDiscord: false,
    overrides: cliDryRun
      ? {
          BOT_DRY_RUN: "true"
        }
      : undefined
  });

  if (!cliDryRun) {
    assertLiveDiscordCommandEnabled(preflightConfig, {
      commandName: "npm run start",
      dryRunHint: "use npm run start:dry-run for the local dry-run startup path"
    });
  }

  const appConfig = cliDryRun ? preflightConfig : loadAppConfig();
  await startApplication(appConfig);
} catch (error) {
  logger.error("application_start_failed", { error });
  process.exitCode = 1;
}
