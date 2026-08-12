# Kaddy Observability And Data Retention

## Purpose and status

This is the V1 observability and privacy contract for the 24x7 homelab
program. Values marked **proposal** require the named privacy owner to accept
them before live collection. The checkpoint is in progress; no 24x7 collection
or production retention policy is live.

## Collection boundary

Kaddy uses Discord's standard `Guilds` and `GuildScheduledEvents` intents in
V1. It does not request `GuildMembers`, `Presence`, or `MessageContent`.
Guild and scheduled-event metadata is limited to what is needed to reconcile
approved event work and produce the allowlisted public agenda. No message
bodies, attachments, transcripts, member profiles, presence, or voice
recordings are collected by this contract.

The Discord developer portal may show a privileged-intent notice. V1 does not
apply for a privileged intent. Any future portal toggle requires an explicit
operator confirmation, a documented purpose and field review, and a separate
live-mutation change; a portal toggle is never an automatic remediation.

## Metric contract

Operational Metrics are aggregate, private, and explainable. They are not a
public score, member ranking, sentiment signal, or moderation/risk score.

| Area | V1 aggregates | Explicitly excluded |
| --- | --- | --- |
| Event | observations by outcome, approved/publication state, correction and withdrawal counts, reconciliation lag | event payload dumps, private notes, unapproved fields |
| Reminder | jobs due/sent/failed/cancelled, delivery latency, retry and queue age | reminder message bodies, member-level ranking |
| Runtime | process health, lease conflicts/expiry, job duration, restart and shutdown outcomes, SQLite/WAL/disk pressure | host secrets, environment dumps, provider payloads |
| Reconciliation | intents matched, mismatched, unknown, retried, operator-resolved, and age of unresolved records | inferred success, silent repair, raw Discord responses |
| Public projection | projection upsert/tombstone outcome, revision, freshness, and lag | private identifiers, raw event IDs, member/message data |

Metrics are staff-operational data. They may be shown in an authorized staff
report or dashboard, but never in public channels, a public agenda, a
leaderboard, or a member-visible thread. A report generated from these metrics
must remain aggregate and must not name or rank members.

## Proposed retention and minimization

The following are initial proposals, not an authorization to collect. The
privacy owner must approve the values and a correction owner must accept the
deletion procedure before live enablement.

| Record class | What is retained | Proposal | Minimization rule |
| --- | --- | --- | --- |
| Event Observation | event identity reference, observed state, timestamp, source, and redacted reason | 180 days after last observation | no raw provider payload or private description |
| Effect Intent | operation kind, app identity, authoritative record reference, state, attempt count, and outcome class | 180 days after terminal state | no token, request body, or member content |
| Reminder Job | due time, purpose, aggregate outcome, latency, and error class | 180 days after terminal state | no reminder body or recipient list in telemetry |
| Reconciliation Record | compared references, status, timestamps, and operator decision | 365 days after resolution; unresolved records stay until resolved | preserve uncertainty and audit reason, not raw payload |
| Runtime Lease | app identity, owner label, acquired/expired/released times, and conflict count | 90 days after release | no host inventory or secret material |
| Operational Metric | daily/hourly aggregate, metric name, value, and period | 180 days | aggregate only; no member/message dimensions |
| Public Agenda Projection | public fields, revision, tombstone, and freshness metadata | while public or 30 days after withdrawal | no private authority fields or raw IDs |
| Access/correction audit | actor, action, reason, policy version, and result | 365 days | never log payloads, tokens, or message content |

Deletion is a bounded maintenance job owned by the correction owner. It must
use a recorded cutoff, report counts by record class, and leave the audit
decision without retaining deleted payloads. A failed deletion blocks further
collection for that class and alerts the runtime owner.

## Correction and withdrawal

An authorized privacy or safety report creates a Reconciliation Record and
pauses the affected projection or effect. The correction owner verifies scope,
then either:

1. corrects the private authority and emits a new redacted projection;
2. withdraws the Public Agenda Projection with a tombstone; or
3. rejects the report with an explicit reason and keeps the record unchanged.

Corrections never silently overwrite history. The old value is not copied into
telemetry; the audit trail keeps only the decision, actor, timestamp, and
policy version. Aggregate Operational Metrics are recomputed from the
corrected source where feasible. If recomputation cannot remove an unsafe
value, the metric is tombstoned and excluded from future reports.

Deletion and correction requests fail closed when the privacy or correction
owner is unassigned, the target is ambiguous, or the source cannot be
verified. The runtime owner may stop collection and publication, but may not
approve their own privacy exception.

## Acceptance and stop gates

Before the homelab runtime is called live, the program must show:

- an approved intent list proving only `Guilds` and `GuildScheduledEvents`;
- a redaction test proving no member/message content, ranking, secret, or raw
  provider payload enters telemetry;
- retention/deletion dry-run evidence for every record class;
- correction and projection-withdrawal evidence with an unassigned-owner
  failure case;
- lease-conflict, restart, backup/restore, and stale-cron checks; and
- an operator-confirmed decision that no privileged intent is enabled.

Any missing owner, retention approval, failed deletion, duplicate runtime,
ambiguous reconciliation, or privileged-intent toggle stops collection and
public projection. Last-known-good public data may remain readable, but no new
write proceeds until the issue is resolved and recorded.

