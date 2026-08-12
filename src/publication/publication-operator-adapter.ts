import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import type { RuntimeLeaseContext } from "../app/repo/runtime-lease-repo.js";
import type { SqliteDatabase } from "../app/repo/sqlite.js";
import {
  PublicationApprovalRepositoryError,
  type PublicationApprovalEnqueuer,
  type PublicationApprovalExpectation,
  type PublicationApprovalSnapshot,
  type PublicationDecision
} from "./publication-approval-repo.js";
import { decidePublicationApproval, readPublicationApproval } from "./publication-approval-service.js";

export type PublicationOperatorMode = "disabled" | "observe" | "active";

/**
 * Runtime-owned dependencies for the Discord operator boundary. The default
 * is intentionally fail-closed: bootstrap must explicitly enable the mode and
 * provide the fenced lease context (and enqueue boundary for approvals).
 */
export type PublicationOperatorDependencies = {
  mode?: PublicationOperatorMode;
  allowedGuildIds?: readonly string[];
  getRuntimeLeaseContext?: () => RuntimeLeaseContext | null;
  approvalService?: typeof decidePublicationApproval;
  enqueueApprovedProjection?: PublicationApprovalEnqueuer;
};

type PendingPublicationRow = {
  agenda_entry_id: string;
  title: string;
  scheduled_start_at: string;
};

const MAX_PENDING_ITEMS = 20;
const MAX_TITLE_LENGTH = 72;
const MAX_RESPONSE_LENGTH = 1_800;

/** Handle the admin-only /publication command without exposing source IDs. */
export async function handlePublicationOperatorCommand(
  interaction: ChatInputCommandInteraction,
  db: SqliteDatabase,
  dependencies: PublicationOperatorDependencies = {}
): Promise<void> {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Perintah publication hanya tersedia di dalam server Discord.");
    return;
  }

  if (!dependencies.allowedGuildIds?.includes(interaction.guildId)) {
    await replyEphemeral(interaction, "Perintah ini tidak tersedia di server yang belum diizinkan.");
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyEphemeral(interaction, "Perintah publication hanya bisa dipakai oleh administrator server.");
    return;
  }

  if (!dependencies.mode || dependencies.mode === "disabled") {
    await replyEphemeral(interaction, "Review publication sedang dinonaktifkan oleh runtime.");
    return;
  }

  const context = dependencies.getRuntimeLeaseContext?.() ?? null;
  if (!context || !isActiveRuntimeLease(db, context)) {
    await replyEphemeral(interaction, "Kaddy belum memegang runtime lease aktif; keputusan tidak dijalankan.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "pending") {
    await replyEphemeral(interaction, formatPendingList(listPendingPublicationRows(db)));
    return;
  }

  if (subcommand !== "decide") {
    await replyEphemeral(interaction, "Subcommand publication tidak dikenali.");
    return;
  }

  const item = interaction.options.getInteger("item", true);
  const decision = interaction.options.getString("decision", true);
  const reason = interaction.options.getString("reason", true)?.trim() ?? "";
  if (!Number.isInteger(item) || item < 1 || item > MAX_PENDING_ITEMS) {
    await replyEphemeral(interaction, "Item harus berupa nomor 1 sampai 20 dari daftar pending terbaru.");
    return;
  }
  if (decision !== "approve" && decision !== "reject") {
    await replyEphemeral(interaction, "Decision harus approve atau reject.");
    return;
  }
  if (!reason) {
    await replyEphemeral(interaction, "Reason wajib diisi untuk audit keputusan.");
    return;
  }

  const pending = listPendingPublicationRows(db);
  const selected = pending[item - 1];
  if (!selected) {
    await replyEphemeral(interaction, "Daftar pending sudah berubah; jalankan /publication pending lalu pilih nomor terbaru.");
    return;
  }

  // Never accept an agenda/source ID from the user. Resolve the current row
  // ourselves immediately before constructing the expectation for the service.
  const snapshot = readCurrentSnapshot(db, selected.agenda_entry_id);
  if (!snapshot || !isActionableSnapshot(snapshot)) {
    await replyEphemeral(interaction, "Item sudah berubah atau tidak lagi aman untuk direview; refresh daftar pending.");
    return;
  }

  const expectation: PublicationApprovalExpectation = {
    sourceObservationId: snapshot.source.observationId,
    sourceVersion: snapshot.source.sourceVersion,
    observationState: snapshot.source.observationState,
    agendaState: snapshot.agenda.agendaState
  };

  try {
    const result = (dependencies.approvalService ?? decidePublicationApproval)(db, {
      agendaEntryId: snapshot.agenda.id,
      projectionType: snapshot.approval.projectionType,
      decision: decision as PublicationDecision,
      operatorId: interaction.user.id,
      // requested_by is the source/request actor and remains distinct from
      // the approving Discord operator when present.
      sourceActorId: snapshot.approval.requestedBy,
      expected: expectation,
      reason,
      context,
      enqueueApprovedProjection: dependencies.enqueueApprovedProjection
    });
    await replyEphemeral(
      interaction,
      result.idempotent
        ? `Keputusan ${decision} untuk item ${item} sudah tercatat sebelumnya.`
        : `Keputusan ${decision} untuk item ${item} berhasil dicatat${result.enqueued ? " dan masuk antrean publikasi" : ""}.`
    );
  } catch (error) {
    await replyEphemeral(interaction, publicationDecisionErrorMessage(error));
  }
}

