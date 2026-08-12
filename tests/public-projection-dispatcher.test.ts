import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { createOrGetPublicProjectionOutbox, claimPublicProjectionOutbox, markPublicProjectionNeedsReconciliation } from "../src/publication/public-projection-outbox-repo.js";
import { dispatchOnePublicProjection, reconcilePublicProjection } from "../src/publication/public-projection-dispatcher.js";
import { PublicProjectionHttpClient } from "../src/publication/public-projection-http-client.js";

const NOW = "2026-08-12T10:00:00.000Z";
const CONTEXT = { runtimeLeaseName: "publication-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: 1 } as const;
const tempDirectories: string[] = [];

afterEach(() => { while (tempDirectories.length) rmSync(tempDirectories.pop() as string, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kad-public-dispatch-"));
  tempDirectories.push(directory);
  const db = createSqliteConnection(join(directory, "projection.sqlite"));
  runMigrations(db);
  db.prepare(`INSERT INTO discord_scheduled_event_observation_history
    (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
     status_code, entity_type, privacy_level, normalized_title, classification_state,
     classification_category, program_key, reason_code, observation_fingerprint, created_at)
    VALUES ('observation-1', 'discord-event-1', 'guild-1', ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2,
      'Japanese Study Club', 'allowlisted', 'japanese_n5', 'japanese-study-club', 'present', 'fingerprint-1', ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO private_agenda_entries
    (id, source_provider_event_id, source_observation_id, guild_id, projection_type, title, summary,
     program_key, series_key, scheduled_start_at, timezone, agenda_state, created_at, updated_at)
    VALUES ('agenda-1', 'discord-event-1', 'observation-1', 'guild-1', 'language_club_agenda_entry.v1',
      'Japanese Study Club', 'Practice', 'japanese-study-club', 'n5', '2026-08-13T12:00:00.000Z', 'Asia/Jakarta', 'approved', ?, ?)`).run(NOW, NOW);
  acquireRuntimeLease(db, { leaseKey: CONTEXT.runtimeLeaseName, ownerId: CONTEXT.runtimeOwnerId, now: NOW, leaseDurationMs: 60_000 });
  return db;
}

function projection() {
  return {
    schemaVersion: "v1" as const,
    observedAt: NOW,
    revision: 7,
    entries: [{
      id: "agenda_public_1", title: "Japanese Study Club", summary: "Practice", startAt: "2026-08-13T12:00:00.000Z", endAt: null,
      timezone: "Asia/Jakarta" as const, status: "scheduled" as const, program: "Japanese Study Club", series: "N5", joinUrl: "https://discord.gg/RUFFbEaeDx" as const, source: "discord_scheduled_event" as const
    }],
    tombstones: ["agenda_public_removed"]
  };
}

function setup() {
  const db = fixture();
  const body = JSON.stringify(projection());
  const item = createOrGetPublicProjectionOutbox(db, { id: "projection-1", triggerAgendaEntryId: "agenda-1", projectionRevision: 7, payloadJson: body, now: NOW });
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const options = {
    ...CONTEXT, db, ownerId: "publisher-a", endpoint: "https://public.example/internal/v1/projections/agenda", reconciliationEndpoint: "https://public.example/api/v1/agenda", keyId: "k1", signingPrivateKey: privateKey,
    now: () => new Date(NOW), timeoutMs: 100
  };
  return { db, item, options, body };
}

describe("durable public projection dispatcher", () => {
  it("rejects non-HTTPS or cross-origin publication endpoints", () => {
    expect(() => new PublicProjectionHttpClient({ endpoint: "http://public.example/internal/v1/projections/agenda", reconciliationEndpoint: "https://public.example/api/v1/agenda" })).toThrow(/HTTPS/);
    expect(() => new PublicProjectionHttpClient({ endpoint: "https://internal.example/internal/v1/projections/agenda", reconciliationEndpoint: "https://public.example/api/v1/agenda" })).toThrow(/same HTTPS origin/);
    expect(() => new PublicProjectionHttpClient({ endpoint: "https://public.example/wrong", reconciliationEndpoint: "https://public.example/api/v1/agenda" })).toThrow(/exact/);
  });

  it("signs and sends one exact body, then finalizes a 2xx response", async () => {
    const { db, options, body } = setup();
    let calls = 0;
    const result = await dispatchOnePublicProjection({ ...options, fetchImpl: async (_input, init) => {
      calls += 1;
      expect(String(_input)).toBe("https://public.example/internal/v1/projections/agenda");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(body);
      expect(init?.headers).toMatchObject({ "x-kad-idempotency-key": expect.any(String) });
      return new Response("", { status: 202 });
    } });
    expect(result).toMatchObject({ kind: "published", status: 202 });
    expect(calls).toBe(1);
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = 'projection-1'").get()).toMatchObject({ state: "succeeded" });
  });

  it("never retries an ambiguous POST and sends it to reconciliation", async () => {
    const { db, options } = setup();
    let calls = 0;
    const result = await dispatchOnePublicProjection({ ...options, fetchImpl: async () => { calls += 1; throw new Error("socket closed"); } });
    expect(result).toMatchObject({ kind: "needs_reconciliation" });
    expect(calls).toBe(1);
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = 'projection-1'").get()).toMatchObject({ state: "needs_reconciliation" });
  });

  it("reconciles an ambiguous item only when revision, observedAt, and complete entries match", async () => {
    const { db, options, item, body } = setup();
    const claimed = claimPublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", now: NOW });
    expect(claimed).not.toBeNull();
    expect(markPublicProjectionNeedsReconciliation(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: claimed?.fencingToken, now: NOW, error: "timeout" })).toBe(true);
    const workerRead = JSON.stringify({ schemaVersion: "v1", generatedAt: NOW, observedAt: NOW, revision: 7, sourceStatus: "fresh", staleAt: "2026-08-12T10:45:00.000Z", entries: projection().entries });
    const result = await reconcilePublicProjection({ ...options, fetchImpl: async (input, init) => {
      expect(String(input)).toBe("https://public.example/api/v1/agenda");
      expect(init?.method).toBe("GET");
      return new Response(workerRead, { status: 200 });
    } }, item.id);
    expect(result).toMatchObject({ kind: "succeeded", revision: 7 });
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = 'projection-1'").get()).toMatchObject({ state: "succeeded" });
  });

  it("rejects private or legacy fields in the Worker read DTO", async () => {
    const { db, options, item } = setup();
    const claimed = claimPublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", now: NOW });
    expect(claimed).not.toBeNull();
    expect(markPublicProjectionNeedsReconciliation(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: claimed?.fencingToken, now: NOW, error: "timeout" })).toBe(true);
    const workerRead = { schemaVersion: "v1", generatedAt: NOW, observedAt: NOW, revision: 7, sourceStatus: "fresh", staleAt: "2026-08-12T10:45:00.000Z", entries: projection().entries, privateAgenda: [] };
    const result = await reconcilePublicProjection({ ...options, fetchImpl: async () => new Response(JSON.stringify(workerRead), { status: 200 }) }, item.id);
    expect(result.kind).toBe("retryable");
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = 'projection-1'").get()).toMatchObject({ state: "retryable" });
  });

  it("classifies definite overloads as bounded retryable work", async () => {
    const { db, options } = setup();
    const result = await dispatchOnePublicProjection({ ...options, fetchImpl: async () => new Response("", { status: 503, headers: { "retry-after": "9999" } }) });
    expect(result.kind).toBe("retryable");
    const row = db.prepare("SELECT state, next_attempt_at FROM public_projection_outbox WHERE id = 'projection-1'").get() as { state: string; next_attempt_at: string };
    expect(row.state).toBe("retryable");
    expect(Date.parse(row.next_attempt_at) - Date.parse(NOW)).toBe(30_000);
  });

  it("renews the outbox lease while one bounded POST is in flight", async () => {
    const { db, options } = setup();
    const wallNow = new Date();
    db.prepare("UPDATE runtime_leases SET expires_at = ?").run(new Date(wallNow.getTime() + 60_000).toISOString());
    const result = await dispatchOnePublicProjection({
      ...options,
      now: () => new Date(),
      leaseDurationMs: 30,
      leaseHeartbeatIntervalMs: 5,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return new Response("", { status: 202 });
      }
    });
    expect(result).toMatchObject({ kind: "published", status: 202 });
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = 'projection-1'").get()).toMatchObject({ state: "succeeded" });
  });
});
