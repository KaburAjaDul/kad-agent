# M0 Execution Plan: Kaddy End-To-End Foundation

## Objective

Specify the smallest end-to-end foundation for a safe private-to-public event
projection. This file is the acceptance contract and delivery backlog. M1A is
implemented on the accompanying branch; later milestones remain unimplemented
until their own status and verification evidence say otherwise.

## In scope

- canonical domain vocabulary: Program, Series, Session, Standalone Gathering,
  Agenda Entry, Run-of-Show Item, and Discord Event Binding;
- SQLite private operational authority;
- Discord external effect recording and reconciliation boundary;
- D1 public read model and website presentation boundary;
- Language Club Agenda Entry as the first and only public allowlist;
- separate operational approval, publication approval, and person-owned
  identity consent with privacy verification;
- explicit role owners, fail-closed pending assignments, and rollback gates;
- proposed cancellation, identity-withdrawal, and correction service targets.

## Out of scope

Public Cerita Aja Dulu or Regional Sharing projections, arbitrary public content,
member analytics, social publishing, external sync, media storage, and R2.

## Dependency graph and checkpoints

1. **Vocabulary checkpoint:** review [CONTEXT.md](../../../CONTEXT.md) and agree
   on entity relationships before naming tables, APIs, or UI fields.
2. **Boundary checkpoint:** review the [ADR](../../adr/0001-private-operational-authority-and-public-projection.md),
   [publication boundary](../../design-docs/public-publication-boundary.md),
   and [threat model](../../design-docs/kaddy-threat-model.md). Confirm the
   allowlist, forbidden fields, approval distinctions, owners, and rollback
   gates.
3. **Acceptance checkpoint:** implementers may proceed only after the docs pass
   link and terminology checks and an approver records the actual role
   assignments. Missing assignments remain a hard stop.

## Required future implementation slices

- model the private authority and approval records in SQLite;
- model Discord Event Binding as an external effect with reconciliation state;
- derive a versioned, redacted D1 projection for Language Club Agenda only;
- render D1 records on the website without write access to private authority;
- add cancellation, withdrawal, and correction handling against the proposed
  targets;
- add rollback probes for each failed gate and preserve audit evidence.

Each slice must add tests for allowlist enforcement, forbidden-field rejection,
approval separation, missing-owner failure, idempotency, and external-effect
discrepancy handling before claiming the checkpoint green.

## Delivery sequence after this contract

### M1A — runtime safety bootstrap (this branch)

Add CI, reproducible build/container output, a guild allowlist, safe mention
policy, structured redaction, interaction error containment, readiness, and
graceful shutdown. This checkpoint reduces immediate bot risk but does not make
Discord effects durable or enable D1.

Acceptance: frozen install, zero high/critical dependency findings, typecheck,
unit tests, production build, dry-run, container build and non-root smoke, plus
an independent diff review. Rollback: stop the new container and run the prior
bot revision; no new public schema or external publication is introduced.

### M1B — durable Discord effects and reminders

Persist each external intent before calling Discord. Use a deterministic
idempotency key derived from guild, operation kind, and authoritative record;
state transitions `pending → leased → succeeded`, with `retryable`,
`needs_reconciliation`, and terminal `cancelled` paths. Leases need owner,
expiry, heartbeat, attempt count, bounded exponential backoff, and a dead-letter
threshold. Recover expired `sending` reminders. Reconciliation must discover
stored Discord IDs, detect duplicates, verify channel/guild ownership, and
support audited operator retry. Compensation may cancel an orphan Scheduled
Event only when its stored binding and authoritative intent match.

Acceptance: failure-injection tests cover process death before/after every
write and Discord call, ambiguous timeout, duplicate delivery, expired lease,
compensation refusal, and manual repair. A backup/restore and migration rollback
drill must pass before live enablement. Rollback: disable dispatchers and leave
intents queued; never blind-retry an ambiguous effect.

### M2 — approvals and private outbox

Add explicit operational/publication approval records, actor authority,
decision reason, policy version, expiry, and immutable audit entries. Create a
private projection outbox only after approval; missing assignments fail closed.
The first source allowlist is the exact Language Club tuple in the publication
boundary document.

