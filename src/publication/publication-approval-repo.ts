import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";

export const LANGUAGE_CLUB_AGENDA_PROJECTION = "language_club_agenda_entry.v1" as const;

export type PublicationProjectionType = typeof LANGUAGE_CLUB_AGENDA_PROJECTION;
export type PublicationApprovalState = "pending" | "approved" | "rejected" | "withdrawn";
export type PrivateAgendaState = "pending" | "approved" | "withdrawn";
export type SourceObservationState = "present" | "disappeared" | "tombstoned";
export type SourceClassificationState = "allowlisted" | "unknown" | "invalid" | "withdrawn";
export type PublicationDecision = "approve" | "reject";

export type PublicationApprovalExpectation = {
  /** The observation revision that was shown to the operator. */
  sourceObservationId: string;
  /** Source revision. Discord observations currently use source_version as this revision. */
  sourceVersion: number;
  observationState: SourceObservationState;
  agendaState: PrivateAgendaState;
};

export type PublicationApprovalRow = {
  id: string;
  agendaEntryId: string;
  projectionType: PublicationProjectionType;
  state: PublicationApprovalState;
  requestedAt: string;
  requestedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
};

export type PublicationApprovalSnapshot = {
  approval: PublicationApprovalRow;
  agenda: {
    id: string;
    sourceProviderEventId: string;
    sourceObservationId: string;
    guildId: string;
    projectionType: PublicationProjectionType;
    title: string;
    summary: string;
    programKey: string;
    seriesKey: string | null;
    scheduledStartAt: string;
    scheduledEndAt: string | null;
    timezone: "Asia/Jakarta";
    agendaState: PrivateAgendaState;
    updatedAt: string;
  };
  source: {
    providerEventId: string;
    guildId: string;
    observationId: string;
    source: string;
    sourceVersion: number;
    observationState: SourceObservationState;
    classificationState: SourceClassificationState;
    observedAt: string;
    updatedAt: string;
  } | null;
};

export type ApprovedPublicationRecord = {
  approvalId: string;
  agendaEntryId: string;
  projectionType: PublicationProjectionType;
  decision: "approve";
  decidedAt: string;
  decidedBy: string;
  decisionReason: string;
  agenda: PublicationApprovalSnapshot["agenda"];
  source: NonNullable<PublicationApprovalSnapshot["source"]>;
};

export type PublicationApprovalRepositoryErrorCode =
  | "approval_not_found"
  | "agenda_not_found"
  | "source_not_found"
  | "stale_source"
  | "withdrawn_source"
  | "unknown_source"
  | "invalid_expectation"
  | "operator_conflict"
  | "lease_inactive"
  | "enqueue_required"
  | "enqueue_async";

export class PublicationApprovalRepositoryError extends Error {
  readonly code: PublicationApprovalRepositoryErrorCode;

  constructor(code: PublicationApprovalRepositoryErrorCode, message: string) {
    super(message);
    this.name = "PublicationApprovalRepositoryError";
    this.code = code;
  }
}

type PublicationApprovalRowDb = {
  approval_id: string;
  agenda_entry_id: string;
  approval_projection_type: string;
  approval_state: PublicationApprovalState;
  requested_at: string;
  requested_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  source_provider_event_id: string;
  source_observation_id: string;
  agenda_guild_id: string;
  agenda_projection_type: string;
  title: string;
  summary: string;
  program_key: string;
  series_key: string | null;
  scheduled_start_at: string;
  scheduled_end_at: string | null;
  timezone: string;
  agenda_state: PrivateAgendaState;
  agenda_updated_at: string;
  source_guild_id: string | null;
  current_observation_id: string | null;
  source: string | null;
  source_version: number | null;
  observation_state: SourceObservationState | null;
  classification_state: SourceClassificationState | null;
  observed_at: string | null;
  source_updated_at: string | null;
};

