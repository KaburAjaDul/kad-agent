import { loadAppConfig } from "../app/config/env.js";
import { assertLiveDiscordCommandEnabled } from "../app/runtime/live-discord-command-guard.js";
import { registerCommands } from "../discord/runtime/register-commands.js";

const cliDryRun = process.argv.includes("--dry-run");
const cliGuildId = readGuildIdFlag(process.argv.slice(2));
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
    commandName: "npm run register-commands",
    dryRunHint: "rerun with npm run register-commands -- --dry-run to preview command registration"
  });
}

const appConfig = cliDryRun ? preflightConfig : loadAppConfig();

const result = await registerCommands(appConfig, {
  dryRun: cliDryRun || appConfig.botDryRun,
  guildId: cliGuildId
});
console.info(JSON.stringify(result));

function readGuildIdFlag(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf("--guild-id");

  if (flagIndex === -1) {
    return undefined;
  }

  const guildId = argv[flagIndex + 1];

  if (!guildId || !/^\d+$/.test(guildId)) {
    throw new Error("--guild-id requires a Discord snowflake value.");
  }

  return guildId;
}