export function listPendingPublicationRows(db: SqliteDatabase, limit = MAX_PENDING_ITEMS): PendingPublicationRow[] {
  const boundedLimit = Math.max(1, Math.min(MAX_PENDING_ITEMS, Math.trunc(limit)));
  return db.prepare(
    `SELECT pae.id AS agenda_entry_id, pae.title, pae.scheduled_start_at
       FROM private_agenda_entries AS pae
       JOIN publication_approvals AS pa ON pa.agenda_entry_id = pae.id
        AND pa.projection_type = pae.projection_type
       JOIN discord_scheduled_event_observations_current AS osc
         ON osc.provider_event_id = pae.source_provider_event_id
        AND osc.guild_id = pae.guild_id
      WHERE pa.state = 'pending'
        AND pae.agenda_state = 'pending'
        AND osc.observation_state = 'present'
        AND osc.classification_state = 'allowlisted'
      ORDER BY pae.scheduled_start_at ASC, pae.id ASC
      LIMIT ?`
  ).all(boundedLimit) as PendingPublicationRow[];
}

function readCurrentSnapshot(db: SqliteDatabase, agendaEntryId: string): PublicationApprovalSnapshot | null {
  const row = db.prepare(
    `SELECT 1 FROM private_agenda_entries AS pae
       JOIN publication_approvals AS pa ON pa.agenda_entry_id = pae.id
        AND pa.projection_type = pae.projection_type
      WHERE pae.id = ? AND pa.state = 'pending' AND pae.agenda_state = 'pending'`
  ).get(agendaEntryId);
  if (!row) return null;
  return readPublicationApproval(db, agendaEntryId);
}

function isActionableSnapshot(snapshot: PublicationApprovalSnapshot): snapshot is PublicationApprovalSnapshot & {
  source: NonNullable<PublicationApprovalSnapshot["source"]>;
} {
  return snapshot.approval.state === "pending"
    && snapshot.agenda.agendaState === "pending"
    && snapshot.source !== null
    && snapshot.source.observationId === snapshot.agenda.sourceObservationId
    && snapshot.source.observationState === "present"
    && snapshot.source.classificationState === "allowlisted";
}

function isActiveRuntimeLease(db: SqliteDatabase, context: RuntimeLeaseContext): boolean {
  if (!context.runtimeLeaseName.trim() || !context.runtimeOwnerId.trim() || !Number.isInteger(context.runtimeFencingToken) || context.runtimeFencingToken < 1) {
    return false;
  }
  const row = db.prepare(
    `SELECT 1 AS active FROM runtime_leases
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`
  ).get(context.runtimeLeaseName, context.runtimeOwnerId, context.runtimeFencingToken, new Date().toISOString()) as { active?: number } | undefined;
  return row?.active === 1;
}

function formatPendingList(rows: PendingPublicationRow[]): string {
  if (rows.length === 0) return "Tidak ada publication review yang pending.";
  const lines = ["Publication review pending (private, hanya terlihat oleh kamu):"];
  for (const [index, row] of rows.entries()) {
    const title = sanitizePrivateTitle(row.title);
    const start = sanitizeTimestamp(row.scheduled_start_at);
    lines.push(`${index + 1}. ${title}${start ? ` — ${start}` : ""}`);
  }
  return boundResponse(lines.join("\n"));
}

function sanitizePrivateTitle(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/<@!?\d{5,20}>|@everyone|@here/gi, "[mention]").trim();
  if (!normalized) return "(tanpa judul)";
  return normalized.length > MAX_TITLE_LENGTH ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…` : normalized;
}

function sanitizeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function boundResponse(value: string): string {
  return value.length <= MAX_RESPONSE_LENGTH ? value : `${value.slice(0, MAX_RESPONSE_LENGTH - 1)}…`;
}

function publicationDecisionErrorMessage(error: unknown): string {
  if (!(error instanceof PublicationApprovalRepositoryError)) {
    return "Keputusan tidak dijalankan karena antrean publikasi belum siap.";
  }
  switch (error.code) {
    case "lease_inactive":
      return "Runtime lease tidak lagi aktif; keputusan dibatalkan.";
    case "stale_source":
    case "invalid_expectation":
    case "unknown_source":
    case "withdrawn_source":
      return "Snapshot sumber sudah berubah atau tidak aman; refresh daftar pending.";
    case "enqueue_required":
      return "Approval belum diaktifkan karena antrean publikasi belum dikonfigurasi.";
    default:
      return "Keputusan publication gagal dan tidak mengubah data private.";
  }
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const payload = { content: boundResponse(content), ephemeral: true, allowedMentions: { parse: [] as [] } };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}
