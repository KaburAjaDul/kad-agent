import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease, releaseRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import {
  createOrGetPublicProjectionOutbox,
  claimPublicProjectionOutbox,
  finalizePublicProjectionOutbox,
  markPublicProjectionNeedsReconciliation,
  recoverExpiredPublicProjectionOutbox,
  resolvePublicProjectionOutbox,
  renewPublicProjectionOutboxLease,
  type PublicProjectionOutbox
} from "../src/publication/public-projection-outbox-repo.js";

const tempDirectories: string[] = [];
const NOW = "2026-08-12T10:00:00.000Z";
const CONTEXT = { runtimeLeaseName: "publication-runtime", runtimeOwnerId: "worker-a", runtimeFencingToken: 1 } as const;

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kad-public-projection-"));
  tempDirectories.push(directory);
  const db = createSqliteConnection(join(directory, "projection.sqlite"));
  runMigrations(db);
  db.prepare(
    `INSERT INTO discord_scheduled_event_observation_history
      (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
       status_code, entity_type, privacy_level, normalized_title, classification_state,
       classification_category, program_key, reason_code, observation_fingerprint, created_at)
     VALUES (?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, 'present', ?, ?)`
  ).run("observation-1", "discord-event-1", "guild-1", NOW, "Coding Club — ID", "coding", "coding-club", "fingerprint-1", NOW);
  db.prepare(
    `INSERT INTO private_agenda_entries
      (id, source_provider_event_id, source_observation_id, guild_id, projection_type, title,
       summary, program_key, series_key, scheduled_start_at, timezone, agenda_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'language_club_agenda_entry.v1', ?, ?, ?, ?, ?, 'Asia/Jakarta', 'approved', ?, ?)`
  ).run("agenda-1", "discord-event-1", "observation-1", "guild-1", "Coding Club", "Practice", "coding", "coding", "2026-08-13T12:00:00.000Z", NOW, NOW);
  db.prepare(
    `INSERT INTO discord_scheduled_event_observation_history
      (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
       status_code, entity_type, privacy_level, normalized_title, classification_state,
       classification_category, program_key, reason_code, observation_fingerprint, created_at)
     VALUES (?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, 'present', ?, ?)`
  ).run("observation-2", "discord-event-2", "guild-1", NOW, "Coding Club — ID", "coding", "coding-club", "fingerprint-2", NOW);
  db.prepare(
    `INSERT INTO private_agenda_entries
      (id, source_provider_event_id, source_observation_id, guild_id, projection_type, title,
       summary, program_key, series_key, scheduled_start_at, timezone, agenda_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'language_club_agenda_entry.v1', ?, ?, ?, ?, ?, 'Asia/Jakarta', 'approved', ?, ?)`
  ).run("agenda-2", "discord-event-2", "observation-2", "guild-1", "Coding Club", "Practice", "coding", "coding", "2026-08-13T12:00:00.000Z", NOW, NOW);
  acquireRuntimeLease(db, { leaseKey: CONTEXT.runtimeLeaseName, ownerId: CONTEXT.runtimeOwnerId, now: NOW, leaseDurationMs: 60_000 });
  return db;
}

function createItem(db: ReturnType<typeof createSqliteConnection>): PublicProjectionOutbox {
  return createOrGetPublicProjectionOutbox(db, {
    id: "outbox-1",
    triggerAgendaEntryId: "agenda-1",
    projectionRevision: 4,
    payloadJson: '{"schemaVersion":"v1","entries":[]}',
    now: NOW
  });
}

