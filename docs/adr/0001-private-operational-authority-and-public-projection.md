# ADR 0001: Private Operational Authority And Public Projection

- Status: accepted for M0 planning
- Date: 2026-08-11
- Scope: KAD event records and the first website publication path

## Decision

SQLite is the private operational authority for Programs, Series, Sessions,
Standalone Gatherings, Run-of-Show Items, approvals, identities, publication
attempts, and corrections. Discord is an external effect and interaction
surface, not the authority. D1 is a deliberately limited public read model.
The website presents only data that has crossed the public publication boundary.

The first public allowlist contains only Language Club Agenda Entries. No other
Program, Series, Session, Standalone Gathering, or public listing may reach the
public read model until a later decision widens the allowlist.

## Boundary rules

- Operational approval and publication approval are separate decisions with
  separate owners and audit records. Public identity additionally requires
  consent owned by the represented person and independently verified scope and
  evidence.
- A missing, ambiguous, stale, or unassigned owner fails closed; it does not
  fall back to the requester or an inferred identity.
- Discord success never implies publication success. External IDs and results
  are recorded as effects and reconciled against the private authority.
- Public records are projections, not a second editable source of truth.
- R2 is not part of the first slice.

## Public field policy

The public projection may contain only the approved Agenda Entry title,
short description, scheduled time, timezone, public venue label, and safe
Program/Series labels. It must exclude internal notes, staff or volunteer
assignments, member identifiers, private contact details, moderation data,
approval rationale, identity evidence, raw Discord payloads, and secrets.

## Consequences

This adds an explicit projection and reconciliation boundary, but prevents
Discord or a website cache from silently becoming operational truth. Rollback
can stop publication, withdraw a projection, or correct a projection without
rewriting the private record. Later public surfaces require an allowlist change,
field review, owner assignment, and a new acceptance gate.

See [the public publication boundary](../design-docs/public-publication-boundary.md),
[the threat model](../design-docs/kaddy-threat-model.md), and
[the active execution plan](../exec-plans/active/kaddy-e2e-foundation.md).
