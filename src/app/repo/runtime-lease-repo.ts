import type { SqliteDatabase } from "./sqlite.js";

export type RuntimeLease = {
  leaseKey: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
  heartbeatAt: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeLeaseOptions = {
  leaseKey?: string;
  ownerId: string;
  now?: Date | string;
  leaseDurationMs?: number;
};

/** Identity of the live app lease required by durable job/effect mutations. */
export type RuntimeLeaseContext = {
  runtimeLeaseName: string;
  runtimeOwnerId: string;
  runtimeFencingToken: number;
};

type RuntimeLeaseRow = {
  lease_key: string;
  owner_id: string;
  fencing_token: number;
  expires_at: string;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
};

const DEFAULT_LEASE_KEY = "runtime";
const DEFAULT_LEASE_DURATION_MS = 30_000;

export function acquireRuntimeLease(db: SqliteDatabase, options: RuntimeLeaseOptions): RuntimeLease | null;
export function acquireRuntimeLease(
  db: SqliteDatabase,
  ownerId: string,
  now?: Date | string,
  leaseDurationMs?: number,
  leaseKey?: string
): RuntimeLease | null;
export function acquireRuntimeLease(
  db: SqliteDatabase,
  optionsOrOwnerId: RuntimeLeaseOptions | string,
  positionalNow?: Date | string,
  positionalDurationMs = DEFAULT_LEASE_DURATION_MS,
  positionalLeaseKey = DEFAULT_LEASE_KEY
): RuntimeLease | null {
  const options = typeof optionsOrOwnerId === "string"
    ? { ownerId: optionsOrOwnerId, now: positionalNow, leaseDurationMs: positionalDurationMs, leaseKey: positionalLeaseKey }
    : optionsOrOwnerId;
  const leaseKey = options.leaseKey ?? DEFAULT_LEASE_KEY;
  const ownerId = options.ownerId;
  const now = asIso(options.now);
  const expiresAt = new Date(Date.parse(now) + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO runtime_leases
      (lease_key, owner_id, fencing_token, expires_at, heartbeat_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`
  ).run(leaseKey, ownerId, expiresAt, now, now, now);

  const result = db.prepare(
    `UPDATE runtime_leases
     SET owner_id = ?,
         fencing_token = CASE WHEN owner_id = ? AND expires_at > ? THEN fencing_token ELSE fencing_token + 1 END,
         expires_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE lease_key = ?
       AND (owner_id = ? OR expires_at <= ?)`
  ).run(ownerId, ownerId, now, expiresAt, now, now, leaseKey, ownerId, now) as { changes?: number };

  return Number(result.changes ?? 0) === 1 ? getRuntimeLease(db, leaseKey) : null;
}

export function renewRuntimeLease(db: SqliteDatabase, options: RuntimeLeaseOptions & { fencingToken: number }): RuntimeLease | null;
export function renewRuntimeLease(
  db: SqliteDatabase,
  leaseKey: string,
  ownerId: string,
  fencingToken: number,
  now?: Date | string,
  leaseDurationMs?: number
): RuntimeLease | null;
export function renewRuntimeLease(
  db: SqliteDatabase,
  optionsOrLeaseKey: (RuntimeLeaseOptions & { fencingToken: number }) | string,
  positionalOwnerId?: string,
  positionalFencingToken?: number,
  positionalNow?: Date | string,
  positionalDurationMs = DEFAULT_LEASE_DURATION_MS
): RuntimeLease | null {
  const options = typeof optionsOrLeaseKey === "string"
    ? {
        leaseKey: optionsOrLeaseKey,
        ownerId: positionalOwnerId ?? "",
        fencingToken: positionalFencingToken,
        now: positionalNow,
        leaseDurationMs: positionalDurationMs
      }
    : optionsOrLeaseKey;
  if (options.fencingToken === undefined) return null;
  const leaseKey = options.leaseKey ?? DEFAULT_LEASE_KEY;
  const now = asIso(options.now);
  const expiresAt = new Date(Date.parse(now) + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)).toISOString();
  const result = db.prepare(
    `UPDATE runtime_leases
     SET expires_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE lease_key = ? AND owner_id = ?
       AND fencing_token = ?
       AND expires_at > ?`
  ).run(expiresAt, now, now, leaseKey, options.ownerId, options.fencingToken, now) as {
    changes?: number;
  };
  return Number(result.changes ?? 0) === 1 ? getRuntimeLease(db, leaseKey) : null;
}

export function releaseRuntimeLease(db: SqliteDatabase, options: { leaseKey?: string; ownerId: string; fencingToken: number; now?: Date | string }): boolean;
export function releaseRuntimeLease(db: SqliteDatabase, leaseKey: string, ownerId: string, fencingToken: number, now?: Date | string): boolean;
export function releaseRuntimeLease(
  db: SqliteDatabase,
  optionsOrLeaseKey: { leaseKey?: string; ownerId: string; fencingToken: number; now?: Date | string } | string,
  positionalOwnerId?: string,
  positionalFencingToken?: number,
  positionalNow?: Date | string
): boolean {
  if (typeof optionsOrLeaseKey === "string" && positionalFencingToken === undefined) return false;
  const options = typeof optionsOrLeaseKey === "string"
    ? { leaseKey: optionsOrLeaseKey, ownerId: positionalOwnerId ?? "", fencingToken: positionalFencingToken, now: positionalNow }
    : optionsOrLeaseKey;
  const now = asIso(options.now);
  const result = db.prepare(
    `UPDATE runtime_leases SET expires_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE lease_key = ? AND owner_id = ?
       AND fencing_token = ?`
  ).run(now, now, now, options.leaseKey ?? DEFAULT_LEASE_KEY, options.ownerId, options.fencingToken ?? 0) as {
    changes?: number;
  };
  return Number(result.changes ?? 0) === 1;
}

export function getRuntimeLease(db: SqliteDatabase, leaseKey = DEFAULT_LEASE_KEY): RuntimeLease | null {
  const row = db.prepare("SELECT * FROM runtime_leases WHERE lease_key = ?").get(leaseKey) as RuntimeLeaseRow | undefined;
  return row ? mapRuntimeLease(row) : null;
}

function asIso(value?: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function mapRuntimeLease(row: RuntimeLeaseRow): RuntimeLease {
  return {
    leaseKey: row.lease_key,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
