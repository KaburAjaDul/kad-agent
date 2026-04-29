import { createUuidV7 } from "../../app/lib/uuidv7.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import {
  getLanguageClubByKey,
  listLanguageClubsByGuildId,
  upsertLanguageClub,
  type StoredLanguageClub
} from "../repo/language-club-registry-repo.js";

const CLUB_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

export type UpsertLanguageClubCommandInput = {
  guildId: string;
  clubKey: string;
  displayName: string;
  defaultHostVoiceChannelId?: string | null;
  active?: boolean;
  actorDiscordUserId: string;
  now?: Date;
};

export function upsertLanguageClubCommand(
  db: SqliteDatabase,
  input: UpsertLanguageClubCommandInput
): StoredLanguageClub {
  assertNonEmpty(input.guildId, "guildId");
  assertNonEmpty(input.actorDiscordUserId, "actorDiscordUserId");

  const clubKey = normalizeClubKey(input.clubKey);
  const displayName = input.displayName.trim();

  if (!CLUB_KEY_PATTERN.test(clubKey)) {
    throw new Error("club_key must be a safe slug: 3-64 lowercase letters, numbers, underscores, or hyphens.");
  }

  if (displayName.length === 0) {
    throw new Error("display_name is required.");
  }

  const defaultHostVoiceChannelId = normalizeOptionalId(input.defaultHostVoiceChannelId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existingClub = getLanguageClubByKey(db, input.guildId, clubKey);

  upsertLanguageClub(db, {
    id: existingClub?.id ?? createUuidV7(now),
    guildId: input.guildId,
    clubKey,
    displayName,
    defaultHostVoiceChannelId,
    isActive: input.active ?? true,
    configuredByDiscordUserId: existingClub?.configuredByDiscordUserId ?? input.actorDiscordUserId,
    configuredAt: existingClub?.configuredAt ?? nowIso,
    updatedByDiscordUserId: input.actorDiscordUserId,
    updatedAt: nowIso
  });

  const storedClub = getLanguageClubByKey(db, input.guildId, clubKey);

  if (!storedClub) {
    throw new Error("Failed to read back Language Club registry row from SQLite.");
  }

  return storedClub;
}

export { getLanguageClubByKey, listLanguageClubsByGuildId };

function normalizeClubKey(clubKey: string): string {
  return clubKey.trim().toLowerCase();
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim() === "") {
    throw new Error(`${fieldName} is required.`);
  }
}
