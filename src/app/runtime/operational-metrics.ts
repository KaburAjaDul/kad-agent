import type { SqliteDatabase } from "../repo/sqlite.js";
import { statSync } from "node:fs";

export type GatewayState = "ready" | "not_ready";
export type LeaseState = "held" | "lost" | "conflict";
export type InteractionOutcome = "success" | "rejected" | "failed" | "mutation_refused";
export type JobSweepOutcome = "completed" | "completed_with_failures" | "noop" | "failed";
export type PublicationMode = "disabled" | "observe" | "active";
export type PublicationObservationStatus = "disabled" | "idle" | "running" | "succeeded" | "failed" | "blocked";
export type PublicationReconciliationOutcome = "success" | "failed" | "skipped" | "stale" | "mismatch" | "unknown" | "operator_resolved";
export type PublicationOutcome = "success" | "failed" | "refused" | "skipped" | "reconciled";

const REMINDER_STATES = [
  "pending",
  "sending",
  "sent",
  "send_failed",
  "retryable",
  "needs_reconciliation",
  "dead_letter",
  "cancelled"
] as const;
const EFFECT_STATES = [
  "pending",
  "leased",
  "succeeded",
  "retryable",
  "needs_reconciliation",
  "cancelled",
  "dead_letter"
] as const;
const PUBLICATION_OUTBOX_STATES = [
  "pending",
  "leased",
  "retryable",
  "needs_reconciliation",
  "succeeded",
  "dead_letter"
] as const;
const PUBLICATION_RECONCILIATION_OUTCOMES: readonly PublicationReconciliationOutcome[] = [
  "success",
  "failed",
  "skipped",
  "stale",
  "mismatch",
  "unknown",
  "operator_resolved"
];
const PUBLICATION_OUTCOMES: readonly PublicationOutcome[] = ["success", "failed", "refused", "skipped", "reconciled"];

type CounterName =
  | "gateway_reconnects_total"
  | "lease_conflicts_total"
  | "lease_losses_total"
  | "interactions_total"
  | "job_sweeps_total"
  | "publication_reconciliations_total"
  | "publication_outcomes_total";

export type OperationalMetrics = {
  setGatewayReady: (ready: boolean) => void;
  recordGatewayReconnect: () => void;
  setLeaseState: (state: LeaseState) => void;
  recordLeaseConflict: () => void;
  recordLeaseLoss: () => void;
  recordInteraction: (outcome: InteractionOutcome) => void;
  recordJobSweep: (outcome: JobSweepOutcome) => void;
  setPublicationMode: (mode: PublicationMode) => void;
  setPublicationObservationStatus: (status: PublicationObservationStatus) => void;
  recordPublicationReconciliation: (outcome: PublicationReconciliationOutcome) => void;
  recordPublicationOutcome: (outcome: PublicationOutcome) => void;
  setPublicationRevision: (revision: number) => void;
  setPublicationOutboxStateCounts: (counts: Partial<Record<(typeof PUBLICATION_OUTBOX_STATES)[number], number>>) => void;
  setReminderStateCounts: (counts: Partial<Record<(typeof REMINDER_STATES)[number], number>>) => void;
  setEffectStateCounts: (counts: Partial<Record<(typeof EFFECT_STATES)[number], number>>) => void;
  refreshFromDatabase: (db: SqliteDatabase) => void;
  snapshot: () => Record<string, unknown>;
  renderPrometheus: () => string;
};

