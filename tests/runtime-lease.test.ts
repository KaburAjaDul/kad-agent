import { describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease, releaseRuntimeLease, renewRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";

describe("runtime lease fencing", () => {
  it("allows one owner, fences takeover after expiry, and rejects stale renewal", () => {
    const db = createSqliteConnection(":memory:");
    try {
      runMigrations(db);
      const first = acquireRuntimeLease(db, { ownerId: "a", now: "2026-01-01T00:00:00.000Z", leaseDurationMs: 1_000 });
      expect(first?.fencingToken).toBe(1);
      expect(acquireRuntimeLease(db, { ownerId: "b", now: "2026-01-01T00:00:00.500Z", leaseDurationMs: 1_000 })).toBeNull();
      const takeover = acquireRuntimeLease(db, { ownerId: "b", now: "2026-01-01T00:00:01.000Z", leaseDurationMs: 1_000 });
      expect(takeover).toMatchObject({ ownerId: "b", fencingToken: 2 });
      expect(renewRuntimeLease(db, { ownerId: "a", fencingToken: first?.fencingToken ?? 0, now: "2026-01-01T00:00:01.100Z" })).toBeNull();
      expect(releaseRuntimeLease(db, { ownerId: "b", fencingToken: takeover?.fencingToken ?? 0, now: "2026-01-01T00:00:01.100Z" })).toBe(true);
    } finally {
      db.close();
    }
  });
});
