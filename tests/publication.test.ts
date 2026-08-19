import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPublicationConfig } from "../src/publication/config.js";
import { canonicalJson, canonicalProjectionBytes, signProjection } from "../src/publication/signing.js";
import { classifyLanguageEvent } from "../src/publication/classifier.js";
import { buildAgendaPublication, postAgendaPublication, UnsupportedEventsError } from "../src/publication/publish.js";
import { fetchLanguageGuildEvents } from "../src/publication/discord-client.js";
import { publicAgendaId } from "../src/publication/ids.js";
import type { DiscordScheduledEvent } from "../src/publication/types.js";

const baseEnv: NodeJS.ProcessEnv = {
  DISCORD_BOT_TOKEN: "test-token-never-logged",
  DISCORD_TARGET_GUILD_ID: "999999999999999999",
  DISCORD_TARGET_GUILD_NAME: "KaburAjaDulu",
  KAD_PROJECTION_ENDPOINT: "https://staging.example.test/internal/v1/projections/agenda",
  KAD_PROJECTION_KEY_ID: "staging-2026-08-11",
  KAD_PROJECTION_SIGNING_PRIVATE_KEY: "test-private-key",
  KAD_PUBLIC_ID_KEY: "a-public-id-key-that-is-long-enough",
  PUBLICATION_APPROVED: "true"
};

describe("publication configuration", () => {
  it("fails closed when approval is not the exact true string", () => {
    expect(() => loadPublicationConfig({ ...baseEnv, PUBLICATION_APPROVED: "TRUE" })).toThrow(/PUBLICATION_APPROVED/);
  });

  it("defaults unknown events to the fail-closed policy", () => {
    expect(loadPublicationConfig(baseEnv).PUBLICATION_UNKNOWN_EVENT_POLICY).toBe("reject");
    expect(loadPublicationConfig({ ...baseEnv, PUBLICATION_UNKNOWN_EVENT_POLICY: "skip" }).PUBLICATION_UNKNOWN_EVENT_POLICY).toBe("skip");
    expect(() => loadPublicationConfig({ ...baseEnv, PUBLICATION_UNKNOWN_EVENT_POLICY: "ignore" })).toThrow(/PUBLICATION_UNKNOWN_EVENT_POLICY/);
  });

  it("requires every publication secret and endpoint setting", () => {
    const incomplete = { ...baseEnv };
    delete incomplete.KAD_PUBLIC_ID_KEY;
    expect(() => loadPublicationConfig(incomplete)).toThrow(/KAD_PUBLIC_ID_KEY/);
    const missingGuildId = { ...baseEnv };
    delete missingGuildId.DISCORD_TARGET_GUILD_ID;
    expect(() => loadPublicationConfig(missingGuildId)).toThrow(/DISCORD_TARGET_GUILD_ID/);
  });
});

