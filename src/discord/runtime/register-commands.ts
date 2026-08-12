import { REST, Routes } from "discord.js";
import type { AppConfig } from "../../app/config/env.js";
import { foundationCommands } from "../discord/command-catalog.js";

export type RegisterCommandsResult = {
  mode: "dry-run" | "registered";
  scope: "guild";
  commandCount: number;
  guildId?: string;
};

export async function registerCommands(
  appConfig: AppConfig,
  options: {
    dryRun?: boolean;
    guildId?: string;
  } = {}
): Promise<RegisterCommandsResult> {
  const dryRun = options.dryRun ?? appConfig.botDryRun;
  const guildId = options.guildId;

  if (guildId && !isAllowedGuildId(guildId, appConfig.discord.allowedGuildIds)) {
    throw new Error("Command registration refused because --guild-id is outside DISCORD_ALLOWED_GUILD_IDS.");
  }

  if (dryRun) {
    return {
      mode: "dry-run",
      scope: "guild",
      commandCount: foundationCommands.length,
      guildId
    };
  }

  if (!appConfig.discord.appId || !appConfig.discord.botToken) {
    throw new Error("Discord app ID and bot token are required to register commands.");
  }

  if (!guildId) {
    throw new Error("Live command registration requires --guild-id <snowflake>. Global registration is disabled for this slice.");
  }

  if ((appConfig.runtimeMode ?? "observe") === "observe") {
    throw new Error("Live command registration is disabled while KADDY_RUNTIME_MODE=observe.");
  }

  if (appConfig.discord.allowedGuildIds.length === 0) {
    throw new Error("DISCORD_ALLOWED_GUILD_IDS is required for live command registration.");
  }

  const rest = new REST({ version: "10" }).setToken(appConfig.discord.botToken);
  const route = Routes.applicationGuildCommands(appConfig.discord.appId, guildId);

  await rest.put(route, { body: foundationCommands });

  return {
    mode: "registered",
    scope: "guild",
    commandCount: foundationCommands.length,
    guildId
  };
}

export function isAllowedGuildId(guildId: string | null | undefined, allowedGuildIds: readonly string[]): boolean {
  return typeof guildId === "string" && guildId.length > 0 && allowedGuildIds.includes(guildId);
}
