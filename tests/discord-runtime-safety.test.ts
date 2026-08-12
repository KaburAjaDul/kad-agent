import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/app/config/env.js";
import {
  buildAllowedMentions,
  buildLanguageClubEffectExecutionContext,
  destroyDiscordClient,
  isInteractionGuildAllowed
} from "../src/discord/runtime/start-discord-runtime.js";
import { isAllowedGuildId, registerCommands } from "../src/discord/runtime/register-commands.js";

describe("Discord runtime safety helpers", () => {
  it("propagates the active runtime lease fencing token into event effects", () => {
    expect(buildLanguageClubEffectExecutionContext(
      { leaseKey: "runtime", ownerId: "kaddy:test", fencingToken: 23 },
      { runtimeLease: { durationMs: 30_000, heartbeatIntervalMs: 10_000 } }
    )).toEqual({ ownerId: "kaddy:test", runtimeLeaseName: "runtime", runtimeOwnerId: "kaddy:test", runtimeFencingToken: 23, leaseDurationMs: 30_000 });
  });
  it("fails closed for guilds outside the allowlist", () => {
    expect(isAllowedGuildId("1", ["2"])).toBe(false);
    expect(isInteractionGuildAllowed(null, ["2"])).toBe(false);
    expect(isInteractionGuildAllowed("2", ["2"])).toBe(true);
  });

  it("disables parsing and only allows explicitly trusted user mentions", () => {
    expect(buildAllowedMentions("hello <@123456789012345678>")).toEqual({ parse: [] });
    expect(buildAllowedMentions("hello <@123456789012345678>", ["123456789012345678"])).toEqual({
      parse: [],
      users: ["123456789012345678"]
    });
  });

  it("refuses command registration outside the configured guild allowlist", async () => {
    const config: AppConfig = {
      nodeEnv: "test",
      logLevel: "info",
      botDryRun: true,
      databasePath: ":memory:",
      jobPollIntervalMs: 30_000,
      health: { host: "127.0.0.1", port: 0 },
      discord: {
        allowedGuildIds: ["123456789012345678"]
      }
    };

    await expect(
      registerCommands(config, { dryRun: true, guildId: "987654321098765432" })
    ).rejects.toThrow("outside DISCORD_ALLOWED_GUILD_IDS");
    await expect(
      registerCommands(config, { dryRun: true, guildId: "123456789012345678" })
    ).resolves.toMatchObject({ mode: "dry-run", guildId: "123456789012345678" });
  });

  it("waits for the Discord client teardown", async () => {
    let releaseDestroy: (() => void) | undefined;
    const pendingDestroy = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    let settled = false;
    const destroy = destroyDiscordClient({ destroy: () => pendingDestroy }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDestroy?.();
    await destroy;
    expect(settled).toBe(true);
  });
});