describe("language event publication", () => {
  it("classifies the supported public event families", () => {
    const names = [
      "Japanese for Beginner N5",
      "Japanese for Beginner N4",
      "Japanese Intermediate - N3",
      "Japanese Advanced",
      "日本語 Immersive Learning with Soubi",
      "Arabic Club Session",
      "French Club Study Session",
      "English Practice Session 🇬🇧",
      "Surprise Data Reading for IELTS Writing",
      "Mandarin Study Club"
    ];

    for (const name of names) {
      expect(classifyLanguageEvent(event(name))).not.toBeNull();
    }

    for (const name of ["private English sponsor meeting", "Japanese admin meeting N4", "https://example.test English Practice Session", "English Practice Session @host", "日本語 Immersive Learning with https://evil.example/@host"]) {
      expect(classifyLanguageEvent(event(name))).toBeNull();
    }
  });

  it("rejects an unknown event without publishing", async () => {
    const result = buildAgendaPublication({
      token: "token",
      guildId: baseEnv.DISCORD_TARGET_GUILD_ID!,
      guildName: "KaburAjaDulu",
      keyId: "key",
      signingPrivateKey: privateKeyPem,
      publicIdKey: baseEnv.KAD_PUBLIC_ID_KEY!,
      fetchImpl: discordFetch([event("Secret host AMA with @someone")])
    });
    await expect(result).rejects.toBeInstanceOf(UnsupportedEventsError);
    try {
      await result;
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEventsError);
      expect((error as UnsupportedEventsError).count).toBe(1);
      expect(JSON.stringify(error)).not.toContain("Secret host AMA");
      expect(JSON.stringify(error)).not.toContain("someone");
    }
  });

  it("can explicitly omit unknown staging events without exposing their payload", async () => {
    const result = await buildAgendaPublication({
      token: "token",
      guildId: baseEnv.DISCORD_TARGET_GUILD_ID!,
      guildName: "KaburAjaDulu",
      keyId: "key",
      signingPrivateKey: privateKeyPem,
      publicIdKey: baseEnv.KAD_PUBLIC_ID_KEY!,
      unsupportedEventPolicy: "skip",
      fetchImpl: discordFetch([event("Secret host AMA with @someone", "222222222222222222"), event("English Practice Session", "333333333333333333")])
    });

    expect(result.unsupportedEvents).toBe(1);
    expect(result.projection.entries).toHaveLength(1);
    const serialized = JSON.stringify(result.projection);
    expect(serialized).not.toContain("Secret host AMA");
    expect(serialized).not.toContain("222222222222222222");
  });

  it("rejects a zero-duration source event before signing", async () => {
    const zeroDuration = event("English Practice Session");
    zeroDuration.scheduled_end_time = zeroDuration.scheduled_start_time;
    await expect(buildAgendaPublication({
      token: "token",
      guildId: baseEnv.DISCORD_TARGET_GUILD_ID!,
      guildName: "KaburAjaDulu",
      keyId: "key",
      signingPrivateKey: privateKeyPem,
      publicIdKey: baseEnv.KAD_PUBLIC_ID_KEY!,
      fetchImpl: discordFetch([zeroDuration])
    })).rejects.toThrow("must follow its start time");
  });

  it("publishes only sanitized public fields and never Discord identity material", async () => {
    const result = await buildAgendaPublication({
      token: "token",
      guildId: baseEnv.DISCORD_TARGET_GUILD_ID!,
      guildName: "KaburAjaDulu",
      keyId: "key",
      signingPrivateKey: privateKeyPem,
      publicIdKey: baseEnv.KAD_PUBLIC_ID_KEY!,
      observedAt: new Date("2026-08-11T12:00:00.000Z"),
      fetchImpl: discordFetch([event("日本語 Immersive Learning with Soubi", "123456789012345678")])
    });
    const serialized = JSON.stringify(result.projection);

    expect(result.projection.entries).toHaveLength(1);
    expect(result.projection.entries[0]).toMatchObject({
      title: "Japanese Study Club — immersive",
      program: "Japanese Study Club",
      series: "Immersive",
      joinUrl: "https://discord.gg/RUFFbEaeDx",
      source: "discord_scheduled_event"
    });
    expect(serialized).not.toContain("123456789012345678");
    expect(serialized).not.toContain("Soubi");
    expect(serialized).not.toContain("discord.com/events");
    expect(serialized).not.toContain("@");
    expect(result.projection.tombstones).toEqual([]);
  });
});