describe("durable public projection outbox", () => {
  it("creates deterministic idempotent pending rows and exposes durability columns", () => {
    const db = fixture();
    const first = createItem(db);
    const second = createOrGetPublicProjectionOutbox(db, {
      triggerAgendaEntryId: "agenda-2", projectionRevision: 4, payloadJson: '{"schemaVersion":"v1","entries":[]}', now: NOW
    });
    expect(second).toMatchObject({ id: first.id, state: "pending", attempts: 0, fencingToken: 0, triggerAgendaEntryId: "agenda-1" });
    expect(first.deterministicKey).toMatch(/^sha256:/);
    expect(first.idempotencyKey).toContain(first.deterministicKey);
    expect(first.contentHash).toBe(`sha256:${createHash("sha256").update(first.payloadJson, "utf8").digest("hex")}`);
    expect(db.prepare("PRAGMA table_info(public_projection_outbox)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runtime_lease_name" }),
      expect.objectContaining({ name: "runtime_owner_id" }),
      expect.objectContaining({ name: "runtime_fencing_token" }),
      expect.objectContaining({ name: "content_hash" })
    ]));
  });

  it("rejects a caller hash that is not the SHA-256 of payloadJson", () => {
    const db = fixture();
    expect(() => createOrGetPublicProjectionOutbox(db, {
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 4,
      payloadJson: '{"schemaVersion":"v1","entries":[]}',
      contentHash: "sha256:not-the-payload",
      now: NOW
    })).toThrow(/contentHash does not match payloadJson/);
  });

  it("rejects a different payload at an already authoritative revision", () => {
    const db = fixture();
    createItem(db);
    expect(() => createOrGetPublicProjectionOutbox(db, {
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 4,
      payloadJson: '{"schemaVersion":"v1","entries":[{"id":"different"}]}',
      now: NOW
    })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox").get()).toMatchObject({ count: 1 });
  });

  it("claims, renews, and finalizes only with active runtime and item fences", () => {
    const db = fixture();
    const item = createItem(db);
    const claimed = claimPublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", now: NOW, leaseDurationMs: 10_000 });
    expect(claimed).toMatchObject({ state: "leased", leaseOwner: "publisher-a", attempts: 1, fencingToken: 1 });
    expect(renewPublicProjectionOutboxLease(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: 1, now: "2026-08-12T10:00:01.000Z" })).toBe(true);
    expect(finalizePublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: 1, now: "2026-08-12T10:00:02.000Z" })).toBe(true);
    expect(db.prepare("SELECT state, published_at, lease_owner FROM public_projection_outbox WHERE id = ?").get(item.id)).toMatchObject({ state: "succeeded", lease_owner: null });
    expect(finalizePublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: 1, now: "2026-08-12T10:00:03.000Z" })).toBe(false);
  });

  it("fails closed after runtime takeover and recovers an expired lease for reconciliation", () => {
    const db = fixture();
    const item = createItem(db);
    const claimed = claimPublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", now: NOW, leaseDurationMs: 100 });
    expect(claimed).not.toBeNull();
    expect(releaseRuntimeLease(db, { leaseKey: CONTEXT.runtimeLeaseName, ownerId: CONTEXT.runtimeOwnerId, fencingToken: CONTEXT.runtimeFencingToken, now: "2026-08-12T10:00:00.100Z" })).toBe(true);
    acquireRuntimeLease(db, { leaseKey: CONTEXT.runtimeLeaseName, ownerId: "worker-b", now: "2026-08-12T10:00:00.101Z", leaseDurationMs: 60_000 });
    expect(renewPublicProjectionOutboxLease(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: 1, now: "2026-08-12T10:00:01.000Z" })).toBe(false);
    const replacement = { runtimeLeaseName: CONTEXT.runtimeLeaseName, runtimeOwnerId: "worker-b", runtimeFencingToken: 2 } as const;
    expect(recoverExpiredPublicProjectionOutbox(db, { ...replacement, now: "2026-08-12T10:00:01.000Z" })).toBe(1);
    expect(resolvePublicProjectionOutbox(db, { ...replacement, id: item.id, resolution: "retryable", now: "2026-08-12T10:00:02.000Z" })).toBe(true);
    expect(db.prepare("SELECT state, lease_owner FROM public_projection_outbox WHERE id = ?").get(item.id)).toMatchObject({ state: "retryable", lease_owner: null });
  });

  it("moves ambiguous outcomes to reconciliation and resolves them with a live runtime fence", () => {
    const db = fixture();
    const item = createItem(db);
    expect(claimPublicProjectionOutbox(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", now: NOW, leaseDurationMs: 10_000 })).not.toBeNull();
    expect(markPublicProjectionNeedsReconciliation(db, { ...CONTEXT, id: item.id, ownerId: "publisher-a", fencingToken: 1, error: new Error("timeout"), now: "2026-08-12T10:00:01.000Z" })).toBe(true);
    expect(resolvePublicProjectionOutbox(db, { ...CONTEXT, id: item.id, resolution: "succeeded", now: "2026-08-12T10:00:02.000Z" })).toBe(true);
    expect(db.prepare("SELECT state, last_error FROM public_projection_outbox WHERE id = ?").get(item.id)).toMatchObject({ state: "succeeded", last_error: null });
  });
});
