# Public Publication Boundary

## Purpose

Define the one-way boundary from private event operations to public web
presentation for M0. The boundary is narrow by design and is not a general
content-publishing system.

## Surfaces and authority

| Surface | Role | Authority |
| --- | --- | --- |
| SQLite | private operational record, approval trail, identity and effect ledger | authoritative |
| Discord | external event/announcement effect and staff interaction surface | external effect |
| D1 | public read model containing approved projections only | derived projection |
| Website | presentation of D1-approved records | presentation |

The publication flow is: private record → operational approval → publication
approval → projection write to D1 → website presentation. A Discord Event
Binding may be created as an external effect, but it cannot authorize the D1
projection by itself.

## M0 allowlist

The only public item permitted in M0 is a **Language Club Agenda Entry**. This
means the public projection can expose the approved schedule listing for a
Language Club Session, with its safe Program and Series labels. Internal
Run-of-Show Items remain private. Cerita Aja
Dulu, Regional Sharing, arbitrary Standalone Gatherings, private agendas, and
unreviewed Sessions are denied by default.

The initial allowlist is the exact tuple below, not a fuzzy name match:

| Contract field | Allowed value |
| --- | --- |
| authoritative event type | `language_club` |
| classification | `routine_language_club` |
| private template | `language_club_default` version `1` |
| public projection type | `language_club_agenda_entry.v1` |

The existing `routine_auto_publish` class permits the Discord operational
effect only. It does not replace publication approval for D1. Any template,
version, classification, or projection type outside this tuple is denied until
an ADR explicitly widens the allowlist.

## Allowed and forbidden fields

Allowed fields are limited to:

- stable public projection identifier;
- `Program` and `Series` labels when already approved for public display;
- Language Club Agenda Entry title and concise participant-facing description;
- scheduled start/end and timezone;
- public venue label or approved Discord destination label;
- publication version, status, and correction/withdrawal timestamp.

Forbidden fields include internal notes, staff/volunteer assignments, member or
speaker private identifiers, contact details, moderation or safety notes,
approval rationale, identity evidence, raw Discord payloads, access tokens,
secrets, private URLs, and unredacted error details.

## Approval distinctions and owners

- **Operational approval** confirms the Session or Standalone Gathering is
  correct to run. Owner: designated event operator.
- **Publication approval** confirms the allowlisted public fields and audience.
  Owner: designated publication approver.
- **Identity consent** confirms that a person chose the selected public
  representation. Owner: the represented person; a designated privacy
  approver verifies scope and evidence but cannot consent on that person's
  behalf.

These approvals are not interchangeable. Pending actual assignments, missing
identity evidence, or an owner mismatch must fail closed.

The first projection contains no public person identity field, so identity
consent is not required to publish that identity-free record. Adding hosts,
speakers, volunteers, avatars, handles, or contribution attribution changes
that fact and requires a consent-versioned schema review first.

## Assignment gate

| Authority | Current assignee | Gate |
| --- | --- | --- |
| event operator | unassigned | blocks operational enablement outside the existing staff-role policy |
| publication approver | unassigned | blocks every D1 write |
| privacy verifier | unassigned | blocks any future identity-bearing projection |
| runtime/reconciliation operator | unassigned | blocks dispatcher and repair-job enablement |
| rollback authority | unassigned | blocks production projection deployment |

Repository or Discord role names are not assignees. Each production
environment must record the responsible person or on-call group and a backup;
`unassigned` always means disabled.

## Lifecycle and proposed service targets

- **Cancellation:** stop future external effects and mark the projection
  withdrawn within 5 minutes of an approved cancellation.
- **Identity withdrawal:** tombstone the public identity projection within 5
  minutes of accepting a valid withdrawal request.
- **Factual correction:** acknowledge the request within 2 business days and
  publish an approved corrected projection within 30 minutes of approval;
  retain the prior version for audit, not presentation.

These are proposed M0 service targets, not claims about current runtime
behavior. If a target cannot be met, the system must expose a safe failure and
operator action rather than silently presenting stale data.

## Rollback gates

Rollback or halt publication when any gate fails:

1. allowlist, owner, identity, or approval checks are incomplete;
2. a forbidden field is present or redaction is uncertain;
3. the SQLite authority and external Discord effect disagree without a
   recorded reconciliation result;
4. the D1 write is partial, ambiguous, or cannot be tied to a projection
   version;
5. website presentation cannot distinguish withdrawn or superseded versions.

Rollback must be idempotent, preserve the private authority, and record the
reason and actor. R2 is explicitly out of scope for this first slice.