export function createOperationalMetrics(options: { databasePath?: string; now?: () => Date } = {}): OperationalMetrics {
  let gatewayReady = false;
  let leaseHeld = false;
  const counters: Record<CounterName, number> = {
    gateway_reconnects_total: 0,
    lease_conflicts_total: 0,
    lease_losses_total: 0,
    interactions_total: 0,
    job_sweeps_total: 0,
    publication_reconciliations_total: 0,
    publication_outcomes_total: 0
  };
  const interactionCounters: Record<InteractionOutcome, number> = {
    success: 0,
    rejected: 0,
    failed: 0,
    mutation_refused: 0
  };
  const sweepCounters: Record<JobSweepOutcome, number> = {
    completed: 0,
    completed_with_failures: 0,
    noop: 0,
    failed: 0
  };
  const reminderCounts = emptyCounts(REMINDER_STATES);
  const effectCounts = emptyCounts(EFFECT_STATES);
  const publicationOutboxCounts = emptyCounts(PUBLICATION_OUTBOX_STATES);
  const publicationReconciliationCounters = emptyCounts(PUBLICATION_RECONCILIATION_OUTCOMES);
  const publicationOutcomeCounters = emptyCounts(PUBLICATION_OUTCOMES);
  let publicationMode: PublicationMode = "disabled";
  let publicationObservationStatus: PublicationObservationStatus = "disabled";
  let publicationRevision = 0;
  let oldestPublicationOutboxAgeSeconds = 0;
  let oldestDueReminderAgeSeconds = 0;
  let reconciliationBacklog = 0;
  let sqliteLogicalBytes = 0;
  let sqlitePhysicalBytes = 0;
  let sqliteWalBytes = 0;
  let refreshedAtSeconds = 0;

  const metrics: OperationalMetrics = {
    setGatewayReady: (ready) => {
      gatewayReady = ready;
    },
    recordGatewayReconnect: () => {
      counters.gateway_reconnects_total += 1;
    },
    setLeaseState: (state) => {
      leaseHeld = state === "held";
    },
    recordLeaseConflict: () => {
      counters.lease_conflicts_total += 1;
    },
    recordLeaseLoss: () => {
      counters.lease_losses_total += 1;
      leaseHeld = false;
    },
    recordInteraction: (outcome) => {
      counters.interactions_total += 1;
      interactionCounters[outcome] += 1;
    },
    recordJobSweep: (outcome) => {
      counters.job_sweeps_total += 1;
      sweepCounters[outcome] += 1;
    },
    setPublicationMode: (mode) => {
      publicationMode = mode;
      if (mode === "disabled") publicationObservationStatus = "disabled";
      else if (publicationObservationStatus === "disabled") publicationObservationStatus = "idle";
    },
    setPublicationObservationStatus: (status) => {
      publicationObservationStatus = status;
    },
    recordPublicationReconciliation: (outcome) => {
      counters.publication_reconciliations_total += 1;
      publicationReconciliationCounters[outcome] += 1;
    },
    recordPublicationOutcome: (outcome) => {
      counters.publication_outcomes_total += 1;
      publicationOutcomeCounters[outcome] += 1;
    },
    setPublicationRevision: (revision) => {
      publicationRevision = nonNegativeInteger(revision);
    },
    setPublicationOutboxStateCounts: (counts) => {
      for (const state of PUBLICATION_OUTBOX_STATES) publicationOutboxCounts[state] = nonNegativeInteger(counts[state]);
    },
    setReminderStateCounts: (counts) => {
      for (const state of REMINDER_STATES) reminderCounts[state] = nonNegativeInteger(counts[state]);
    },
    setEffectStateCounts: (counts) => {
      for (const state of EFFECT_STATES) effectCounts[state] = nonNegativeInteger(counts[state]);
    },
    refreshFromDatabase: (db) => {
      metrics.setReminderStateCounts(queryStateCounts(db, "event_reminders"));
      metrics.setEffectStateCounts(queryStateCounts(db, "external_effect_intents"));
      metrics.setPublicationOutboxStateCounts(queryStateCounts(db, "public_projection_outbox"));
      const nowMs = (options.now?.() ?? new Date()).getTime();
      oldestDueReminderAgeSeconds = queryOldestDueReminderAgeSeconds(db, nowMs);
      oldestPublicationOutboxAgeSeconds = queryOldestPublicationOutboxAgeSeconds(db, nowMs);
      reconciliationBacklog = queryReconciliationBacklog(db);
      // A publication callback may report a freshly allocated revision before
      // its transaction is visible on this connection. Never regress the
      // process gauge while refreshing database-backed state.
      metrics.setPublicationRevision(Math.max(publicationRevision, queryPublicationRevision(db)));
      sqliteLogicalBytes = querySqliteLogicalBytes(db);
      const physical = queryPhysicalBytes(options.databasePath);
      sqlitePhysicalBytes = physical.databaseBytes;
      sqliteWalBytes = physical.walBytes;
      refreshedAtSeconds = Math.floor(nowMs / 1000);
    },
    snapshot: () => ({
      gatewayReady,
      leaseHeld,
      counters: { ...counters },
      interactions: { ...interactionCounters },
      jobSweeps: { ...sweepCounters },
      reminders: { ...reminderCounts },
      effects: { ...effectCounts },
      publication: {
        mode: publicationMode,
        observationStatus: publicationObservationStatus,
        outbox: { ...publicationOutboxCounts },
        reconciliation: { ...publicationReconciliationCounters },
        outcomes: { ...publicationOutcomeCounters },
        revision: publicationRevision,
        oldestOutboxAgeSeconds: oldestPublicationOutboxAgeSeconds
      },
      oldestDueReminderAgeSeconds,
      reconciliationBacklog,
      sqliteLogicalBytes,
      sqlitePhysicalBytes,
      sqliteWalBytes,
      refreshedAtSeconds
    }),
    renderPrometheus: () => renderPrometheus({
      gatewayReady,
      leaseHeld,
      counters,
      interactionCounters,
      sweepCounters,
      reminderCounts,
      effectCounts,
      publicationMode,
      publicationObservationStatus,
      publicationOutboxCounts,
      publicationReconciliationCounters,
      publicationOutcomeCounters,
      publicationRevision,
      oldestPublicationOutboxAgeSeconds,
      oldestDueReminderAgeSeconds,
      reconciliationBacklog,
      sqliteLogicalBytes,
      sqlitePhysicalBytes,
      sqliteWalBytes,
      refreshedAtSeconds
    })
  };

  return metrics;
}