/** Read the private approval, agenda, and current source revision in one snapshot. */
export function getPublicationApproval(
  db: SqliteDatabase,
  agendaEntryId: string,
  projectionType: PublicationProjectionType = LANGUAGE_CLUB_AGENDA_PROJECTION
): PublicationApprovalSnapshot | null {
  const row = db.prepare(
    `SELECT
       pa.id AS approval_id,
       pa.agenda_entry_id,
       pa.projection_type AS approval_projection_type,
       pa.state AS approval_state,
       pa.requested_at,
       pa.requested_by,
       pa.decided_at,
       pa.decided_by,
       pa.decision_reason,
       pae.source_provider_event_id,
       pae.source_observation_id,
       pae.guild_id AS agenda_guild_id,
       pae.projection_type AS agenda_projection_type,
       pae.title,
       pae.summary,
       pae.program_key,
       pae.series_key,
       pae.scheduled_start_at,
       pae.scheduled_end_at,
       pae.timezone,
       pae.agenda_state,
       pae.updated_at AS agenda_updated_at,
       osc.guild_id AS source_guild_id,
       osc.observation_id AS current_observation_id,
       osc.source,
       osc.source_version,
       osc.observation_state,
       osc.classification_state,
       osc.last_observed_at AS observed_at,
       osc.updated_at AS source_updated_at
     FROM publication_approvals pa
     JOIN private_agenda_entries pae ON pae.id = pa.agenda_entry_id
     LEFT JOIN discord_scheduled_event_observations_current osc
       ON osc.provider_event_id = pae.source_provider_event_id
      AND osc.guild_id = pae.guild_id
     WHERE pa.agenda_entry_id = ?
       AND pa.projection_type = ?
     LIMIT 1`
  ).get(agendaEntryId, projectionType) as PublicationApprovalRowDb | undefined;

  if (!row) return null;
  return mapPublicationApprovalSnapshot(row, projectionType);
}

export type PublicationApprovalMutation = {
  agendaEntryId: string;
  projectionType?: PublicationProjectionType;
  decision: PublicationDecision;
  operatorId: string;
  /** Optional source/request actor. It may never be the approving operator. */
  sourceActorId?: string | null;
  expected: PublicationApprovalExpectation;
  reason: string;
  now?: Date | string;
  /** Wall-clock source used for lease validity; injectable for deterministic tests. */
  leaseNow?: () => Date;
  context: RuntimeLeaseContext;
  enqueueApprovedProjection?: PublicationApprovalEnqueuer;
};

export type PublicationApprovalEnqueuer =
  // `undefined` (rather than `void`) prevents TypeScript's special void
  // callback assignability rule from accepting an async Promise-returning
  // function. Runtime validation below remains the final guard at JS edges.
  | ((record: ApprovedPublicationRecord) => undefined)
  | { enqueue(record: ApprovedPublicationRecord): undefined };

export type PublicationApprovalMutationResult = {
  decision: PublicationDecision;
  idempotent: boolean;
  approval: PublicationApprovalSnapshot;
  enqueued: boolean;
};

/**
 * Atomically apply a publication decision. The injected enqueue callback runs
 * while this SQLite transaction is open, so a callback failure rolls the
 * decision back instead of leaving an approved row with no outbox intent.
 */
