import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import {
  listLanguageClubsByGuildId,
  upsertLanguageClubCommand
} from "../src/events/service/language-club-registry-service.js";

describe("language club registry", () => {
  it("upserts assigned language clubs and preserves configured metadata", () => {
    const db = createTestDatabase();

    try {
      const created = upsertLanguageClubCommand(db, {
        guildId: "guild-1",
        clubKey: "English_Club",
        displayName: "English Club",
        defaultHostVoiceChannelId: "voice-1",
        active: true,
        actorDiscordUserId: "admin-1",
        now: new Date("2026-04-23T10:00:00.000Z")
      });
      const updated = upsertLanguageClubCommand(db, {
        guildId: "guild-1",
        clubKey: "english_club",
        displayName: "English Conversation Club",
        defaultHostVoiceChannelId: null,
        active: false,
        actorDiscordUserId: "admin-2",
        now: new Date("2026-04-23T11:00:00.000Z")
      });

      expect(updated).toEqual({
        ...created,
        displayName: "English Conversation Club",
        defaultHostVoiceChannelId: null,
        isActive: false,
        updatedByDiscordUserId: "admin-2",
        updatedAt: "2026-04-23T11:00:00.000Z"
      });
      expect(listLanguageClubsByGuildId(db, "guild-1")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects unsafe club keys and empty display names", () => {
    const db = createTestDatabase();

    try {
      expect(() =>
        upsertLanguageClubCommand(db, {
          guildId: "guild-1",
          clubKey: "../bad key",
          displayName: "Bad",
          actorDiscordUserId: "admin-1"
        })
      ).toThrow("club_key must be a safe slug");

      expect(() =>
        upsertLanguageClubCommand(db, {
          guildId: "guild-1",
          clubKey: "valid_key",
          displayName: " ",
          actorDiscordUserId: "admin-1"
        })
      ).toThrow("display_name is required.");
    } finally {
      db.close();
    }
  });
});

function createTestDatabase() {
  const db = createSqliteConnection(":memory:");
  runMigrations(db);
  return db;
}
