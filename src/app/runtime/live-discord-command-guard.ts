import type { AppConfig } from "../config/env.js";

export function assertLiveDiscordCommandEnabled(
  appConfig: AppConfig,
  options: {
    commandName: string;
    dryRunHint: string;
  }
): void {
  if (!appConfig.botDryRun) {
    return;
  }

  throw new Error(
    `${options.commandName} refused to run because BOT_DRY_RUN=true. Set BOT_DRY_RUN=false for live Discord validation, or ${options.dryRunHint}.`
  );
}
