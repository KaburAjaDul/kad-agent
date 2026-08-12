# Implementation Status

## 24x7 homelab checkpoint

- Status: **in progress; not live**. The Kaddy 24x7 homelab runtime,
  supervised lease, retention policy, and observability cutover have not been
  enabled.
- Runtime owner: Dika. Backup, privacy, and correction owners are unassigned;
  affected operations fail closed until explicitly assigned.
- Kaddy remains distinct from Hermes. The intended runtime owner is the
  homelab; no Kaddy process or writable authority belongs on the VPS.
- SQLite remains private operational authority. D1 remains a derived public
  projection, and GitHub-hosted cron is transitional only.
- V1 Discord intents are `Guilds` and `GuildScheduledEvents` only. Do not
  apply for or enable `GuildMembers`, `Presence`, or `MessageContent`; any
  portal toggle requires later operator confirmation and a live-mutation
  change.
- Planned telemetry is aggregate event, reminder, runtime, and
  reconciliation metrics only: no member/message content, ranking, secrets,
  or raw provider payloads.
- The active delivery order and stop gates are in
  [the 24x7 homelab program](docs/exec-plans/active/kaddy-24x7-homelab-program.md).

- Milestone: M0/M1A Kaddy end-to-end foundation
- Scope of this checkpoint: M0 architecture/domain contracts plus M1A bot
  runtime, dependency, CI, and container safety.
- M0/M1A local code, documentation, audit, dry-run, release, and independent
  review gates are green. The digest-pinned distroless Node 24 image is non-root
  and its strict HIGH/CRITICAL vulnerability gate is green. This still does not
  make the 24x7 homelab checkpoint live.
- Private authority: SQLite now contains fenced Runtime Leases, Effect Intents,
  Event Observations, publication approvals, projection revisions, and a
  durable projection outbox. These controls are locally verified but are not
  yet deployed on the homelab.
- External effect: Discord Scheduled Event creation, announcement, reminder,
  and reconciliation paths use durable fenced intent state. Ambiguous outcomes
  require reconciliation instead of blind retry.
- Public read model: staging D1 and the website consume the signed projection.
  The legacy GitHub-hosted projector remains the only enabled writer until the
  explicit homelab handoff is completed.
- Presentation: staging routes read real agenda data and expose safe event and
  Study Club detail views. Production promotion remains outside this cutover.
- First public allowlist: Language Club Agenda Entry only.
- Forbidden public fields: internal notes, assignments, member/private
  identity data, approval rationale, raw payloads, secrets, and unredacted
  errors.
- Approval distinctions: operational approval, publication approval, and
  person-owned identity consent with separate privacy verification.
- Pending actual assignments: fail closed.
- Proposed targets: cancellation 5m, identity withdrawal 5m, correction
  acknowledgement 2 business days and projection 30m after approval.
- R2: explicitly out of the first slice.
- Implemented M1A controls: explicit Discord guild allowlist, safe mention
  policy, interaction error boundary, redacted bounded provider errors,
  private liveness/readiness/metrics endpoints, graceful shutdown, dependency
  audit, CI, and a digest-pinned non-root distroless runtime container.
- Blockers for homelab projection cutover: actual backup/privacy/correction
  owner assignments; materialized file-backed secrets; encrypted off-host
  backup plus restore evidence; reviewed shadow approvals; proof that no
  legacy cron run is queued or in progress; and one signed live canary whose
  revision is strictly newer than the Worker checkpoint.
- Residual live risk: homelab supervision, Discord permissions, alert delivery,
  reboot recovery, backup/restore, and rollback remain unproven until the
  guarded deployment and soak receipts are captured.
