import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import {
  getLanguageClubGuildConfigByGuildId,
  upsertLanguageClubGuildConfig
} from "../src/events/repo/language-club-guild-config-repo.js";
import { configureLanguageClubGuild } from "../src/events/service/language-club-guild-config-service.js";

describe("language club guild config", () => {
  it("configures a guild, validates timezone, and deduplicates role IDs", () => {
    const db = createTestDatabase();

    try {
      const storedConfig = configureLanguageClubGuild(db, {
        guildId: "guild-1",
        announcementChannelId: "announcement-1",
        hostVoiceChannelId: "voice-1",
        defaultTimezone: "Asia/Jakarta",
        actorDiscordUserId: "admin-1",
        staffRoleIds: ["role-2", "role-1", "role-2"],
        now: new Date("2026-04-24T10:00:00.000Z")
      });

      expect(storedConfig).toEqual({
        guildId: "guild-1",
        announcementChannelId: "announcement-1",
        hostVoiceChannelId: "voice-1",
        defaultTimezone: "Asia/Jakarta",
        configuredByDiscordUserId: "admin-1",
        configuredAt: "2026-04-24T10:00:00.000Z",
        updatedByDiscordUserId: "admin-1",
        updatedAt: "2026-04-24T10:00:00.000Z",
        staffRoleIds: ["role-1", "role-2"]
      });
    } finally {
      db.close();
    }
  });

  it("preserves original configured metadata while replacing the stored role set on update", () => {
    const db = createTestDatabase();

    try {
      upsertLanguageClubGuildConfig(db, {
        guildId: "guild-1",
        announcementChannelId: "announcement-1",
        hostVoiceChannelId: "voice-1",
        defaultTimezone: "Asia/Jakarta",
        configuredByDiscordUserId: "admin-1",
        configuredAt: "2026-04-24T10:00:00.000Z",
        updatedByDiscordUserId: "admin-1",
        updatedAt: "2026-04-24T10:00:00.000Z",
        staffRoleIds: ["role-1", "role-2"]
      });

      const updatedConfig = configureLanguageClubGuild(db, {
        guildId: "guild-1",
        announcementChannelId: "announcement-9",
        hostVoiceChannelId: "voice-9",
        defaultTimezone: "Asia/Makassar",
        actorDiscordUserId: "admin-2",
        staffRoleIds: ["role-3"],
        now: new Date("2026-04-24T11:00:00.000Z")
      });

      expect(updatedConfig).toEqual({
        guildId: "guild-1",
        announcementChannelId: "announcement-9",
        hostVoiceChannelId: "voice-9",
        defaultTimezone: "Asia/Makassar",
        configuredByDiscordUserId: "admin-1",
        configuredAt: "2026-04-24T10:00:00.000Z",
        updatedByDiscordUserId: "admin-2",
        updatedAt: "2026-04-24T11:00:00.000Z",
        staffRoleIds: ["role-3"]
      });
    } finally {
      db.close();
    }
  });

  it("rejects invalid timezone and empty staff role sets", () => {
    const db = createTestDatabase();

    try {
      expect(() =>
        configureLanguageClubGuild(db, {
          guildId: "guild-1",
          announcementChannelId: "announcement-1",
          hostVoiceChannelId: "voice-1",
          defaultTimezone: "Mars/Olympus",
          actorDiscordUserId: "admin-1",
          staffRoleIds: ["role-1"]
        })
      ).toThrow("Timezone must be a valid IANA timezone. Received: Mars/Olympus");

      expect(() =>
        configureLanguageClubGuild(db, {
          guildId: "guild-1",
          announcementChannelId: "announcement-1",
          hostVoiceChannelId: "voice-1",
          defaultTimezone: "Asia/Jakarta",
          actorDiscordUserId: "admin-1",
          staffRoleIds: []
        })
      ).toThrow("At least one staff role is required for Event Slice E1 setup.");

      expect(getLanguageClubGuildConfigByGuildId(db, "guild-1")).toBeNull();
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
