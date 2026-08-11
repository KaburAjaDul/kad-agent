import type { SqliteDatabase } from "../../app/repo/sqlite.js";

export type StoredLanguageClubGuildConfig = {
  guildId: string;
  announcementChannelId: string;
  hostVoiceChannelId: string;
  defaultTimezone: string;
  configuredByDiscordUserId: string;
  configuredAt: string;
  updatedByDiscordUserId: string;
  updatedAt: string;
  staffRoleIds: string[];
};

export type UpsertLanguageClubGuildConfigInput = {
  guildId: string;
  announcementChannelId: string;
  hostVoiceChannelId: string;
  defaultTimezone: string;
  configuredByDiscordUserId: string;
  configuredAt: string;
  updatedByDiscordUserId: string;
  updatedAt: string;
  staffRoleIds: string[];
};

type GuildConfigRow = {
  guild_id: string;
  announcement_channel_id: string;
  host_voice_channel_id: string;
  default_timezone: string;
  configured_by_discord_user_id: string;
  configured_at: string;
  updated_by_discord_user_id: string;
  updated_at: string;
};

export function getLanguageClubGuildConfigByGuildId(
  db: SqliteDatabase,
  guildId: string
): StoredLanguageClubGuildConfig | null {
  const configRow = db
    .prepare(
      `
        SELECT
          guild_id,
          announcement_channel_id,
          host_voice_channel_id,
          default_timezone,
          configured_by_discord_user_id,
          configured_at,
          updated_by_discord_user_id,
          updated_at
        FROM language_club_guild_config
        WHERE guild_id = ?
      `
    )
    .get(guildId) as GuildConfigRow | undefined;

  if (!configRow) {
    return null;
  }

  const roleRows = db
    .prepare(
      `
        SELECT discord_role_id
        FROM language_club_staff_roles
        WHERE guild_id = ?
        ORDER BY discord_role_id ASC
      `
    )
    .all(guildId) as Array<{ discord_role_id: string }>;

  return {
    guildId: configRow.guild_id,
    announcementChannelId: configRow.announcement_channel_id,
    hostVoiceChannelId: configRow.host_voice_channel_id,
    defaultTimezone: configRow.default_timezone,
    configuredByDiscordUserId: configRow.configured_by_discord_user_id,
    configuredAt: configRow.configured_at,
    updatedByDiscordUserId: configRow.updated_by_discord_user_id,
    updatedAt: configRow.updated_at,
    staffRoleIds: roleRows.map((row) => row.discord_role_id)
  };
}

export function upsertLanguageClubGuildConfig(db: SqliteDatabase, input: UpsertLanguageClubGuildConfigInput): void {
  const existingConfig = getLanguageClubGuildConfigByGuildId(db, input.guildId);

  db.exec("BEGIN");

  try {
    if (existingConfig) {
      db.prepare(
        `
          UPDATE language_club_guild_config
          SET announcement_channel_id = ?,
              host_voice_channel_id = ?,
              default_timezone = ?,
              updated_by_discord_user_id = ?,
              updated_at = ?
          WHERE guild_id = ?
        `
      ).run(
        input.announcementChannelId,
        input.hostVoiceChannelId,
        input.defaultTimezone,
        input.updatedByDiscordUserId,
        input.updatedAt,
        input.guildId
      );
    } else {
      db.prepare(
        `
          INSERT INTO language_club_guild_config (
            guild_id,
            announcement_channel_id,
            host_voice_channel_id,
            default_timezone,
            configured_by_discord_user_id,
            configured_at,
            updated_by_discord_user_id,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        input.guildId,
        input.announcementChannelId,
        input.hostVoiceChannelId,
        input.defaultTimezone,
        input.configuredByDiscordUserId,
        input.configuredAt,
        input.updatedByDiscordUserId,
        input.updatedAt
      );
    }

    db.prepare("DELETE FROM language_club_staff_roles WHERE guild_id = ?").run(input.guildId);

    const insertRole = db.prepare(
      `
        INSERT INTO language_club_staff_roles (
          guild_id,
          discord_role_id,
          added_by_discord_user_id,
          added_at
        ) VALUES (?, ?, ?, ?)
      `
    );

    for (const roleId of input.staffRoleIds) {
      insertRole.run(input.guildId, roleId, input.updatedByDiscordUserId, input.updatedAt);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
