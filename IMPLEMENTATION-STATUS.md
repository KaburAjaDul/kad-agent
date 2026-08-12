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
- M0/M1A local code, documentation, audit, dry-run, and independent review
  gates are green. This does not make the 24x7 homelab checkpoint live. A fresh
  container rebuild is delegated to PR CI because the local Docker Hub
  metadata request timed out; do not merge until that job is green.
- Private authority: SQLite event-operation foundation; durable lease/effect
  changes are under implementation and are not deployed.
- External effect: existing Discord Scheduled Event and announcement binding;
  reconciliation/compensation remains a later reliability slice.
- Public read model: the staging D1 signed-ingest boundary exists; production
  cutover and SQLite-owned projection do not.
- Presentation: the staging website reads the approved D1 agenda API; program
  detail and production routes are not yet end-to-end live.
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
  loopback liveness/readiness endpoints, graceful shutdown, pinned Node major,
  dependency audit, CI, and a Node-major-pinned non-root runtime container.
- Blockers for production projection cutover: actual role-owner assignments,
  SQLite outbox/projector ownership, a cron-to-homelab writer handoff, and
  production website bindings.
- Residual risk: Discord create/announce compensation, reconciliation,
  shutdown hard-timeout, SQLite backup/restore, homelab supervision, and
  production browser behavior are not completed by this checkpoint.
