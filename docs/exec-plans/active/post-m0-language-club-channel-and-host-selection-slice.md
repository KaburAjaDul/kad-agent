# Post-M0 Event Slice E1.5: Language Club Per-Event Channel Selection And Host Snapshot

## Objective

Keep the current seeded Language Club create-and-publish path, but let each event choose its own voice/stage channel and store one-or-more event hosts without introducing full staffing workflows yet.

## Current E1 reality

Current E1 can support:

- one seeded `language_club_default@v1` create-and-publish path
- one guild-level announcement channel
- one guild-level default timezone
- one guild-level allowed staff role set
- one guild-level host voice/stage channel copied onto every created event

Current E1 cannot support:

- per-event voice/stage channel selection
- multiple candidate voice channels across languages
- multiple simultaneous host users on an event
- any persisted host roster beyond `created_by_discord_user_id`
- any language-aware scheduling scope beyond the single fixed `language_club_default`

## Is the current live smoke still useful?

Yes, but only as an infrastructure smoke for:

- Discord command registration
- SQLite-backed guild config
- staff authorization
- event persistence
- announcement publish

It is not a product-fit validation for real Language Club operations because it still assumes one default host channel and no event host roster.

## Smallest safe next slice

### In scope

- keep guild-level setup for:
  - announcement channel
  - timezone
  - allowed staff roles
- keep the existing stored guild-level `host_voice_channel_id` only as an optional default/fallback during transition
- extend `/event create-language-club` with:
  - optional `host_voice_channel` override (voice/stage channel in the same guild)
  - optional `host_1`
  - optional `host_2`
  - optional `host_3`
- persist the selected channel on the `events.host_voice_channel_id` field
- add a narrow `event_hosts` snapshot table for create-time host storage only
- build announcement copy from the selected channel and optional host mentions
- change Language Club duplicate scope from fixed `language_club_default` to a selected-channel scope such as `language_club_channel:<host_voice_channel_id>`

### Why this is the smallest safe cut

- it solves the real blocker at create time
- it does not require language taxonomy yet
- it does not require coverage states, assignment history, or nudge jobs
- it preserves the existing announcement channel, timezone, and staff auth model
- it keeps the current live smoke path usable during rollout

## Explicit non-goals

- no language registry or language-to-channel taxonomy yet
- no host eligibility policy beyond normal guild/user validation yet
- no host reminder or staffing nudge logic
- no volunteer self-serve flows
- no generic multi-role staffing model in this slice

## Recommended schema direction

### `events`

- continue using `host_voice_channel_id`
- stop treating it as guild-derived only; it becomes the per-event selected venue
- derive `scheduling_scope_key` from the selected channel for new Language Club rows

### `event_hosts`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `discord_user_id` TEXT NOT NULL
- `display_order` INTEGER NOT NULL
- `assigned_by_discord_user_id` TEXT NOT NULL
- `assigned_at` TEXT NOT NULL
- UNIQUE (`event_id`, `discord_user_id`)

This table is intentionally a simple snapshot, not the full assignment-history model from the later coverage slice.

## Merge guidance with the coverage-and-nudges slice

Do not merge the whole change into E4.

Recommended approach:

- ship per-event channel selection now as an E1.5 adjustment
- ship host snapshot storage now only if the published announcement needs host names immediately
- keep E4 focused on internal staffing state and nudges

Reuse should happen at the model boundary, not at the slice boundary:

- E4 may later absorb or migrate `event_hosts` into a broader assignment model
- E1.5 should not pull in `event_roles`, `required_count`, open/filled state, or nudge scheduling just to store hosts
