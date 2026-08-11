import { publicAgendaId } from "./ids.js";
import { classifyLanguageEvent, publicEntryFor, type AgendaCategory } from "./classifier.js";
import { fetchLanguageGuildEvents, type DiscordFetch, type RetryOptions } from "./discord-client.js";
import { signProjection } from "./signing.js";
import type { AgendaProjection, PublicationResult } from "./types.js";

let lastRevision = 0;
const MAX_RETRY_AFTER_MS = 30_000;

export async function buildAgendaPublication(options: {
  token: string;
  guildId: string;
  guildName: string;
  keyId: string;
  signingPrivateKey: string;
  publicIdKey: string;
  observedAt?: Date;
  fetchImpl?: DiscordFetch;
  sleepImpl?: RetryOptions["sleepImpl"];
  timeoutMs?: number;
  maxAttempts?: number;
}): Promise<PublicationResult> {
  const observedAt = options.observedAt ?? new Date();
  const events = await fetchLanguageGuildEvents(options.token, options.guildId, options.guildName, {
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts
  });
  let unsupportedCount = 0;
  const categories: Record<string, number> = {};
  const entries = [];

  for (const event of events) {
    // Completed and canceled source events are not public agenda entries. They
    // are intentionally omitted before classification so an old unrelated
    // event cannot block the current snapshot.
    if (event.status === 3 || event.status === 4) continue;
    const classification = classifyLanguageEvent(event);
    if (!classification) {
      unsupportedCount += 1;
      continue;
    }
    const entry = publicEntryFor(event, publicAgendaId(options.publicIdKey, event.id), classification);
    entries.push(entry);
    categories[classification.category] = (categories[classification.category] ?? 0) + 1;
  }

  if (unsupportedCount > 0) {
    throw new UnsupportedEventsError(unsupportedCount);
  }

  const projection: AgendaProjection = {
    schemaVersion: "v1",
    observedAt: observedAt.toISOString(),
    revision: nextRevision(observedAt.getTime()),
    entries: entries.sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id)),
    tombstones: []
  };

  return {
    projection,
    signature: signProjection(projection, options.keyId, options.signingPrivateKey),
    categories
  };
}

export async function postAgendaPublication(endpoint: string, result: PublicationResult, options: RetryOptions = {}): Promise<void> {
  const response = await requestProjectionWithRetry(endpoint, result, options);
  if (!response.ok) throw new Error(`Projection endpoint rejected publication with HTTP ${response.status}.`);
}

async function requestProjectionWithRetry(endpoint: string, result: PublicationResult, options: RetryOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 9000;
  const maxAttempts = options.maxAttempts ?? 3;
  const headers = {
    "content-type": "application/json",
    "x-kad-schema-version": result.signature.schemaVersion,
    "x-kad-key-id": result.signature.keyId,
    "x-kad-issued-at": result.signature.issuedAt,
    "x-kad-expires-at": result.signature.expiresAt,
    "x-kad-nonce": result.signature.nonce,
    "x-kad-content-sha256": result.signature.contentSha256,
    "x-kad-signature": result.signature.signature
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Projection request timed out."));
        }, timeoutMs);
      });
      const response = await Promise.race([fetchImpl(endpoint, { method: "POST", headers, body: result.signature.body, signal: controller.signal }), timeout]);
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryable || attempt === maxAttempts) return response;
      await sleepImpl(retryAfterMilliseconds(response.headers.get("retry-after")));
    } catch (error) {
      if (attempt === maxAttempts) throw error instanceof Error ? error : new Error("Projection request failed.");
      await sleepImpl(250 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new Error("Projection request failed.");
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now())) : 250;
}

function nextRevision(now: number): number {
  lastRevision = Math.max(lastRevision + 1, now);
  return lastRevision;
}

export class UnsupportedEventsError extends Error {
  constructor(public readonly count: number) {
    super(`Unsupported Discord scheduled events: ${count}.`);
    this.name = "UnsupportedEventsError";
  }
}

export function publicationSummary(result: PublicationResult): { entries: number; categories: Record<string, number>; revision: number } {
  return { entries: result.projection.entries.length, categories: result.categories, revision: result.projection.revision };
}

export type { AgendaCategory };
