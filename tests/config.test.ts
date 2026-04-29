import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/app/config/env.js";

describe("loadAppConfig", () => {
  it("allows a Discord-less dry run startup path", () => {
    const config = loadAppConfig({
      env: {
        NODE_ENV: "test",
        BOT_DRY_RUN: "true",
        DATABASE_PATH: "./tmp/test.sqlite",
        JOB_POLL_INTERVAL_MS: "15000"
      },
      cwd: "/repo",
      loadEnvFile: false
    });

    expect(config.botDryRun).toBe(true);
    expect(config.databasePath).toBe("/repo/tmp/test.sqlite");
    expect(config.discord.botToken).toBeUndefined();
  });

  it("allows DB-only config loading without Discord credentials when explicitly disabled", () => {
    const config = loadAppConfig({
      env: {
        NODE_ENV: "test",
        BOT_DRY_RUN: "false",
        DATABASE_PATH: "./tmp/test.sqlite"
      },
      cwd: "/repo",
      loadEnvFile: false,
      requireDiscord: false
    });

    expect(config.botDryRun).toBe(false);
    expect(config.databasePath).toBe("/repo/tmp/test.sqlite");
    expect(config.discord.appId).toBeUndefined();
    expect(config.discord.botToken).toBeUndefined();
  });

  it("fails fast when live startup is missing Discord credentials", () => {
    expect(() =>
      loadAppConfig({
        env: {
          NODE_ENV: "test",
          BOT_DRY_RUN: "false",
          DATABASE_PATH: "./tmp/test.sqlite"
        },
        cwd: "/repo",
        loadEnvFile: false
      })
    ).toThrow("DISCORD_APP_ID is required when BOT_DRY_RUN is false.");
  });

  it("no longer requires env-backed Event Slice E1 guild setup values", () => {
    const config = loadAppConfig({
      env: {
        NODE_ENV: "test",
        BOT_DRY_RUN: "true",
        DATABASE_PATH: "./tmp/test.sqlite"
      },
      cwd: "/repo",
      loadEnvFile: false
    });

    expect(config.databasePath).toBe("/repo/tmp/test.sqlite");
    expect(config.discord).toEqual({
      appId: undefined,
      botToken: undefined
    });
  });
});