describe("projection cryptography", () => {
  it("derives opaque HMAC IDs and signs canonical bytes", () => {
    const id = publicAgendaId("secret-that-is-never-published", "123456789012345678");
    expect(id).toMatch(/^agenda_[A-Za-z0-9_-]{43}$/);
    expect(id).not.toContain("123456789012345678");

    const projection = { schemaVersion: "v1" as const, observedAt: "2026-08-11T12:00:00.000Z", revision: 1, entries: [], tombstones: [] };
    const signature = signProjection(projection, "test-key", privateKeyPem, 1723377600000);
    const body = canonicalJson(projection);
    expect(signature.body).toBe(body);
    expect(signature.contentSha256).toBe(createHash("sha256").update(body).digest("base64url"));
    expect(Number(signature.expiresAt) - Number(signature.issuedAt)).toBe(300000);
    expect(verify(null, canonicalProjectionBytes(signature.issuedAt, signature.expiresAt, signature.nonce, signature.contentSha256, body), publicKey, Buffer.from(signature.signature, "base64url"))).toBe(true);
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));

    const { privateKey: rsaPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => signProjection(projection, "test-key", rsaPrivateKey.export({ format: "pem", type: "pkcs8" }).toString())).toThrow("must be Ed25519");
  });

  it("retries Discord rate limits and rejects malformed or wrong guild responses", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const events = await fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: async (input) => {
        calls += 1;
        if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "30" } });
        const url = String(input);
        return url.endsWith("/users/@me/guilds")
          ? new Response(JSON.stringify([{ id: baseEnv.DISCORD_TARGET_GUILD_ID, name: "KaburAjaDulu" }]), { status: 200 })
          : new Response(JSON.stringify([]), { status: 200 });
      },
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
      timeoutMs: 10
    });
    expect(events).toEqual([]);
    expect(sleeps[0]).toBe(30000);

    await expect(fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: async () => new Response(JSON.stringify([{ id: baseEnv.DISCORD_TARGET_GUILD_ID, name: "KaburAjaDulu", unexpected: true }]), { status: 200 })
    })).rejects.toThrow("schema validation");
  });

  it("accepts the documented fields returned by the live scheduled-event API", async () => {
    const events = await fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: async (input) => String(input).endsWith("/users/@me/guilds")
        ? new Response(JSON.stringify([{ id: baseEnv.DISCORD_TARGET_GUILD_ID, name: "KaburAjaDulu", banner: null }]), { status: 200 })
        : new Response(JSON.stringify([{
          ...event("English Practice Session"),
          entity_id: "222222222222222222",
          recurrence_rule: null,
          guild_scheduled_event_exceptions: [],
          sku_ids: []
        }]), { status: 200 })
    });
    expect(events).toHaveLength(1);
  });

  it("fails closed when Discord omits or changes provenance invariants", async () => {
    const missingPrivacy = { ...event("English Practice Session") } as Partial<DiscordScheduledEvent>;
    delete missingPrivacy.privacy_level;
    await expect(fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: discordFetch([missingPrivacy as DiscordScheduledEvent])
    })).rejects.toThrow("schema validation");

    const wrongGuild = { ...event("English Practice Session"), guild_id: "888888888888888888" };
    await expect(fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: discordFetch([wrongGuild])
    })).rejects.toThrow("guild assertion failed");

    const duplicate = event("English Practice Session");
    await expect(fetchLanguageGuildEvents("token", baseEnv.DISCORD_TARGET_GUILD_ID!, "KaburAjaDulu", {
      fetchImpl: discordFetch([duplicate, { ...duplicate, name: "Japanese for beginner N5" }])
    })).rejects.toThrow("duplicate event identities");
  });

  it("sends the exact canonical signed body and retries projection 429", async () => {
    const result = await buildAgendaPublication({
      token: "token",
      guildId: baseEnv.DISCORD_TARGET_GUILD_ID!,
      guildName: "KaburAjaDulu",
      keyId: "key",
      signingPrivateKey: privateKeyPem,
      publicIdKey: baseEnv.KAD_PUBLIC_ID_KEY!,
      fetchImpl: discordFetch([event("English Practice Session")])
    });
    const bodies: string[] = [];
    let requestHeaders: Headers | undefined;
    let attempts = 0;
    await postAgendaPublication("https://staging.example.test/ingest", result, {
      fetchImpl: async (_input, init) => {
        attempts += 1;
        bodies.push(String(init?.body));
        requestHeaders = new Headers(init?.headers);
        return attempts === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("", { status: 202 });
      },
      sleepImpl: async () => undefined
    });
    expect(attempts).toBe(2);
    expect(new Set(bodies)).toEqual(new Set([result.signature.body]));
    expect(requestHeaders?.get("x-kad-expires-at")).toBe(result.signature.expiresAt);
    expect(requestHeaders?.get("x-kad-content-sha256")).toBe(result.signature.contentSha256);
    expect(requestHeaders?.get("x-kad-signature")).toBe(result.signature.signature);
  });
});

function event(name: string, id = "111111111111111111"): DiscordScheduledEvent {
  return {
    id,
    name,
    description: "host: @private-host https://discord.com/events/111111111111111111",
    scheduled_start_time: "2026-08-12T12:00:00.000Z",
    scheduled_end_time: "2026-08-12T13:00:00.000Z",
    status: 1,
    entity_type: 2,
    privacy_level: 2,
    guild_id: baseEnv.DISCORD_TARGET_GUILD_ID!
  } as DiscordScheduledEvent;
}

function discordFetch(events: DiscordScheduledEvent[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/users/@me/guilds")) return new Response(JSON.stringify([{ id: "999999999999999999", name: "KaburAjaDulu" }]), { status: 200 });
    return new Response(JSON.stringify(events), { status: 200 });
  };
}

const { privateKey: privateKeyObject, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKeyObject.export({ format: "pem", type: "pkcs8" }).toString();