function emptyCounts<const T extends readonly string[]>(states: T): Record<T[number], number> {
  return Object.fromEntries(states.map((state) => [state, 0])) as Record<T[number], number>;
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
}

function queryStateCounts(db: SqliteDatabase, table: "event_reminders" | "external_effect_intents" | "public_projection_outbox"): Record<string, number> {
  try {
    const rows = db.prepare(`SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`).all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, nonNegativeInteger(Number(row.count))]));
  } catch {
    return {};
  }
}

function queryOldestDueReminderAgeSeconds(db: SqliteDatabase, nowMs: number): number {
  try {
    const row = db.prepare("SELECT MIN(COALESCE(next_attempt_at, scheduled_for)) AS oldest FROM event_reminders WHERE state IN ('pending', 'retryable') AND COALESCE(next_attempt_at, scheduled_for) <= ?").get(new Date(nowMs).toISOString()) as { oldest?: string | null } | undefined;
    if (!row?.oldest) return 0;
    return Math.max(0, Math.floor((nowMs - Date.parse(row.oldest)) / 1000));
  } catch {
    return 0;
  }
}

function queryOldestPublicationOutboxAgeSeconds(db: SqliteDatabase, nowMs: number): number {
  try {
    const row = db.prepare("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS oldest FROM public_projection_outbox WHERE state IN ('pending', 'retryable') AND COALESCE(next_attempt_at, created_at) <= ?").get(new Date(nowMs).toISOString()) as { oldest?: string | null } | undefined;
    if (!row?.oldest) return 0;
    return Math.max(0, Math.floor((nowMs - Date.parse(row.oldest)) / 1000));
  } catch {
    return 0;
  }
}

function queryPublicationRevision(db: SqliteDatabase): number {
  try {
    const row = db.prepare("SELECT MAX(current_revision) AS revision FROM public_projection_revisions").get() as { revision?: number | null } | undefined;
    return nonNegativeInteger(Number(row?.revision ?? 0));
  } catch {
    try {
      const row = db.prepare("SELECT MAX(projection_revision) AS revision FROM public_projection_outbox").get() as { revision?: number | null } | undefined;
      return nonNegativeInteger(Number(row?.revision ?? 0));
    } catch {
      return 0;
    }
  }
}

function queryReconciliationBacklog(db: SqliteDatabase): number {
  try {
    const reminders = db.prepare("SELECT COUNT(*) AS count FROM event_reminders WHERE state = 'needs_reconciliation'").get() as { count?: number };
    const effects = db.prepare("SELECT COUNT(*) AS count FROM external_effect_intents WHERE state = 'needs_reconciliation'").get() as { count?: number };
    const publication = db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox WHERE state = 'needs_reconciliation'").get() as { count?: number };
    return nonNegativeInteger(Number(reminders?.count ?? 0) + Number(effects?.count ?? 0) + Number(publication?.count ?? 0));
  } catch {
    try {
      const reminders = db.prepare("SELECT COUNT(*) AS count FROM event_reminders WHERE state = 'needs_reconciliation'").get() as { count?: number };
      const effects = db.prepare("SELECT COUNT(*) AS count FROM external_effect_intents WHERE state = 'needs_reconciliation'").get() as { count?: number };
      return nonNegativeInteger(Number(reminders?.count ?? 0) + Number(effects?.count ?? 0));
    } catch {
      return 0;
    }
  }
}

function querySqliteLogicalBytes(db: SqliteDatabase): number {
  try {
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count?: number })?.page_count ?? 0);
    const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size?: number })?.page_size ?? 0);
    return nonNegativeInteger(pageCount * pageSize);
  } catch {
    return 0;
  }
}

function queryPhysicalBytes(databasePath?: string): { databaseBytes: number; walBytes: number } {
  if (!databasePath || databasePath === ":memory:") return { databaseBytes: 0, walBytes: 0 };
  return { databaseBytes: safeFileSize(databasePath), walBytes: safeFileSize(`${databasePath}-wal`) };
}

