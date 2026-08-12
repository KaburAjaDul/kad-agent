import { loadAppConfig } from "../app/config/env.js";
import { toSafeOperationalErrorMessage } from "../app/lib/operational-logger.js";
import { acquireRuntimeLease, releaseRuntimeLease } from "../app/repo/runtime-lease-repo.js";
import { createSqliteConnection } from "../app/repo/sqlite.js";
import { fetchLanguageGuildEvents } from "../publication/discord-client.js";
import { reconcileDiscordScheduledEventObservations } from "../events/service/discord-scheduled-event-observation-service.js";

const dryRun = process.argv.slice(2).includes("--dry-run");

async function main(): Promise<void> {
  const appConfig = loadAppConfig({ requireDiscord: true });
  const guildId = requiredEnv("DISCORD_TARGET_GUILD_ID", appConfig.discord.allowedGuildIds[0]);
  const guildName = requiredEnv("DISCORD_TARGET_GUILD_NAME");
  if (!appConfig.discord.allowedGuildIds.includes(guildId)) {
    throw new Error("Discord target guild is not in the configured allowlist.");
  }
  const token = appConfig.discord.botToken;
  if (!token) throw new Error("Discord bot token is required for scheduled-event reconciliation.");

  const events = await fetchLanguageGuildEvents(token, guildId, guildName);
  // Capture provider observation time only after the REST fetch completes.
  const observedAt = new Date().toISOString();
  if (dryRun) {
    console.log(JSON.stringify({ status: "validated", mode: "dry-run", observed: events.length }));
    return;
  }

  const db = createSqliteConnection(appConfig.databasePath);
  const ownerId = `discord-observation-reconcile:${process.pid}`;
  const lease = acquireRuntimeLease(db, {
    leaseKey: "runtime",
    ownerId,
    now: observedAt,
    leaseDurationMs: appConfig.runtimeLease?.durationMs ?? 30_000
  });
  if (!lease) {
    throw new Error("Discord observation reconciliation could not acquire the runtime lease.");
  }

  try {
    const result = reconcileDiscordScheduledEventObservations({
      db,
      guildId,
      events,
      observedAt,
      context: {
        runtimeLeaseName: lease.leaseKey,
        runtimeOwnerId: lease.ownerId,
        runtimeFencingToken: lease.fencingToken
      }
    });
    console.log(JSON.stringify({ status: "observed", mode: "private-sqlite", ...result }));
  } finally {
    releaseRuntimeLease(db, {
      leaseKey: lease.leaseKey,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      now: new Date().toISOString()
    });
    db.close();
  }
}

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback?.trim();
  if (!value) throw new Error(`${name} is required for Discord observation reconciliation.`);
  return value;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", code: "discord_observation_reconciliation_failed", message: toSafeOperationalErrorMessage(error) }));
  process.exitCode = 1;
});