Acceptance: authorization matrix, approval separation, stale/revoked approval,
source spoofing, and deny-by-default tests. Rollback: stop the outbox publisher;
retain private records and audit history.

### M3 — signed D1 projection and public API

Sanitize into `language_club_agenda_entry.v1`, sign a canonical Ed25519
envelope, and send it from an outbound-only projector to a rate-limited Worker.
The Worker enforces key ID/rotation, issued-at/expiry, nonce replay protection,
monotonic revisions, atomic tombstones, and an idempotent D1 transaction. It
serves a versioned anonymous read API with ETags, freshness metadata, and
last-known-good behavior. R2 remains disabled.

Acceptance: schema/redaction fuzzing, private-ID scan, replay/rollback/key
rotation tests, tombstone dominance, DLQ/checkpoint recovery, staging canary,
kill switch, and last-known-good rollback. Rollback: freeze writes and serve the
prior safe projection; never fall back to fixtures in production.

### M4 — website adapter

Implement an API-backed public-content repository behind the existing web
interface. Preserve fixture parity only in staging/test, add loading, empty,
stale, withdrawn, and unavailable states, and keep every event action as a
Discord join funnel rather than registration.

Acceptance: contract tests plus localized Playwright coverage against an
isolated staging Worker/D1, accessibility checks, cache invalidation, and a
production build scan proving fixtures and private identifiers are absent.
Rollback: disable the API adapter and serve the last approved static snapshot.

### M5 — volunteer, consent, and contribution ledger

Only after the event path is stable, add volunteer intake and a private
contribution ledger. Public identity is opt-in and purpose/version scoped;
record consent evidence, effective time, withdrawal, attribution review, and
tombstone propagation. Individual pages show contributions to Programs, never
program-success metrics attributed to a person. Recruiter proof is a separate
later capability using hashed, expiring, revocable tokens with no indexing or
token logging.

Acceptance: opt-in/out, withdrawal propagation, cache purge, identity mismatch,
proof expiry/replay/rate-limit, and audit tests. Rollback: disable public ledger
projection and tombstone identity while preserving private evidence.

### M6 — production operations

Deploy one supervised bot writer with a persistent encrypted volume and a
separate bounded projector. Add migration lock, encrypted off-host backups,
restore rehearsal, alerting for queue age/failures/WAL/disk/projection lag,
access review, secret rotation, canary promotion, and incident runbooks. Do not
enable text/voice/member intents or analytics until a separate privacy and
retention decision passes.

Acceptance: accepted RPO/RTO, restore and key-rotation drills, dispatcher drain,
Discord reconciliation, public rollback, and no open P0/P1 review findings.

## Required owner decisions

The implementation must not infer these: named event/publication/privacy/runtime
and rollback owners; deployment host and supervisor; backup destination and
accepted RPO/RTO; Cloudflare environment and least-privilege credentials;
public locales/freshness window/correction channel; and whether any future
Discord privileged intent is justified. The current value for each is
`unassigned`, which disables the affected live capability.

## Acceptance commands

From the repository root, the documentation checkpoint should pass:

```sh
test -f CONTEXT.md
test -f docs/adr/0001-private-operational-authority-and-public-projection.md
test -f docs/design-docs/public-publication-boundary.md
test -f docs/design-docs/kaddy-threat-model.md
test -f docs/exec-plans/active/kaddy-e2e-foundation.md
rg -n "Program|Series|Session|Standalone Gathering|Agenda Entry|Run-of-Show Item|Discord Event Binding|SQLite|Discord|D1|Language Club Agenda Entry|forbidden|R2|fail closed|rollback" CONTEXT.md docs/adr/0001-private-operational-authority-and-public-projection.md docs/design-docs/public-publication-boundary.md docs/design-docs/kaddy-threat-model.md docs/exec-plans/active/kaddy-e2e-foundation.md
```

The implementation gate remains separate and must not be reported green until
its own code, migration, runtime, and browser checks exist and pass.
