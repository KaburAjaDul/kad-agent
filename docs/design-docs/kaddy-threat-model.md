# Kaddy Threat Model: Private Authority And Public Projection

## Assets

- SQLite operational records and audit history.
- Staff, host, speaker, and member identity data.
- Discord Event Binding IDs and effect results.
- D1 public projections and website availability.
- Approval evidence, correction history, and rollback evidence.

## Trust boundaries

1. Staff/operator input enters the private operational boundary.
2. SQLite remains the authority inside that boundary.
3. Discord is an external effect boundary; its IDs and responses are untrusted
   until recorded and reconciled.
4. D1 is a public read-model boundary; it receives only approved, allowlisted,
   redacted projections.
5. The website is an untrusted presentation/cache boundary and must not mutate
   private authority.

## Threats and controls

| Threat | Control | Fail-closed outcome |
| --- | --- | --- |
| Discord or website becomes source of truth | SQLite authority; immutable effect ledger | halt projection or reconciliation |
| Unapproved event reaches public web | Language Club Agenda Entry-only allowlist plus publication approval | no D1 write |
| Private field leaks through projection | explicit forbidden-field check and schema-level public field set | reject projection |
| Wrong person represented publicly | person-owned identity consent plus privacy verification | hold publication |
| Missing owner or pending assignment | role-owner matrix with actual assignment required | reject operation |
| Duplicate or replayed publish | stable projection/version key and idempotent write | retain one approved version |
| Stale correction or cancellation | version check plus cancellation/withdrawal SLA monitor | withdraw or mark stale |
| Discord partial success | persist effect result, reconcile, and never infer success | operator review; no blind retry |
| D1 partial/ambiguous write | write verification tied to projection version | rollback/hold website presentation |
| Secret, token, or raw payload exposure | forbidden fields and redaction; no R2 in M0 | reject and alert privately |
| Signed projection replay or rollback | canonical versioned envelope, key ID, nonce/expiry, monotonic revision | reject before D1 transaction |
| Compromised publication key | revocable key registry, overlap-only rotation, kill switch | reject key and freeze projection writes |
| SQLite loss or corrupt migration | single writer, pre-migration backup, checksum, restore drill | stop runtime and restore verified copy |

## Role owners

The event operator owns operational approval. The publication approver owns the
public field set and publication decision. The represented person owns identity
consent, while the privacy approver verifies its scope and evidence. The runtime operator owns effect
reconciliation and rollback execution. A pending actual assignment for any
required role blocks the action.

## Abuse and failure scenarios

- A requester attempts to publish Cerita Aja Dulu by labeling it as a Language
  Club item: the allowlist checks the authoritative Program/Series relation and
  rejects it.
- Discord creates an event but the private write is unavailable: record an
  external-effect discrepancy, do not create a D1 projection, and require
  reconciliation before another attempt.
- A correction contains a private staff note: forbidden-field validation rejects
  the entire projection; it does not partially redact and publish.
- A privacy approver leaves or loses authority: pending verification fails
  closed, and an operator must reassign explicitly; nobody may infer consent.

## Recovery gates

Rollback is permitted only after identifying the authoritative record,
projection version, external effect ID (if any), and responsible operator.
Recovery must be idempotent, preserve audit history, withdraw unsafe public
projections, and leave unresolved discrepancies visible to staff. No automated
R2 copy or backup is introduced in M0.

## Security acceptance before public ingress

The projection envelope must define canonical bytes, schema and envelope
versions, `key_id`, `issued_at`, expiry, unique nonce, entity ID, monotonic
revision, operation (`upsert` or `tombstone`), and a payload hash. The Worker
must authenticate against a revocable public-key registry, reject expired or
replayed envelopes, rate-limit ingress, and commit the nonce/revision and D1
mutation atomically. Last-known-good public data remains readable when writes
are frozen; it must never override a newer tombstone.

No production migration or bot supervisor is approved until the operator has
recorded single-writer ownership, encrypted backup destination, retention,
RPO/RTO, checksum procedure, restore drill evidence, disk/WAL alerts, and a
rollback command. Proposed initial targets are RPO 15 minutes and RTO 2 hours;
they remain non-binding until the runtime owner accepts them.