export function applyPublicationApproval(
  db: SqliteDatabase,
  input: PublicationApprovalMutation
): PublicationApprovalMutationResult {
  const projectionType = input.projectionType ?? LANGUAGE_CLUB_AGENDA_PROJECTION;
  const now = isoNow(input.now);
  const leaseClock = input.leaseNow ?? (() => new Date());
  validateMutationInput(input, projectionType);
  assertActiveLease(db, input.context, isoNow(leaseClock()));

  db.exec("BEGIN IMMEDIATE");
  try {
    const snapshot = getPublicationApproval(db, input.agendaEntryId, projectionType);
    if (!snapshot) {
      throw new PublicationApprovalRepositoryError(
        "approval_not_found",
        `Publication approval was not found for agenda entry ${input.agendaEntryId}.`
      );
    }

    assertExpectation(snapshot, input.expected, input.decision);

    const sameApproved = input.decision === "approve"
      && snapshot.approval.state === "approved"
      && snapshot.agenda.agendaState === "approved";
    const sameRejected = input.decision === "reject"
      && snapshot.approval.state === "rejected"
      && snapshot.agenda.agendaState === "pending";
    if (sameApproved || sameRejected) {
      db.exec("COMMIT");
      return { decision: input.decision, idempotent: true, approval: snapshot, enqueued: false };
    }

    if (input.decision === "approve" && !input.enqueueApprovedProjection) {
      throw new PublicationApprovalRepositoryError(
        "enqueue_required",
        "An approval enqueue callback is required for publication approval."
      );
    }

    if (snapshot.approval.state === "withdrawn" || snapshot.agenda.agendaState === "withdrawn") {
      throw new PublicationApprovalRepositoryError(
        "withdrawn_source",
        "Publication approval cannot be decided after its agenda entry was withdrawn."
      );
    }
    if (snapshot.approval.state !== "pending") {
      throw new PublicationApprovalRepositoryError(
        "stale_source",
        `Publication approval is already ${snapshot.approval.state}; review the current revision before deciding again.`
      );
    }

    const decidedBy = input.operatorId;
    const decisionReason = normalizeReason(input.reason);
    if (input.decision === "approve") {
      // Re-check the fenced runtime immediately before changing either row.
      // The pre-transaction check protects the fast-fail path; this check
      // closes the race between that read and the decision writes.
      assertActiveLease(db, input.context, isoNow(leaseClock()));
      const updatedApproval = db.prepare(
        `UPDATE publication_approvals
            SET state = 'approved', decided_at = ?, decided_by = ?, decision_reason = ?
          WHERE id = ? AND state = 'pending'`
      ).run(now, decidedBy, decisionReason, snapshot.approval.id) as { changes?: number };
      const updatedAgenda = db.prepare(
        `UPDATE private_agenda_entries
            SET agenda_state = 'approved', updated_at = ?
          WHERE id = ? AND agenda_state = 'pending'`
      ).run(now, snapshot.agenda.id) as { changes?: number };
      if (Number(updatedApproval.changes ?? 0) !== 1 || Number(updatedAgenda.changes ?? 0) !== 1) {
        throw new PublicationApprovalRepositoryError("stale_source", "Publication approval changed while being decided.");
      }

      const source = snapshot.source;
      if (!source) {
        throw new PublicationApprovalRepositoryError("source_not_found", "The source observation disappeared before approval.");
      }
      const record: ApprovedPublicationRecord = {
        approvalId: snapshot.approval.id,
        agendaEntryId: snapshot.agenda.id,
        projectionType,
        decision: "approve",
        decidedAt: now,
        decidedBy,
        decisionReason,
        agenda: { ...snapshot.agenda, agendaState: "approved", updatedAt: now },
        source
      };
      invokeEnqueuer(input.enqueueApprovedProjection, record);
      // The enqueue callback is synchronous and participates in this
      // transaction. Re-check the same lease identity after it returns so a
      // callback that observes/causes lease loss cannot commit an approval.
      assertActiveLease(db, input.context, isoNow(leaseClock()));
      const resultSnapshot = getPublicationApproval(db, input.agendaEntryId, projectionType);
      if (!resultSnapshot) throw new PublicationApprovalRepositoryError("approval_not_found", "Approved publication disappeared during mutation.");
      db.exec("COMMIT");
      return { decision: input.decision, idempotent: false, approval: resultSnapshot, enqueued: true };
    }

    // Re-check immediately before a rejection write as well. There is no
    // enqueue callback on this path, but the decision is still lease-fenced.
    assertActiveLease(db, input.context, isoNow(leaseClock()));
    const updated = db.prepare(
      `UPDATE publication_approvals
          SET state = 'rejected', decided_at = ?, decided_by = ?, decision_reason = ?
        WHERE id = ? AND state = 'pending'`
    ).run(now, decidedBy, decisionReason, snapshot.approval.id) as { changes?: number };
    if (Number(updated.changes ?? 0) !== 1) {
      throw new PublicationApprovalRepositoryError("stale_source", "Publication approval changed while being decided.");
    }
    const resultSnapshot = getPublicationApproval(db, input.agendaEntryId, projectionType);
    if (!resultSnapshot) throw new PublicationApprovalRepositoryError("approval_not_found", "Rejected publication disappeared during mutation.");
    db.exec("COMMIT");
    return { decision: input.decision, idempotent: false, approval: resultSnapshot, enqueued: false };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the decision error */ }
    throw error;
  }
}

