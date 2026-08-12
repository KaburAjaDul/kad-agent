# Kaddy 24x7 Homelab Runtime Program

## Objective and current state

Move Kaddy from bounded transitional scheduling to one supervised homelab
runtime with private SQLite authority, durable leases, reconciled Discord
effects, and aggregate privacy-safe observability. This program is a plan, not
evidence that the runtime is live. The checkpoint is **in progress**.

The target has no Kaddy process or writable authority on the VPS. GitHub-hosted
cron remains the sole transitional public-agenda projector until an explicit
writer handoff. It cannot use the homelab SQLite lease; instead, its writes are
bounded by the existing signed revision/replay contract. It is disabled before
the homelab projector publishes its first later revision.

## Checkpoints and PR order

### Checkpoint 1 — contract and privacy gate (PR 1)

Deliver the vocabulary, ADR, observability/retention design, owner matrix, and
this program plan. Confirm that Kaddy is distinct from Hermes, homelab is the
runtime owner, SQLite is private authority, D1 is derived, and V1 uses only
`Guilds` and `GuildScheduledEvents`.

Acceptance:

- documentation link, terminology, and formatting gates pass;
- every required role is either assigned or explicitly fail-closed;
- retention proposals, deletion, correction, and privileged-intent notice
  action have an approver and a recorded decision path.

Stop gate: do not build or enable collection if the app identity, owner
matrix, intent list, or public/private boundary is ambiguous.

### Checkpoint 2 — one-runtime reliability and telemetry (PR 2)

Implement one app identity per active Runtime Lease, SQLite-backed Effect
Intents and Reconciliation Records, restart-safe Reminder Jobs, and the
aggregate Event/Reminder/Runtime/Reconciliation Operational Metrics described
in the design doc. Keep cron bounded to public projection only; it must never
perform Kaddy Gateway or Discord-effect work.

Acceptance:

- duplicate-runtime and expired-lease tests stop the second worker;
- process death before/after an external call leaves an auditable intent and
  no blind retry;
- reconciliation reports unknown or mismatched effects instead of guessing;
- metrics redaction tests reject member/message content, rankings, secrets,
  and raw provider payloads;
- backup/restore and retention/deletion dry runs pass.

Stop gate: no live Discord effects, public projection, or 24x7 claim while
lease recovery, backup/restore, or redaction evidence is missing.

### Checkpoint 3 — supervised homelab cutover (PR 3)

Deploy the digest-pinned Kaddy runtime on the homelab with persistent encrypted
SQLite storage, health/readiness probes, restart policy, alerting, and an
operator runbook. Exercise cron-to-homelab handoff, rollback, correction,
projection withdrawal, and shutdown. Retire transitional cron immediately
before the homelab projector publishes a strictly later revision; rollback
restores one named projector, never two concurrent writers.

Acceptance:

- a single active Runtime Lease is observed for the app identity and only one
  public-agenda projector is enabled;
- restart, disk/WAL, queue-age, reconciliation, and projection-lag alerts
  reach the private operator surface;
- restore rehearsal meets the accepted RPO/RTO and leaves audit evidence;
- correction/deletion and last-known-good projection behavior are verified;
- an operator confirms no privileged Discord intent is enabled.

Stop gate: keep cron transitional and public writes frozen on any duplicate
lease, failed restore, unresolved reconciliation, missing owner, failed
deletion, or unreviewed portal intent change. Do not fall back to a VPS.

## Documentation acceptance gate

Run from the repository root for Checkpoint 1 and every documentation-only PR:

```sh
test -f CONTEXT.md
test -f docs/adr/0003-kaddy-homelab-runtime-and-observability.md
test -f docs/design-docs/kaddy-observability-and-data-retention.md
test -f docs/exec-plans/active/kaddy-24x7-homelab-program.md
rg -n "Event Observation|Effect Intent|Reminder Job|Reconciliation Record|Runtime Lease|Operational Metric|Public Agenda Projection" CONTEXT.md docs/adr/0003-kaddy-homelab-runtime-and-observability.md docs/design-docs/kaddy-observability-and-data-retention.md docs/exec-plans/active/kaddy-24x7-homelab-program.md
rg -n "Guilds|GuildScheduledEvents|GuildMembers|Presence|MessageContent|Hermes|homelab|VPS|D1|SQLite|GitHub-hosted cron|fail closed|not live" docs/adr/0003-kaddy-homelab-runtime-and-observability.md docs/design-docs/kaddy-observability-and-data-retention.md docs/exec-plans/active/kaddy-24x7-homelab-program.md IMPLEMENTATION-STATUS.md
git diff --check
```

The link check must resolve every relative Markdown target in the changed
documents. A passing docs gate proves the contract is present; it does not
prove a running process, a live Discord connection, or a production D1 write.

## Rollback and ownership

Dika is the runtime owner. Backup, privacy, and correction owners remain
unassigned until explicitly accepted; their affected operations fail closed.
Rollback disables dispatch and projection writes, preserves SQLite and audit
history, and serves the last-known-good public projection where safe. It does
not silently switch runtime hosts or infer Discord success.

## Program evidence

Each PR must attach command output for its acceptance gates, a changed-file
summary, and the unresolved-risk list. A green documentation gate does not
make the runtime live; only Checkpoint 3's supervised cutover evidence can do
that.

See [ADR 0003](../../adr/0003-kaddy-homelab-runtime-and-observability.md),
[the observability design](../../design-docs/kaddy-observability-and-data-retention.md),
[the domain context](../../../CONTEXT.md), and
[the threat model](../../design-docs/kaddy-threat-model.md).
