import type { RuntimeLeaseContext } from "../../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import {
  fetchLanguageGuildEvents,
  type DiscordFetch,
  type RetryOptions
} from "../../publication/discord-client.js";
import {
  reconcileDiscordScheduledEventObservations,
  type DiscordObservationReconciliationResult
} from "./discord-scheduled-event-observation-service.js";

/**
 * Dependencies for one complete scheduled-event observation pass.
 *
 * The source is deliberately REST-only: a Gateway event is a delta and must
 * never be passed to the snapshot reconciler as though it were a complete
 * guild listing.
 */
export type DiscordScheduledEventObservationSweepOptions = {
  db: SqliteDatabase;
  token: string;
  guildId: string;
  guildName: string;
  context: RuntimeLeaseContext;
  fetchImpl?: DiscordFetch;
  sleepImpl?: RetryOptions["sleepImpl"];
  timeoutMs?: number;
  maxAttempts?: number;
  /** Trusted local clock. Provider timestamps are never used for lease validity. */
  clock?: () => Date;
};

export type DiscordScheduledEventObservationAggregate = DiscordObservationReconciliationResult;
export type DiscordScheduledEventObservationSweepResult = DiscordScheduledEventObservationAggregate & {
  /** Canonical trusted-local timestamp used for this complete snapshot. */
  observedAt: string;
};

/**
 * Fetches and reconciles one complete REST snapshot.
 *
 * `fetchLanguageGuildEvents` validates the exact guild identity, response
 * schema, event guild identity, and duplicate event IDs before this function
 * calls the SQLite reconciler. Consequently REST/identity/schema/duplicate
 * failures fail closed without a SQLite mutation.
 */
export async function runDiscordScheduledEventObservationSweep(
  options: DiscordScheduledEventObservationSweepOptions
): Promise<DiscordScheduledEventObservationSweepResult> {
  assertSweepOptions(options);
  const clock = options.clock ?? (() => new Date());
  const events = await fetchLanguageGuildEvents(options.token, options.guildId, options.guildName, {
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts
  });

  // Capture the observation time only after the complete REST response has
  // passed validation. No provider timestamp can advance the local clock.
  const observedAt = asIso(clock());
  const result = reconcileDiscordScheduledEventObservations({
    db: options.db,
    guildId: options.guildId,
    events,
    context: options.context,
    observedAt,
    // Keep SQLite mutation time tied to the same trusted local sample that
    // is returned to the caller; provider timestamps never enter this path.
    now: () => new Date(observedAt)
  });
  return { ...result, observedAt };
}

export type DiscordScheduledEventObservationPeriodicOptions = DiscordScheduledEventObservationSweepOptions & {
  /** Delay between successful complete snapshots. */
  intervalMs: number;
  /** Hard upper bound; the loop never runs forever. */
  maxSweeps: number;
};

export type DiscordScheduledEventObservationPeriodicResult = DiscordScheduledEventObservationAggregate & {
  /** Canonical timestamp of the final successful complete snapshot. */
  lastObservedAt: string;
};

/**
 * Runs a bounded sequence of complete REST snapshots and returns counts only.
 * The interval is not slept after the final sweep. Any failed fetch or unsafe
 * snapshot rejects the whole call and leaves that sweep's SQLite transaction
 * untouched.
 */
export async function runDiscordScheduledEventObservationPeriodic(
  options: DiscordScheduledEventObservationPeriodicOptions
): Promise<DiscordScheduledEventObservationPeriodicResult> {
  assertPeriodicOptions(options);
  const sleep = options.sleepImpl ?? defaultSleep;
  const aggregate = emptyAggregate();
  let lastObservedAt: string | undefined;

  for (let index = 0; index < options.maxSweeps; index += 1) {
    const result = await runDiscordScheduledEventObservationSweep(options);
    addAggregate(aggregate, result);
    lastObservedAt = result.observedAt;
    if (index + 1 < options.maxSweeps) await sleep(options.intervalMs);
  }

  // maxSweeps is validated as positive above, so a successful loop always has
  // one canonical timestamp to expose.
  if (!lastObservedAt) throw new Error("Discord observation periodic sweep produced no timestamp.");
  return { ...aggregate, lastObservedAt };
}

function assertSweepOptions(options: DiscordScheduledEventObservationSweepOptions): void {
  if (!/^\d{17,20}$/.test(options.guildId)) {
    throw new Error("Discord observation target guild ID is invalid.");
  }
  if (options.guildName.length === 0) {
    throw new Error("Discord observation target guild name is required.");
  }
  if (options.token.length === 0) {
    throw new Error("Discord observation bot token is required.");
  }
  if (!options.context.runtimeLeaseName || !options.context.runtimeOwnerId || !Number.isInteger(options.context.runtimeFencingToken) || options.context.runtimeFencingToken <= 0) {
    throw new Error("Discord observation runtime lease context is invalid.");
  }
}

function assertPeriodicOptions(options: DiscordScheduledEventObservationPeriodicOptions): void {
  assertSweepOptions(options);
  if (!Number.isInteger(options.maxSweeps) || options.maxSweeps < 1) {
    throw new Error("Discord observation periodic sweep bound must be a positive integer.");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new Error("Discord observation periodic sweep interval must be non-negative.");
  }
}

function asIso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Discord observation clock returned an invalid date.");
  }
  return value.toISOString();
}

function emptyAggregate(): DiscordScheduledEventObservationAggregate {
  return {
    observed: 0,
    present: 0,
    unknown: 0,
    rejected: 0,
    tombstoned: 0,
    disappeared: 0,
    pendingAgendaEntries: 0,
    withdrawnAgendaEntries: 0
  };
}

function addAggregate(
  aggregate: DiscordScheduledEventObservationAggregate,
  result: DiscordScheduledEventObservationAggregate
): void {
  aggregate.observed += result.observed;
  aggregate.present += result.present;
  aggregate.unknown += result.unknown;
  aggregate.rejected += result.rejected;
  aggregate.tombstoned += result.tombstoned;
  aggregate.disappeared += result.disappeared;
  aggregate.pendingAgendaEntries += result.pendingAgendaEntries;
  aggregate.withdrawnAgendaEntries += result.withdrawnAgendaEntries;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
