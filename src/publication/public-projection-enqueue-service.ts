import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import {
  createOrGetPublicProjectionOutbox,
  supersedeOlderPublicProjectionOutbox,
  type PublicProjectionOutbox
} from "./public-projection-outbox-repo.js";
import {
  allocatePublicProjectionRevision,
  LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE
} from "./public-projection-revision-repo.js";
import {
  assembleSqliteAgendaProjection,
  type SqliteAgendaProjectionOptions
} from "./sqlite-agenda-projection.js";
import {
  LANGUAGE_CLUB_AGENDA_PROJECTION,
  type ApprovedPublicationRecord
} from "./publication-approval-repo.js";
import { canonicalJson } from "./signing.js";
import type { AgendaProjection } from "./types.js";

export type EnqueueApprovedPublicProjectionOptions = RuntimeLeaseContext & {
  db: SqliteDatabase;
  publicIdKey: string;
  /** Restrict a snapshot to the source guild shown to the operator. */
  guildId?: string;
  /** Explicit snapshot observation time. Approval callers may omit this and use the source observation time. */
  observedAt?: string;
  now?: Date | string;
  revisionFloor?: number;
  /** Retire pending/retryable snapshots older than this newly enqueued one. */
  supersedeOlder?: boolean;
};

export type EnqueueCurrentPublicProjectionOptions = RuntimeLeaseContext & {
  db: SqliteDatabase;
  publicIdKey: string;
  guildId?: string;
  triggerAgendaEntryId: string;
  /** Explicit snapshot time; required so an empty snapshot remains deterministic. */
  observedAt: string;
  now?: Date | string;
  revisionFloor?: number;
  supersedeOlder?: boolean;
};

export type EnqueueApprovedPublicProjectionResult = {
  projection: AgendaProjection;
  payloadJson: string;
  outbox: PublicProjectionOutbox;
};

export type ApprovedPublicProjectionEnqueuer = {
  readonly lastResult: EnqueueApprovedPublicProjectionResult | undefined;
  enqueue(record: ApprovedPublicationRecord): undefined;
};

/**
 * Assemble and durably enqueue one complete approved SQLite snapshot.
 *
 * The function does not start a transaction: approval uses it as a synchronous
 * callback while BEGIN IMMEDIATE is open, making revision allocation, payload
 * assembly, and outbox insertion part of the same commit/rollback boundary.
 */
export function enqueueApprovedPublicProjection(
  options: EnqueueApprovedPublicProjectionOptions,
  record: ApprovedPublicationRecord
): EnqueueApprovedPublicProjectionResult {
  if (record.projectionType !== LANGUAGE_CLUB_AGENDA_PROJECTION) {
    throw new Error("Unsupported approved publication projection type.");
  }
  if (!options.publicIdKey.trim()) throw new Error("Public agenda ID key is required.");

  return enqueueCurrentPublicProjection({
    ...options,
    guildId: options.guildId ?? record.agenda.guildId,
    triggerAgendaEntryId: record.agendaEntryId,
    observedAt: options.observedAt ?? record.source.observedAt
  });
}

/**
 * Assemble and enqueue the current complete approved/withdrawn snapshot.
 * This is intentionally transaction-neutral: callers such as approval
 * decisions can invoke it synchronously inside their existing transaction.
 */
export function enqueueCurrentPublicProjection(
  options: EnqueueCurrentPublicProjectionOptions
): EnqueueApprovedPublicProjectionResult {
  if (!options.publicIdKey.trim()) throw new Error("Public agenda ID key is required.");
  if (!options.triggerAgendaEntryId.trim()) throw new Error("Projection trigger agenda entry ID is required.");
  const observedAt = canonicalIso(options.observedAt, "observedAt");
  const allocated = allocatePublicProjectionRevision(options.db, {
    runtimeLeaseName: options.runtimeLeaseName,
    runtimeOwnerId: options.runtimeOwnerId,
    runtimeFencingToken: options.runtimeFencingToken,
    projectionType: LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE,
    now: options.now,
    revisionFloor: options.revisionFloor
  });

  const snapshotNow = options.now === undefined ? undefined : asIso(options.now);
  const projectionOptions: SqliteAgendaProjectionOptions = {
    db: options.db,
    publicIdKey: options.publicIdKey,
    revision: allocated.revision,
    guildId: options.guildId,
    observedAt,
    now: snapshotNow === undefined ? undefined : () => new Date(snapshotNow)
  };
  const projection = assembleSqliteAgendaProjection(projectionOptions);
  const payloadJson = canonicalJson(projection);
  const outbox = createOrGetPublicProjectionOutbox(options.db, {
    triggerAgendaEntryId: options.triggerAgendaEntryId,
    projectionRevision: allocated.revision,
    projectionType: LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE,
    payloadJson,
    now: allocated.allocatedAt
  });

  if (options.supersedeOlder !== false) {
    supersedeOlderPublicProjectionOutbox(options.db, {
      runtimeLeaseName: options.runtimeLeaseName,
      runtimeOwnerId: options.runtimeOwnerId,
      runtimeFencingToken: options.runtimeFencingToken,
      projectionType: LANGUAGE_CLUB_PUBLIC_PROJECTION_TYPE,
      projectionRevision: allocated.revision,
      now: allocated.allocatedAt
    });
  }

  return { projection, payloadJson, outbox };
}

/**
 * Adapt the enqueue operation to the approval repository's synchronous
 * callback contract. The result remains available to the caller through
 * `lastResult`, while the callback itself returns exactly undefined.
 */
export function createApprovedPublicProjectionEnqueuer(
  options: EnqueueApprovedPublicProjectionOptions
): ApprovedPublicProjectionEnqueuer {
  let lastResult: EnqueueApprovedPublicProjectionResult | undefined;
  return {
    get lastResult() { return lastResult; },
    enqueue(record: ApprovedPublicationRecord): undefined {
      lastResult = enqueueApprovedPublicProjection(options, record);
      return undefined;
    }
  };
}

export const enqueuePublicProjection = enqueueApprovedPublicProjection;

function asIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function canonicalIso(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Invalid canonical ${label}.`);
  }
  return value;
}
