import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";

export const LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE = "language_club_agenda_entry.v1" as const;

export type PublicProjectionRevisionInput = RuntimeLeaseContext & {
  projectionType?: string;
  /** Snapshot clock. When omitted, the current UTC clock is used. */
  now?: Date | string;
  /** Optional floor used by deterministic callers or a recovered clock. */
  revisionFloor?: number;
};

export type PublicProjectionRevision = {
  projectionType: string;
  revision: number;
  allocatedAt: string;
};

export type SynchronizePublicProjectionRevisionInput = RuntimeLeaseContext & {
  projectionType?: string;
  revisionFloor: number;
  now?: Date | string;
};

/**
 * Raise the local allocator floor to an already-published remote revision.
 * This does not allocate or enqueue a snapshot; shadow mode uses it to ensure
 * the first homelab-owned snapshot is strictly newer than the legacy writer.
 */
export function synchronizePublicProjectionRevisionFloor(
  db: SqliteDatabase,
  input: SynchronizePublicProjectionRevisionInput
): PublicProjectionRevision {
  const projectionType = input.projectionType ?? LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE;
  const now = asIso(input.now);
  assertSafeRevisionFloor(input.revisionFloor);
  assertActiveRuntimeLease(db, input, now);
  const changed = db.prepare(
    `INSERT INTO public_projection_revisions (projection_type, current_revision, updated_at)
       SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM runtime_leases AS runtime
           WHERE runtime.lease_key = ? AND runtime.owner_id = ?
             AND runtime.fencing_token = ? AND runtime.expires_at > ?
        )
      ON CONFLICT (projection_type) DO UPDATE SET
        current_revision = MAX(public_projection_revisions.current_revision, excluded.current_revision),
        updated_at = excluded.updated_at
      WHERE EXISTS (
        SELECT 1 FROM runtime_leases AS runtime
         WHERE runtime.lease_key = ? AND runtime.owner_id = ?
           AND runtime.fencing_token = ? AND runtime.expires_at > ?
      )`
  ).run(
    projectionType, input.revisionFloor, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now,
    input.runtimeLeaseName, input.runtimeOwnerId, input.runtimeFencingToken, now
  ) as { changes?: number };
  if (Number(changed.changes ?? 0) !== 1) {
    throw new Error("Public projection revision synchronization lost its runtime fence.");
  }
  const result = getPublicProjectionRevision(db, projectionType);
  if (!result || result.revision < input.revisionFloor) {
    throw new Error("Public projection revision synchronization failed.");
  }
  return result;
}

/**
 * Allocate one fenced, monotonic public snapshot revision.
 *
 * The caller may already be inside BEGIN IMMEDIATE (approval does this). This
 * function deliberately does not open or close a transaction, so allocation
 * and the corresponding outbox insert can commit as one SQLite unit.
 */
export function allocatePublicProjectionRevision(
  db: SqliteDatabase,
  input: PublicProjectionRevisionInput
): PublicProjectionRevision {
  const projectionType = input.projectionType ?? LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE;
  const allocatedAt = asIso(input.now);
  assertActiveRuntimeLease(db, input, allocatedAt);

  const clockFloor = input.revisionFloor ?? Math.floor(Date.parse(allocatedAt));
  assertSafeRevisionFloor(clockFloor);

  db.prepare(
    `INSERT OR IGNORE INTO public_projection_revisions
      (projection_type, current_revision, updated_at)
     VALUES (?, 0, ?)`
  ).run(projectionType, allocatedAt);

  const current = db.prepare(
    "SELECT current_revision FROM public_projection_revisions WHERE projection_type = ?"
  ).get(projectionType) as { current_revision?: number } | undefined;
  if (current?.current_revision === undefined) {
    throw new Error("Public projection revision row is unavailable.");
  }

  const lastRevision = Number(current.current_revision);
  assertSafeRevisionFloor(lastRevision);
  const revision = Math.max(lastRevision + 1, clockFloor);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Public projection revision exhausted safe integer range.");
  }

  // The compare-and-set prevents a caller outside BEGIN IMMEDIATE from
  // clobbering a revision allocated by another connection. The lease fence is
  // repeated on the write so a lease can never authorize a stale commit.
  const updated = db.prepare(
    `UPDATE public_projection_revisions
        SET current_revision = ?, updated_at = ?
      WHERE projection_type = ?
        AND current_revision = ?
        AND EXISTS (
          SELECT 1 FROM runtime_leases AS runtime
           WHERE runtime.lease_key = ? AND runtime.owner_id = ?
             AND runtime.fencing_token = ? AND runtime.expires_at > ?
        )`
  ).run(
    revision,
    allocatedAt,
    projectionType,
    lastRevision,
    input.runtimeLeaseName,
    input.runtimeOwnerId,
    input.runtimeFencingToken,
    allocatedAt
  ) as { changes?: number };
  if (Number(updated.changes ?? 0) !== 1) {
    throw new Error("Public projection revision allocation lost its runtime fence or raced another allocator.");
  }

  return { projectionType, revision, allocatedAt };
}

export const allocatePublicProjectionSnapshotRevision = allocatePublicProjectionRevision;

export function getPublicProjectionRevision(
  db: SqliteDatabase,
  projectionType: string = LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE
): PublicProjectionRevision | null {
  const row = db.prepare(
    "SELECT current_revision, updated_at FROM public_projection_revisions WHERE projection_type = ?"
  ).get(projectionType) as { current_revision?: number; updated_at?: string } | undefined;
  if (!row) return null;
  return {
    projectionType,
    revision: Number(row.current_revision),
    allocatedAt: String(row.updated_at)
  };
}

function assertActiveRuntimeLease(
  db: SqliteDatabase,
  context: RuntimeLeaseContext,
  now: string
): void {
  if (!context.runtimeLeaseName.trim() || !context.runtimeOwnerId.trim()
      || !Number.isSafeInteger(context.runtimeFencingToken) || context.runtimeFencingToken < 1) {
    throw new Error("Public projection revision requires a valid runtime lease context.");
  }
  const active = db.prepare(
    `SELECT 1 AS active FROM runtime_leases
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`
  ).get(context.runtimeLeaseName, context.runtimeOwnerId, context.runtimeFencingToken, now) as { active?: number } | undefined;
  if (Number(active?.active ?? 0) !== 1) {
    throw new Error("Public projection revision requires an active runtime lease.");
  }
}

function assertSafeRevisionFloor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Public projection revision floor must be a non-negative safe integer.");
  }
}

function asIso(value?: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}
