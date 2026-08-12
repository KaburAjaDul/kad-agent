# ADR 0003: Kaddy Homelab Runtime And Observability

- Status: accepted for the 24x7 program; implementation checkpoint in progress
- Date: 2026-08-12
- Scope: Kaddy's long-running Discord runtime, private authority, scheduling,
  and operational telemetry

## Decision

Kaddy is a distinct application from Hermes. Hermes remains its own gateway and
runtime; Kaddy does not share Hermes' process, app identity, database, lease, or
deployment lifecycle. The Kaddy app identity has one active runtime at a time.
Duplicate workers must stop before doing Discord effects or reminder work.

The homelab is the owner and intended home for the Kaddy 24x7 runtime and its
private SQLite authority. No Kaddy process or authority runs on the VPS. An
edge or VPS service may remain an independently operated dependency, but it is
never an automatic Kaddy failover and never receives a writable copy of
Kaddy's authority. Secret bootstrap must have a documented homelab recovery
path before unattended startup is accepted.

SQLite remains the private operational authority for event decisions, Effect
Intents, Reminder Jobs, Reconciliation Records, Runtime Leases, and audit
history. D1 is a derived public read model only: it receives an allowlisted,
redacted Public Agenda Projection and never becomes an editable source of
truth.

GitHub-hosted cron is the transitional owner of one bounded public-agenda
projection. It observes Discord through REST and writes a signed snapshot; it
does not open the Gateway, send reminders, or mutate Kaddy's private SQLite.
Because a hosted runner cannot acquire the homelab SQLite Runtime Lease, the
handoff is an explicit writer cutover: cron remains the sole projector until
disabled, then the homelab projector starts at a later revision and proves one
successful signed publication. The Runtime Lease gates Kaddy Gateway and
Discord-effect work, while the Worker revision/replay contract gates the
transitional projection.

## Ownership and safety

- Runtime owner: Dika (runtime owner).
- Backup owner: unassigned; any handoff or failover remains disabled until an
  operator is named and accepts the runbook.
- Privacy owner: unassigned; collection, retention changes, and privacy
  corrections fail closed until an approver is named.
- Correction owner: unassigned; Event Observation or Public Agenda Projection
  corrections fail closed until an operator is named.

These labels are explicit assignments, not inferred defaults. A missing owner,
ambiguous app identity, expired lease, or conflicting runtime blocks the
affected operation and leaves a Reconciliation Record for review.

## Observability boundary

V1 uses the standard Discord `Guilds` and `GuildScheduledEvents` intents only.
It does not request or enable `GuildMembers`, `Presence`, or
`MessageContent`. The Discord developer portal's privileged-intent notice is
an operator action for a later review: do not apply for a privileged intent in
V1, and do not toggle one in the portal without explicit operator confirmation
and a separate live-mutation change.

Operational telemetry is aggregate and private. It may describe event,
reminder, runtime, and reconciliation counts, durations, outcomes, and queue
age. It must not contain message content, member profiles, member rankings,
raw provider payloads, or secrets.

## Consequences

The homelab becomes a clear operational ownership boundary and avoids a hidden
second Kaddy runtime, but it requires a supervised process, persistent encrypted
storage, backups, a lease/recovery drill, and an operator runbook. Transitional
cron keeps bounded work observable during the build, but every cron path must
be removed or explicitly retired at homelab cutover.

The derived D1 boundary keeps public reads available without exposing private
authority. A projection can be frozen, corrected, or withdrawn while the
SQLite record and audit history remain intact.

See [the runtime program plan](../exec-plans/active/kaddy-24x7-homelab-program.md),
[the observability and retention design](../design-docs/kaddy-observability-and-data-retention.md),
[ADR 0001](0001-private-operational-authority-and-public-projection.md), and
[the threat model](../design-docs/kaddy-threat-model.md).
