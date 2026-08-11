import type { SqliteDatabase } from "../../app/repo/sqlite.js";

export type StoredLanguageClub = {
  id: string;
  guildId: string;
  clubKey: string;
  displayName: string;
  defaultHostVoiceChannelId: string | null;
  isActive: boolean;
  configuredByDiscordUserId: string;
  configuredAt: string;
  updatedByDiscordUserId: string;
  updatedAt: string;
};

export type UpsertLanguageClubInput = StoredLanguageClub;

type LanguageClubRow = {
  id: string;
  guild_id: string;
  club_key: string;
  display_name: string;
  default_host_voice_channel_id: string | null;
  is_active: number;
  configured_by_discord_user_id: string;
  configured_at: string;
  updated_by_discord_user_id: string;
  updated_at: string;
};

export function getLanguageClubByKey(db: SqliteDatabase, guildId: string, clubKey: string): StoredLanguageClub | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          guild_id,
          club_key,
          display_name,
          default_host_voice_channel_id,
          is_active,
          configured_by_discord_user_id,
          configured_at,
          updated_by_discord_user_id,
          updated_at
        FROM language_clubs
        WHERE guild_id = ?
          AND club_key = ?
      `
    )
    .get(guildId, clubKey) as LanguageClubRow | undefined;

  return row ? mapLanguageClubRow(row) : null;
}

export function listLanguageClubsByGuildId(db: SqliteDatabase, guildId: string): StoredLanguageClub[] {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          guild_id,
          club_key,
          display_name,
          default_host_voice_channel_id,
          is_active,
          configured_by_discord_user_id,
          configured_at,
          updated_by_discord_user_id,
          updated_at
        FROM language_clubs
        WHERE guild_id = ?
        ORDER BY club_key ASC
      `
    )
    .all(guildId) as LanguageClubRow[];

  return rows.map(mapLanguageClubRow);
}

export function upsertLanguageClub(db: SqliteDatabase, input: UpsertLanguageClubInput): void {
  db.prepare(
    `
      INSERT INTO language_clubs (
        id,
        guild_id,
        club_key,
        display_name,
        default_host_voice_channel_id,
        is_active,
        configured_by_discord_user_id,
        configured_at,
        updated_by_discord_user_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, club_key) DO UPDATE SET
        display_name = excluded.display_name,
        default_host_voice_channel_id = excluded.default_host_voice_channel_id,
        is_active = excluded.is_active,
        updated_by_discord_user_id = excluded.updated_by_discord_user_id,
        updated_at = excluded.updated_at
    `
  ).run(
    input.id,
    input.guildId,
    input.clubKey,
    input.displayName,
    input.defaultHostVoiceChannelId,
    input.isActive ? 1 : 0,
    input.configuredByDiscordUserId,
    input.configuredAt,
    input.updatedByDiscordUserId,
    input.updatedAt
  );
}

function mapLanguageClubRow(row: LanguageClubRow): StoredLanguageClub {
  return {
    id: row.id,
    guildId: row.guild_id,
    clubKey: row.club_key,
    displayName: row.display_name,
    defaultHostVoiceChannelId: row.default_host_voice_channel_id,
    isActive: Number(row.is_active) === 1,
    configuredByDiscordUserId: row.configured_by_discord_user_id,
    configuredAt: row.configured_at,
    updatedByDiscordUserId: row.updated_by_discord_user_id,
    updatedAt: row.updated_at
  };
}