function safeFileSize(path: string): number {
  try {
    return nonNegativeInteger(statSync(path).size);
  } catch {
    return 0;
  }
}

function renderPrometheus(input: {
  gatewayReady: boolean;
  leaseHeld: boolean;
  counters: Record<CounterName, number>;
  interactionCounters: Record<InteractionOutcome, number>;
  sweepCounters: Record<JobSweepOutcome, number>;
  reminderCounts: Record<string, number>;
  effectCounts: Record<string, number>;
  publicationMode: PublicationMode;
  publicationObservationStatus: PublicationObservationStatus;
  publicationOutboxCounts: Record<string, number>;
  publicationReconciliationCounters: Record<string, number>;
  publicationOutcomeCounters: Record<string, number>;
  publicationRevision: number;
  oldestPublicationOutboxAgeSeconds: number;
  oldestDueReminderAgeSeconds: number;
  reconciliationBacklog: number;
  sqliteLogicalBytes: number;
  sqlitePhysicalBytes: number;
  sqliteWalBytes: number;
  refreshedAtSeconds: number;
}): string {
  const lines = [
    "# HELP kaddy_gateway_ready Whether Discord gateway identity and readiness checks are valid.",
    "# TYPE kaddy_gateway_ready gauge",
    `kaddy_gateway_ready ${input.gatewayReady ? 1 : 0}`,
    "# HELP kaddy_runtime_lease_held Whether this process holds the fenced runtime lease.",
    "# TYPE kaddy_runtime_lease_held gauge",
    `kaddy_runtime_lease_held ${input.leaseHeld ? 1 : 0}`,
    "# TYPE kaddy_gateway_reconnects_total counter",
    `kaddy_gateway_reconnects_total ${input.counters.gateway_reconnects_total}`,
    "# TYPE kaddy_runtime_lease_conflicts_total counter",
    `kaddy_runtime_lease_conflicts_total ${input.counters.lease_conflicts_total}`,
    "# TYPE kaddy_runtime_lease_losses_total counter",
    `kaddy_runtime_lease_losses_total ${input.counters.lease_losses_total}`,
    "# TYPE kaddy_interactions_total counter",
    `kaddy_interactions_total ${input.counters.interactions_total}`,
    ...Object.entries(input.interactionCounters).map(([outcome, value]) => `kaddy_interaction_outcomes_total{outcome="${outcome}"} ${value}`),
    "# TYPE kaddy_job_sweeps_total counter",
    `kaddy_job_sweeps_total ${input.counters.job_sweeps_total}`,
    ...Object.entries(input.sweepCounters).map(([outcome, value]) => `kaddy_job_sweep_outcomes_total{outcome="${outcome}"} ${value}`),
    ...Object.entries(input.reminderCounts).map(([state, value]) => `kaddy_reminder_jobs{state="${state}"} ${value}`),
    ...Object.entries(input.effectCounts).map(([state, value]) => `kaddy_external_effect_intents{state="${state}"} ${value}`),
    `kaddy_publication_mode{mode="${input.publicationMode}"} 1`,
    `kaddy_publication_observation_status{status="${input.publicationObservationStatus}"} 1`,
    ...Object.entries(input.publicationOutboxCounts).map(([state, value]) => `kaddy_public_projection_outbox{state="${state}"} ${value}`),
    ...Object.entries(input.publicationReconciliationCounters).map(([outcome, value]) => `kaddy_publication_reconciliations_total{outcome="${outcome}"} ${value}`),
    ...Object.entries(input.publicationOutcomeCounters).map(([outcome, value]) => `kaddy_publication_outcomes_total{outcome="${outcome}"} ${value}`),
    `kaddy_public_projection_revision ${input.publicationRevision}`,
    `kaddy_public_projection_outbox_oldest_age_seconds ${input.oldestPublicationOutboxAgeSeconds}`,
    `kaddy_reminder_queue_oldest_due_age_seconds ${input.oldestDueReminderAgeSeconds}`,
    `kaddy_reconciliation_backlog ${input.reconciliationBacklog}`,
    `kaddy_sqlite_logical_bytes ${input.sqliteLogicalBytes}`,
    `kaddy_sqlite_physical_bytes ${input.sqlitePhysicalBytes}`,
    `kaddy_sqlite_wal_bytes ${input.sqliteWalBytes}`,
    `kaddy_metrics_refresh_timestamp_seconds ${input.refreshedAtSeconds}`
  ];
  return `${lines.join("\n")}\n`;
}
