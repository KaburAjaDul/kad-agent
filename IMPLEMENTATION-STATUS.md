# Implementation Status

- Milestone: M0/M1A Kaddy end-to-end foundation
- Scope of this checkpoint: M0 architecture/domain contracts plus M1A bot
  runtime, dependency, CI, and container safety.
- Status: local code, documentation, audit, dry-run, and independent review
  gates are green. A fresh container rebuild is delegated to PR CI because the
  local Docker Hub metadata request timed out; do not merge until that job is
  green.
- Private authority: existing SQLite event-operation foundation.
- External effect: existing Discord Scheduled Event and announcement binding;
  reconciliation/compensation remains a later reliability slice.
- Public read model: D1 (planned boundary).
- Presentation: website reads approved D1 projections (planned boundary).
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
- Blockers for public projection work: actual role-owner assignments, D1
  schema/ingress, signing/replay contract, and website adapter do not exist.
- Residual risk: Discord create/announce compensation, reminder lease/retry,
  shutdown hard-timeout, SQLite backup/restore, D1 projection, and browser
  behavior are not completed by this checkpoint.
