import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import {
  applyPublicationApproval,
  getPublicationApproval,
  LANGUAGE_CLUB_AGENDA_PROJECTION,
  type ApprovedPublicationRecord,
  type PublicationApprovalEnqueuer,
  type PublicationApprovalExpectation,
  type PublicationApprovalMutationResult,
  type PublicationApprovalSnapshot,
  type PublicationDecision,
  type PublicationProjectionType
} from "./publication-approval-repo.js";

export type DecidePublicationApprovalInput = {
  agendaEntryId: string;
  decision: PublicationDecision;
  operatorId: string;
  sourceActorId?: string | null;
  expected: PublicationApprovalExpectation;
  reason: string;
  context: RuntimeLeaseContext;
  projectionType?: PublicationProjectionType;
  now?: Date | string;
  leaseNow?: () => Date;
  enqueueApprovedProjection?: PublicationApprovalEnqueuer;
};

export type PublicationApprovalServiceResult = PublicationApprovalMutationResult;

/**
 * Policy-facing entry point for the private publication boundary.
 * Authentication/role resolution belongs at the Discord adapter; this service
 * still requires a non-empty explicit operator ID and never treats a source
 * actor as the approver.
 */
export function decidePublicationApproval(
  db: SqliteDatabase,
  input: DecidePublicationApprovalInput
): PublicationApprovalServiceResult {
  return applyPublicationApproval(db, {
    agendaEntryId: input.agendaEntryId,
    projectionType: input.projectionType ?? LANGUAGE_CLUB_AGENDA_PROJECTION,
    decision: input.decision,
    operatorId: input.operatorId,
    sourceActorId: input.sourceActorId,
    expected: input.expected,
    reason: input.reason,
    now: input.now,
    leaseNow: input.leaseNow,
    context: input.context,
    enqueueApprovedProjection: input.enqueueApprovedProjection
  });
}

export function approvePublicationApproval(
  db: SqliteDatabase,
  input: Omit<DecidePublicationApprovalInput, "decision">
): PublicationApprovalServiceResult {
  return decidePublicationApproval(db, { ...input, decision: "approve" });
}

export function rejectPublicationApproval(
  db: SqliteDatabase,
  input: Omit<DecidePublicationApprovalInput, "decision" | "enqueueApprovedProjection">
): PublicationApprovalServiceResult {
  return decidePublicationApproval(db, { ...input, decision: "reject" });
}

export function readPublicationApproval(
  db: SqliteDatabase,
  agendaEntryId: string,
  projectionType: PublicationProjectionType = LANGUAGE_CLUB_AGENDA_PROJECTION
): PublicationApprovalSnapshot | null {
  return getPublicationApproval(db, agendaEntryId, projectionType);
}

export type { ApprovedPublicationRecord, PublicationApprovalEnqueuer, PublicationApprovalExpectation, PublicationApprovalSnapshot };
