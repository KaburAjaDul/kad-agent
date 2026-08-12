import { z } from "zod";
import type { DiscordGuild, DiscordScheduledEvent } from "./types.js";

export type DiscordFetch = typeof fetch;

export class DiscordApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export type RetryOptions = {
  fetchImpl?: DiscordFetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
};

const MAX_RETRY_AFTER_MS = 30_000;

const guildSchema = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  name: z.string().min(1),
  icon: z.string().nullable().optional(),
  banner: z.string().nullable().optional(),
  owner: z.boolean().optional(),
  permissions: z.string().optional(),
  features: z.array(z.string()).optional()
}).strict();

const eventSchema = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  scheduled_start_time: z.string().datetime({ offset: true }),
  scheduled_end_time: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.number().int(),
  entity_type: z.union([z.literal(2), z.literal(3)]),
  privacy_level: z.literal(2),
  guild_id: z.string().regex(/^\d{17,20}$/),
  channel_id: z.string().regex(/^\d{17,20}$/).nullable().optional(),
  entity_id: z.string().regex(/^\d{17,20}$/).nullable().optional(),
  entity_metadata: z.record(z.unknown()).nullable().optional(),
  creator_id: z.string().regex(/^\d{17,20}$/).nullable().optional(),
  user_count: z.number().int().nonnegative().optional(),
  image: z.string().nullable().optional(),
  creator: z.record(z.unknown()).nullable().optional(),
  recurrence_rule: z.unknown().nullable().optional(),
  guild_scheduled_event_exceptions: z.array(z.unknown()).optional(),
  sku_ids: z.array(z.string().regex(/^\d{17,20}$/)).optional()
}).strict();

export async function fetchLanguageGuildEvents(token: string, targetGuildId: string, targetGuildName: string, options: RetryOptions = {}): Promise<DiscordScheduledEvent[]> {
  const headers = { Authorization: `Bot ${token}`, Accept: "application/json" };
  const guilds = await discordJson<DiscordGuild[]>("https://discord.com/api/v10/users/@me/guilds", headers, options);
  const matches = guilds.filter((guild) => guild.id === targetGuildId && guild.name === targetGuildName);
  if (matches.length !== 1) throw new Error(`Configured Discord guild assertion did not match exactly one guild named ${targetGuildName}.`);

  const events = await discordJson<DiscordScheduledEvent[]>(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(targetGuildId)}/scheduled-events?with_user_count=false`,
    headers,
    options
  );
  if (events.some((event) => event.guild_id !== targetGuildId)) {
    throw new Error("Discord scheduled-event guild assertion failed.");
  }
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw new Error("Discord scheduled-event response contained duplicate event identities.");
    }
    eventIds.add(event.id);
  }
  return events;
}

async function discordJson<T>(url: string, headers: Record<string, string>, options: RetryOptions): Promise<T> {
  const response = await requestWithRetry(url, headers, options);
  try {
    const body: unknown = await response.json();
    const parsed = url.endsWith("/users/@me/guilds") ? z.array(guildSchema).safeParse(body) : z.array(eventSchema).safeParse(body);
    if (!parsed.success) throw new Error("schema");
    return parsed.data as T;
  } catch {
    throw new Error("Discord API response schema validation failed.");
  }
}

export async function requestWithRetry(url: string, headers: Record<string, string>, options: RetryOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 9000;
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiscordApiError(0, "Network request timed out."));
        }, timeoutMs);
      });
      const response = await Promise.race([fetchImpl(url, { headers, signal: controller.signal }), timeout]);
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryable || attempt === maxAttempts) return response;
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
      await sleepImpl(retryAfter);
    } catch (error) {
      if (attempt === maxAttempts) throw error instanceof Error ? error : new Error("Network request failed.");
      await sleepImpl(250 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new Error("Network request failed.");
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now())) : 250;
}