function assertExpectation(snapshot: PublicationApprovalSnapshot, expected: PublicationApprovalExpectation, decision: PublicationDecision): void {
  if (snapshot.agenda.agendaState === "withdrawn" || snapshot.approval.state === "withdrawn") {
    throw new PublicationApprovalRepositoryError("withdrawn_source", "The agenda entry or approval is withdrawn.");
  }
  const source = snapshot.source;
  if (!source) {
    throw new PublicationApprovalRepositoryError("source_not_found", "The current source observation is unavailable.");
  }
  if (source.observationState !== "present") {
    throw new PublicationApprovalRepositoryError("withdrawn_source", "The source observation is no longer present.");
  }
  if (source.classificationState === "withdrawn") {
    throw new PublicationApprovalRepositoryError("withdrawn_source", "The source observation is withdrawn.");
  }
  if (source.guildId !== snapshot.agenda.guildId || source.providerEventId !== snapshot.agenda.sourceProviderEventId) {
    throw new PublicationApprovalRepositoryError("stale_source", "The current source identity does not match the private agenda entry.");
  }
  if (source.classificationState !== "allowlisted") {
    throw new PublicationApprovalRepositoryError("unknown_source", "Only an allowlisted current source observation may be published.");
  }
  if (snapshot.agenda.sourceObservationId !== expected.sourceObservationId
      || source.observationId !== expected.sourceObservationId
      || source.sourceVersion !== expected.sourceVersion) {
    throw new PublicationApprovalRepositoryError("stale_source", "The source observation revision is stale; reload the current agenda entry.");
  }
  const idempotentApproved = decision === "approve"
    && snapshot.approval.state === "approved"
    && snapshot.agenda.agendaState === "approved";
  if (expected.observationState !== source.observationState || (expected.agendaState !== snapshot.agenda.agendaState && !idempotentApproved)) {
    throw new PublicationApprovalRepositoryError("stale_source", "The private agenda state changed; reload before deciding.");
  }
}

function validateMutationInput(input: PublicationApprovalMutation, projectionType: PublicationProjectionType): void {
  if (!input.agendaEntryId.trim()) throw new PublicationApprovalRepositoryError("invalid_expectation", "agendaEntryId is required.");
  if (!input.operatorId.trim()) throw new PublicationApprovalRepositoryError("invalid_expectation", "operatorId is required.");
  if (input.sourceActorId != null && !input.sourceActorId.trim()) {
    throw new PublicationApprovalRepositoryError("invalid_expectation", "sourceActorId must not be empty.");
  }
  if (input.sourceActorId != null && input.sourceActorId === input.operatorId) {
    throw new PublicationApprovalRepositoryError("operator_conflict", "The publication operator must be distinct from the source actor.");
  }
  if (projectionType !== LANGUAGE_CLUB_AGENDA_PROJECTION) {
    throw new PublicationApprovalRepositoryError("invalid_expectation", "Unsupported publication projection type.");
  }
  if (!input.expected.sourceObservationId.trim() || !Number.isInteger(input.expected.sourceVersion) || input.expected.sourceVersion < 1) {
    throw new PublicationApprovalRepositoryError("invalid_expectation", "A positive source observation revision is required.");
  }
  if (input.expected.observationState !== "present" || input.expected.agendaState !== "pending") {
    throw new PublicationApprovalRepositoryError("invalid_expectation", "Publication decisions require a present source and pending private agenda.");
  }
}

