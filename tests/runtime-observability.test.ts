import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "../src/app/config/env.js";
import { createOperationalMetrics } from "../src/app/runtime/operational-metrics.js";
import { startHealthServer } from "../src/app/runtime/health-server.js";
import { assertDiscordIdentityAndGuilds, KADDY_GATEWAY_INTENTS } from "../src/discord/runtime/start-discord-runtime.js";
import { GatewayIntentBits } from "discord.js";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { createOrGetExternalEffectIntent, getExternalEffectIntent } from "../src/events/repo/external-effect-intent-repo.js";
import { BackgroundJobRunner } from "../src/app/runtime/job-runner.js";

describe("Kaddy runtime mode and observability", () => {
  it("defaults live configuration to observe mode", () => {
    const config = loadAppConfig({
      env: { NODE_ENV: "test", BOT_DRY_RUN: "false", DISCORD_APP_ID: "123456789012345678", DISCORD_BOT_TOKEN: "token", DISCORD_ALLOWED_GUILD_IDS: "123456789012345678" },
      loadEnvFile: false
    });
    expect(config.runtimeMode).toBe("observe");
    expect(config.runtimeLease?.durationMs).toBe(30_000);
  });

  it("supports file-backed Discord configuration and rejects ambiguous sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "kaddy-config-"));
    const appIdFile = join(directory, "app-id");
    const tokenFile = join(directory, "token");
    const guildsFile = join(directory, "guilds");
    writeFileSync(appIdFile, "123456789012345678\n");
    writeFileSync(tokenFile, "file-token\n");
    writeFileSync(guildsFile, "123456789012345678\n");
    try {
      const config = loadAppConfig({
        env: { NODE_ENV: "test", BOT_DRY_RUN: "false", DISCORD_APP_ID_FILE: appIdFile, DISCORD_BOT_TOKEN_FILE: tokenFile, DISCORD_ALLOWED_GUILD_IDS_FILE: guildsFile },
        loadEnvFile: false
      });
      expect(config.discord.botToken).toBe("file-token");
      expect(() => loadAppConfig({ env: { NODE_ENV: "test", BOT_DRY_RUN: "false", DISCORD_APP_ID: "123456789012345678", DISCORD_APP_ID_FILE: appIdFile }, loadEnvFile: false })).toThrow("cannot both");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when identity or every allowlisted guild is not visible", () => {
    const client = { user: { id: "123456789012345678" }, guilds: { cache: new Map([["123456789012345678", {}]]) } };
    expect(() => assertDiscordIdentityAndGuilds(client, "987654321098765432", ["123456789012345678"])).toThrow("identity");
    expect(() => assertDiscordIdentityAndGuilds(client, "123456789012345678", ["987654321098765432"])).toThrow("allowlist");
    expect(() => assertDiscordIdentityAndGuilds(client, "123456789012345678", ["123456789012345678"])).not.toThrow();
  });

  it("requests only non-privileged guild and scheduled-event intents", () => {
    expect(KADDY_GATEWAY_INTENTS).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents]);
  });

  it("counts one lease loss once even when readiness is also invalidated", () => {
    const metrics = createOperationalMetrics();
    metrics.setLeaseState("held");
    metrics.recordLeaseLoss();
    metrics.setGatewayReady(false);
    expect((metrics.snapshot().counters as { lease_losses_total: number }).lease_losses_total).toBe(1);
  });

  it("serves aggregate metrics without identifiers or content", async () => {
    const metrics = createOperationalMetrics();
    metrics.setGatewayReady(true);
    metrics.setLeaseState("held");
    metrics.recordInteraction("success");
    const health = await startHealthServer({ port: 0, metrics });
    try {
      const response = await fetch(`http://${health.address.host}:${health.address.port}/metrics`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("kaddy_gateway_ready 1");
      expect(body).not.toMatch(/123456789012345678|secret|message content/i);
    } finally {
      await health.close();
    }
  });

  it("keeps metrics private on non-loopback listeners unless explicitly enabled", async () => {
    const metrics = createOperationalMetrics();
    const hidden = await startHealthServer({ host: "0.0.0.0", port: 0, metrics });
    const exposed = await startHealthServer({ host: "0.0.0.0", port: 0, metrics, exposePrivateMetrics: true });
    try {
      expect((await fetch(`http://127.0.0.1:${hidden.address.port}/metrics`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${exposed.address.port}/metrics`)).status).toBe(200);
    } finally {
      await hidden.close();
      await exposed.close();
    }
  });

  it("does not recover external effects in observe mode", async () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      const intent = createOrGetExternalEffectIntent(db, { kind: "test", authorityId: "authority", guildId: "123456789012345678", now: "2026-01-01T00:00:00.000Z" });
      db.prepare("UPDATE external_effect_intents SET state = 'leased', lease_owner = 'old', lease_expires_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(intent.id);
      const runner = new BackgroundJobRunner(db, { mode: "observe" });
      await runner.deliverReminderSweep({ publishReminder: async () => ({ messageId: "unused" }) }, new Date("2026-01-01T00:01:00.000Z"));
      expect(getExternalEffectIntent(db, intent.id)?.state).toBe("leased");
    } finally {
      db.close();
    }
  });

  it("refreshes DB-backed queue, reconciliation, storage, and timestamp gauges", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      const intent = createOrGetExternalEffectIntent(db, { kind: "test", authorityId: "authority", guildId: "123456789012345678", now: "2026-01-01T00:00:00.000Z" });
      db.prepare("UPDATE external_effect_intents SET state = 'needs_reconciliation' WHERE id = ?").run(intent.id);
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("INSERT INTO event_reminders (id,event_id,reminder_type,audience_kind,scheduled_for,state,job_key,payload_json,created_at,updated_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("r1", "e1", "t_minus_1h", "staff", "2026-01-01T00:00:00.000Z", "pending", "job-r1", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2025-12-31T23:59:00.000Z");
      const metrics = createOperationalMetrics({ now: () => new Date("2026-01-01T00:01:00.000Z") });
      metrics.refreshFromDatabase(db);
      const body = metrics.renderPrometheus();
      expect(body).toContain("kaddy_reminder_queue_oldest_due_age_seconds 120");
      expect(body).toContain("kaddy_reconciliation_backlog 1");
      expect(body).toMatch(/kaddy_sqlite_logical_bytes [1-9]\d*/);
      expect(body).toContain("kaddy_metrics_refresh_timestamp_seconds 1767225660");
      expect(body).not.toContain("r1");
    } finally {
      db.close();
    }
  });
});
