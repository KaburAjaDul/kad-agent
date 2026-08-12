import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import {
  buildExternalEffectDeterministicKey,
  claimExternalEffectIntent,
  createOrGetExternalEffectIntent,
  markExternalEffectSucceeded,
  markExternalEffectNeedsReconciliation,
  recoverExpiredExternalEffectIntents,
  resolveExternalEffectReconciliation
} from "../src/events/repo/external-effect-intent-repo.js";

describe("external effect intent durability", () => {
  it("deduplicates by deterministic key and never retries an expired ambiguous lease", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      acquireRuntimeLease(db, { leaseKey: "test-runtime", ownerId: "worker", now: "2026-01-01T00:00:00.000Z", leaseDurationMs: 3_600_000 });
      const deterministicKey = buildExternalEffectDeterministicKey({ guildId: "g1", kind: "reminder", authorityId: "r1" });
      const first = createOrGetExternalEffectIntent(db, { deterministicKey, kind: "reminder", authorityId: "r1", guildId: "g1", now: "2026-01-01T00:00:00.000Z" });
      const duplicate = createOrGetExternalEffectIntent(db, { deterministicKey, kind: "reminder", authorityId: "r1", guildId: "g1", now: "2026-01-01T00:00:01.000Z" });
      expect(duplicate.id).toBe(first.id);
      const lease = claimExternalEffectIntent(db, { id: first.id, ownerId: "worker", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", now: "2026-01-01T00:00:00.000Z", leaseDurationMs: 100 });
      expect(lease?.fencingToken).toBe(1);
      expect(recoverExpiredExternalEffectIntents(db, { now: "2026-01-01T00:00:00.101Z", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", runtimeFencingToken: 1 })).toBe(1);
      expect(markExternalEffectNeedsReconciliation(db, { id: first.id, ownerId: "worker", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", fencingToken: lease?.fencingToken, now: "2026-01-01T00:00:00.200Z" })).toBe(false);
      expect(db.prepare("SELECT state FROM external_effect_intents WHERE id = ?").get(first.id)).toEqual({ state: "needs_reconciliation" });
      expect(resolveExternalEffectReconciliation(db, { id: first.id, resolution: "retryable", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", nextAttemptAt: "2026-01-01T00:01:00.000Z", now: "2026-01-01T00:00:00.300Z" })).toBe(true);
      expect(db.prepare("SELECT state, next_attempt_at FROM external_effect_intents WHERE id = ?").get(first.id)).toEqual({ state: "retryable", next_attempt_at: "2026-01-01T00:01:00.000Z" });
      const leaseA = claimExternalEffectIntent(db, { id: first.id, ownerId: "worker", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", now: "2026-01-01T00:01:00.000Z", leaseDurationMs: 100 });
      expect(leaseA?.fencingToken).toBe(2);
      expect(resolveExternalEffectReconciliation(db, { id: first.id, resolution: "retryable", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", nextAttemptAt: "2026-01-01T00:02:00.000Z", now: "2026-01-01T00:01:00.101Z" })).toBe(false);
      expect(recoverExpiredExternalEffectIntents(db, { now: "2026-01-01T00:01:00.101Z", runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", runtimeFencingToken: 1 })).toBe(1);
      expect(resolveExternalEffectReconciliation(db, { id: first.id, resolution: "retryable", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", nextAttemptAt: "2026-01-01T00:02:00.000Z", now: "2026-01-01T00:01:00.102Z" })).toBe(true);
      const leaseB = claimExternalEffectIntent(db, { id: first.id, ownerId: "worker", runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", now: "2026-01-01T00:02:00.000Z", leaseDurationMs: 1_000 });
      expect(leaseB?.fencingToken).toBe(3);
      expect(markExternalEffectSucceeded(db, { id: first.id, ownerId: "worker", fencingToken: leaseA?.fencingToken, runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", externalReference: "stale", now: "2026-01-01T00:02:00.001Z" })).toBe(false);
      expect(markExternalEffectSucceeded(db, { id: first.id, ownerId: "worker", fencingToken: leaseB?.fencingToken, runtimeFencingToken: 1, runtimeLeaseName: "test-runtime", runtimeOwnerId: "worker", externalReference: "current", now: "2026-01-01T00:02:00.002Z" })).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects an old runtime lease after takeover even while the effect lease remains valid", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      const effect = createOrGetExternalEffectIntent(db, { kind: "reminder", authorityId: "takeover", guildId: "g1", now: "2026-01-01T00:00:00.000Z" });
      const runtimeA = acquireRuntimeLease(db, { leaseKey: "takeover-runtime", ownerId: "a", now: "2026-01-01T00:00:00.000Z", leaseDurationMs: 100 });
      const claimed = claimExternalEffectIntent(db, {
        id: effect.id,
        ownerId: "worker-a",
        runtimeLeaseName: "takeover-runtime",
        runtimeOwnerId: "a",
        runtimeFencingToken: runtimeA?.fencingToken ?? 0,
        now: "2026-01-01T00:00:00.000Z",
        leaseDurationMs: 10_000
      });
      const runtimeB = acquireRuntimeLease(db, { leaseKey: "takeover-runtime", ownerId: "b", now: "2026-01-01T00:00:00.101Z", leaseDurationMs: 10_000 });
      expect(runtimeB?.fencingToken).toBe(2);
      expect(markExternalEffectSucceeded(db, {
        id: effect.id,
        ownerId: "worker-a",
        fencingToken: claimed?.fencingToken,
        runtimeLeaseName: "takeover-runtime",
        runtimeOwnerId: "a",
        runtimeFencingToken: runtimeA?.fencingToken ?? 0,
        externalReference: "stale",
        now: "2026-01-01T00:00:00.102Z"
      })).toBe(false);
    } finally {
      db.close();
    }
  });
});
