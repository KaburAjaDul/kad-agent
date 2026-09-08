import { describe, expect, it, vi } from "vitest";
import { DiscordApiError, fetchLanguageGuildEvents } from "../src/publication/discord-client.js";

const guildId = "999999999999999999";
const guildName = "KaburAjaDulu";
const privateMarker = "private-provider-value-never-logged";
const guild = { id: guildId, name: guildName };
const event = {
  id: "111111111111111111",
  guild_id: guildId,
  name: "English Practice Session",
  scheduled_start_time: "2026-09-09T12:00:00.000Z",
  status: 1,
  entity_type: 2,
  privacy_level: 2
};

describe("Discord API response boundary", () => {
  it("accepts additive guild and event fields while stripping them from parsed events", async () => {
    const events = await fetchLanguageGuildEvents("test-token", guildId, guildName, {
      fetchImpl: async (input) => new Response(JSON.stringify(String(input).endsWith("/users/@me/guilds")
        ? [{ ...guild, approximate_member_count: 123, future_guild_metadata: privateMarker }]
        : [{ ...event, future_event_metadata: { note: privateMarker } }]))
    });

    expect(events).toEqual([event]);
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  });

  it.each([
    { name: 42 },
    { id: "invalid-event-id" },
    { scheduled_start_time: "invalid-date" },
    { privacy_level: 1 },
    { entity_type: 9 }
  ])("still rejects invalid known event fields: %j", async (invalid) => {
    await expect(fetchLanguageGuildEvents("test-token", guildId, guildName, {
      fetchImpl: async (input) => new Response(JSON.stringify(String(input).endsWith("/users/@me/guilds")
        ? [guild]
        : [{ ...event, ...invalid, future_event_metadata: privateMarker }]))
    })).rejects.toThrow("Discord API scheduled events response schema validation failed.");
  });

  for (const resource of ["guild list", "scheduled events"] as const) {
    it.each([
      [401, "authentication failed", 1],
      [403, "permission denied", 1],
      [429, "rate limit exceeded after retries", 3],
      [502, "upstream unavailable after retries", 3],
      [404, "request rejected", 1]
    ] as const)(`reports sanitized ${resource} HTTP %i failures without parsing the body`, async (status, reason, attempts) => {
      const failureBodies: Response[] = [];
      const sleep = vi.fn(async () => undefined);
      const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (resource === "scheduled events" && String(input).endsWith("/users/@me/guilds")) {
          return new Response(JSON.stringify([guild]));
        }
        const response = new Response(privateMarker, { status, headers: { "retry-after": "0" } });
        failureBodies.push(response);
        return response;
      });

      const result = fetchLanguageGuildEvents("private-token-never-logged", guildId, guildName, { fetchImpl, sleepImpl: sleep });
      await expect(result).rejects.toBeInstanceOf(DiscordApiError);
      await expect(result).rejects.toMatchObject({
        status,
        message: `Discord API ${resource}: ${reason} (HTTP ${status}).`
      });
      expect(fetchImpl).toHaveBeenCalledTimes(attempts + (resource === "scheduled events" ? 1 : 0));
      expect(sleep).toHaveBeenCalledTimes(attempts - 1);
      expect(failureBodies.every((response) => !response.bodyUsed)).toBe(true);
    });
  }

  it("distinguishes invalid JSON from HTTP and schema errors without exposing the body", async () => {
    await expect(fetchLanguageGuildEvents("test-token", guildId, guildName, {
      fetchImpl: async () => new Response(privateMarker)
    })).rejects.toThrow("Discord API guild list returned invalid JSON.");
  });

  it("does not expose transport errors that contain credentials or provider data", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(privateMarker); });
    await expect(fetchLanguageGuildEvents("test-token", guildId, guildName, {
      fetchImpl,
      sleepImpl: async () => undefined
    })).rejects.toMatchObject({ status: 0, message: "Discord API network request failed after retries." });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
