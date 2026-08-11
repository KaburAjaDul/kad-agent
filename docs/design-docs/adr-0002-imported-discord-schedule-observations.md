# ADR-0002: Imported Discord schedule observations

- Status: accepted for the staging vertical slice
- Date: 2026-08-11
- Owners: KAD Staging environment maintainers

## Decision

Current Discord Scheduled Events are a transitional observation source. The
sync job fetches the one explicitly configured `KaburAjaDulu` guild, allows only
known public Language Club event families, removes descriptions and personal
attribution, derives opaque public IDs, and sends a signed versioned Agenda
snapshot to Kaddy's staging publication endpoint.

The bot is pinned to `DISCORD_TARGET_GUILD_ID` (a Staging secret) and checks
the configured `DISCORD_TARGET_GUILD_NAME` as a display assertion. Unknown
scheduled titles are rejected without logging the title; only the count is
reported to the workflow.

The website consumes the signed snapshot, not Discord directly. The snapshot is
a full replacement: `entries` is the complete approved set and `tombstones` is
reserved for future incremental consumers. Completed, canceled, and disappeared
source events are absent, so the Worker withdraws prior rows. An empty approved
set is a valid signed snapshot when Discord returns no active/scheduled events;
an unknown event rejects the complete snapshot so an unsafe title cannot
silently disappear into publication. The last known good snapshot remains live.

The exact request body is recursively key-sorted canonical JSON. The Ed25519
signature bytes are `v1\nissuedAt\nexpiresAt\nnonce\ncontentSha256\nbody`,
where the digest is base64url SHA-256 over those exact body bytes. The same body
is sent on every retry; headers include `x-kad-expires-at` and
`x-kad-content-sha256` in addition to the schema, key, issue time, nonce, and
signature headers.

Future Kaddy-created sessions continue to use SQLite as the operational
authority. Discord is then an effect/delivery surface, while the same signed
publication contract remains the public boundary.

## Privacy and safety boundary

The public contract contains only a normalized title, generated summary,
schedule, program/series labels, the fixed public invite, and a source marker.
It contains no Discord snowflakes, raw event URLs, mentions, descriptions,
hosts, handles, or user counts. The private bot token and Ed25519 signing key
are GitHub `Staging` environment secrets and are never logged. Publication is
blocked unless `PUBLICATION_APPROVED=true`.

## Correction and withdrawal

The sync runs every 15 minutes and can also be dispatched manually. A verified
privacy or safety report is corrected or withdrawn by changing the source event
or disabling publication, then running the manual sync; the service-level target
is one scheduled sync (15 minutes). Unknown titles and schema violations fail
closed and leave the last known good website snapshot intact.

## Rejected alternatives

- Direct website Discord API calls: rejected because they expose credentials and
  make privacy filtering a client concern.
- Publishing raw Discord event payloads: rejected because descriptions and
  facilitator identities are not consented publication fields.
- Silently skipping unknown events: rejected because omission can conceal an
  unsafe or misclassified source event.
