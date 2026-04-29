import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import {
  getLanguageClubGuildConfigByGuildId,
  upsertLanguageClubGuildConfig,
  type StoredLanguageClubGuildConfig
} from "../repo/language-club-guild-config-repo.js";

export type ConfigureLanguageClubGuildInput = {
  guildId: string;
  announcementChannelId: string;
  hostVoiceChannelId: string;
  defaultTimezone: string;
  actorDiscordUserId: string;
  staffRoleIds: string[];
  now?: Date;
};

export function configureLanguageClubGuild(
  db: SqliteDatabase,
  input: ConfigureLanguageClubGuildInput
): StoredLanguageClubGuildConfig {
  assertNonEmptyDiscordId(input.guildId, "guildId");
  assertNonEmptyDiscordId(input.announcementChannelId, "announcementChannelId");
  assertNonEmptyDiscordId(input.hostVoiceChannelId, "hostVoiceChannelId");
  assertNonEmptyDiscordId(input.actorDiscordUserId, "actorDiscordUserId");

  const normalizedStaffRoleIds = dedupeDiscordIds(input.staffRoleIds);

  if (normalizedStaffRoleIds.length === 0) {
    throw new Error("At least one staff role is required for Event Slice E1 setup.");
  }

  assertValidTimeZone(input.defaultTimezone);

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existingConfig = getLanguageClubGuildConfigByGuildId(db, input.guildId);

  upsertLanguageClubGuildConfig(db, {
    guildId: input.guildId,
    announcementChannelId: input.announcementChannelId,
    hostVoiceChannelId: input.hostVoiceChannelId,
    defaultTimezone: input.defaultTimezone,
    configuredByDiscordUserId: existingConfig?.configuredByDiscordUserId ?? input.actorDiscordUserId,
    configuredAt: existingConfig?.configuredAt ?? nowIso,
    updatedByDiscordUserId: input.actorDiscordUserId,
    updatedAt: nowIso,
    staffRoleIds: normalizedStaffRoleIds
  });

  const storedConfig = getLanguageClubGuildConfigByGuildId(db, input.guildId);

  if (!storedConfig) {
    throw new Error("Failed to read back Event Slice E1 setup from SQLite.");
  }

  return storedConfig;
}

export function assertValidTimeZone(timeZone: string): void {
  if (timeZone.trim() === "") {
    throw new Error("A default timezone is required for Event Slice E1 setup.");
  }

  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date("2026-01-01T00:00:00.000Z"));
  } catch {
    throw new Error(`Timezone must be a valid IANA timezone. Received: ${timeZone}`);
  }
}

function dedupeDiscordIds(discordIds: string[]): string[] {
  const dedupedIds: string[] = [];
  const seen = new Set<string>();

  for (const discordId of discordIds) {
    assertNonEmptyDiscordId(discordId, "discordId");

    if (seen.has(discordId)) {
      continue;
    }

    seen.add(discordId);
    dedupedIds.push(discordId);
  }

  return dedupedIds;
}

function assertNonEmptyDiscordId(value: string, fieldName: string): void {
  if (value.trim() === "") {
    throw new Error(`${fieldName} is required.`);
  }
}