function invokeEnqueuer(enqueuer: PublicationApprovalEnqueuer | undefined, record: ApprovedPublicationRecord): void {
  if (!enqueuer) throw new PublicationApprovalRepositoryError("enqueue_required", "An approval enqueue callback is required for publication approval.");
  const result = typeof enqueuer === "function" ? enqueuer(record) : enqueuer.enqueue(record);
  if (result != null && typeof (result as { then?: unknown }).then === "function") {
    throw new PublicationApprovalRepositoryError("enqueue_async", "Publication approval enqueue must be synchronous; Promise/thenable results are rejected.");
  }
}

function assertActiveLease(db: SqliteDatabase, context: RuntimeLeaseContext, now: string): void {
  if (!context.runtimeLeaseName.trim() || !context.runtimeOwnerId.trim() || !Number.isInteger(context.runtimeFencingToken) || context.runtimeFencingToken < 1) {
    throw new PublicationApprovalRepositoryError("lease_inactive", "A complete runtime lease context is required for publication decisions.");
  }
  const row = db.prepare(
    `SELECT 1 AS active FROM runtime_leases
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`
  ).get(context.runtimeLeaseName, context.runtimeOwnerId, context.runtimeFencingToken, now) as { active?: number } | undefined;
  if (row?.active !== 1) throw new PublicationApprovalRepositoryError("lease_inactive", "Runtime lease is not active for publication decision.");
}

function mapPublicationApprovalSnapshot(row: PublicationApprovalRowDb, projectionType: PublicationProjectionType): PublicationApprovalSnapshot {
  if (row.approval_projection_type !== projectionType || row.agenda_projection_type !== projectionType || row.timezone !== "Asia/Jakarta") {
    throw new PublicationApprovalRepositoryError("invalid_expectation", "Stored publication approval has an unsupported projection contract.");
  }
  return {
    approval: {
      id: row.approval_id,
      agendaEntryId: row.agenda_entry_id,
      projectionType,
      state: row.approval_state,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      decisionReason: row.decision_reason
    },
    agenda: {
      id: row.agenda_entry_id,
      sourceProviderEventId: row.source_provider_event_id,
      sourceObservationId: row.source_observation_id,
      guildId: row.agenda_guild_id,
      projectionType,
      title: row.title,
      summary: row.summary,
      programKey: row.program_key,
      seriesKey: row.series_key,
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      timezone: "Asia/Jakarta",
      agendaState: row.agenda_state,
      updatedAt: row.agenda_updated_at
    },
    source: row.current_observation_id == null || row.source == null || row.source_version == null || row.observation_state == null || row.classification_state == null || row.observed_at == null || row.source_updated_at == null
      ? null
      : {
          providerEventId: row.source_provider_event_id,
          guildId: row.source_guild_id ?? row.agenda_guild_id,
          observationId: row.current_observation_id,
          source: row.source,
          sourceVersion: Number(row.source_version),
          observationState: row.observation_state,
          classificationState: row.classification_state,
          observedAt: row.observed_at,
          updatedAt: row.source_updated_at
        }
  };
}

function normalizeReason(reason: string | undefined): string {
  const normalized = (reason ?? "").trim();
  if (!normalized) throw new PublicationApprovalRepositoryError("invalid_expectation", "A decision reason is required for auditability.");
  if (normalized.length > 1000) throw new PublicationApprovalRepositoryError("invalid_expectation", "Decision reason must be at most 1000 characters.");
  return normalized;
}

function isoNow(value?: Date | string): string {
  const parsed = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new PublicationApprovalRepositoryError("invalid_expectation", "now must be a valid timestamp.");
  return parsed.toISOString();
}
