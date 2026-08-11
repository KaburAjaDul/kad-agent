# Post-E1 Next Slice: Language Club Per-Event Channel/Host Selection With Discord Scheduled Event Creation

## Objective

Extend the live E1 seeded Language Club flow so staff can pick the actual voice/stage channel and host roster for each event, and have the same command create the native Discord Scheduled Event before announcing it.

This is the smallest safe combined slice after live E1 because it solves the real operational gap without widening into reminders, analytics, posters, edit flows, or a generic venue model.

## Exact in-scope behavior

- keep one supported event path only:
  - `/event create-language-club`
  - seeded `language_club_default@v1`
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
- allow per-event host channel selection at create time:
  - optional `host_voice_channel` override on the command
  - if omitted, fall back to the configured guild default `language_club_guild_config.host_voice_channel_id`
  - selected channel must be a voice or stage channel in the same guild
- allow narrow per-event host snapshot selection at create time:
  - optional `host_1`
  - optional `host_2`
  - optional `host_3`
  - duplicate host users are rejected before persistence
- persist the selected channel on `events.host_voice_channel_id`
- persist selected hosts in a narrow `event_hosts` snapshot table
- derive `scheduling_scope_key` from the selected channel as `language_club_channel:<host_voice_channel_id>`
- after draft persistence, create one native Discord Scheduled Event bound to the selected voice/stage channel
- after Scheduled Event creation succeeds, publish one announcement message to the configured announcement channel
- include the selected channel mention and optional host mentions in the announcement copy
- return ephemeral success with `event_id`, `discord_scheduled_event_id`, and `discord_announcement_message_id`

## Explicit out-of-scope behavior

- no posters, banners, cover images, or media upload for the Scheduled Event
- no reminders, reminder sync, reminder jobs, or reminder edits
- no attendance, closeout, wrap-up, analytics, or content queue work
- no edit, reschedule, cancel, retry, delete, or reconciliation flows
- no generic venue system beyond the existing Language Club `host_voice_channel_id`
- no language registry, no language taxonomy, and no channel-to-language admin UI
- no host eligibility policy beyond same-guild validation and duplicate prevention
- no multi-template or non-routine event expansion

## Schema additions and changes

### `events`

- keep existing columns
- keep using `host_voice_channel_id` as the per-event selected voice/stage venue
- keep using existing placeholder `discord_scheduled_event_id` as the stored native Discord event reference
- change create-time meaning of `scheduling_scope_key` for Language Club from fixed `language_club_default` to `language_club_channel:<host_voice_channel_id>`
- add a data migration for existing Language Club rows so legacy `language_club_default` records with a non-null `host_voice_channel_id` are rewritten to the channel-scoped key

### `event_hosts`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `discord_user_id` TEXT NOT NULL
- `display_order` INTEGER NOT NULL
- `assigned_by_discord_user_id` TEXT NOT NULL
- `assigned_at` TEXT NOT NULL
- `FOREIGN KEY (event_id) REFERENCES events(id)`
- `UNIQUE (event_id, discord_user_id)`
- index on `event_id`

This table is snapshot-only for create time, not a full staffing history model.

### `language_club_guild_config`

- no schema change
- clarify `host_voice_channel_id` semantics as the default fallback channel for new Language Club events

## Command surface changes

### `/event create-language-club`

Keep existing required inputs:

- `date`
- `time`

Add bounded optional inputs:

- `host_voice_channel` — voice/stage channel override for this event
- `host_1` — first host user
- `host_2` — second host user
- `host_3` — third host user

Behavior:

- command remains guild-only and staff-authorized by current E1 config
- if `host_voice_channel` is omitted, use the configured default host channel
- if any selected host is duplicated, reject before persistence
- if any selected host cannot be resolved to the current guild, reject before persistence

### `/setup e1-configure` and `/setup e1-show`

- no functional change
- update descriptions/text to call `host_voice_channel` the default Language Club host channel

## Publish/runtime flow

1. Validate guild context, staff authorization, seeded template compatibility, date/time, selected channel, and selected hosts.
2. Resolve final host channel:
   - command override if provided
   - otherwise guild default config
3. Derive `scheduling_scope_key = language_club_channel:<resolved_host_voice_channel_id>`.
4. Reject duplicates on `guild_id + event_type + scheduling_scope_key + scheduled_start_at` before persistence.
5. Insert `events` row in `drafted` and insert `event_hosts` snapshot rows in the same transaction.
6. Call Discord to create the native Scheduled Event using:
   - guild ID from the interaction
   - selected voice/stage channel ID
   - event title/description
   - scheduled start/end
7. If Scheduled Event creation succeeds, write `discord_scheduled_event_id` to SQLite.
8. Publish one announcement message to the configured announcement channel.
9. On full success, mark event `published` and write the normal state transition.
10. On external failure after draft persistence, mark event `publish_failed` and store the exact failure reason.

Recommended runtime boundary:

- extend the Discord publisher abstraction to support both:
  - `createScheduledEvent(...)`
  - `publishAnnouncement(...)`

## SQLite source-of-truth rules

- SQLite remains the workflow source of truth for the event row, selected channel, selected host snapshot, state, and external IDs.
- Persist the draft before any Discord side effect.
- `discord_scheduled_event_id` is written only after Discord confirms Scheduled Event creation.
- `discord_announcement_message_id` is written only after Discord confirms the announcement message send.
- Do not treat the Discord Scheduled Event as source of truth for event state.
- No direct read-back from Discord should be required to consider the event published.
- Existing state machine stays narrow:
  - `hard_rejected` as non-persisted result
  - `drafted`
  - `published`
  - `publish_failed`

## Failure behavior

### Hard reject before persistence

- missing guild context
- missing guild setup
- unauthorized actor
- invalid date/time
- unsupported seeded template or policy mismatch
- invalid selected channel type or wrong-guild channel
- duplicate selected hosts
- unresolved/non-guild host user
- duplicate event for the same channel-scoped slot

### Persist then fail

- if Scheduled Event creation fails:
  - keep the event row
  - set state to `publish_failed`
  - keep `discord_scheduled_event_id = NULL`
  - do not send the announcement message
- if Scheduled Event creation succeeds but announcement publish fails:
  - keep the event row
  - keep `discord_scheduled_event_id`
  - set state to `publish_failed`
  - keep `discord_announcement_message_id = NULL`
  - require manual cleanup; no automatic Scheduled Event deletion in this slice

## Acceptance criteria

- `/event create-language-club` accepts optional per-event `host_voice_channel` and up to three optional host users.
- success persists the resolved host channel on `events.host_voice_channel_id`.
- success persists selected hosts in `event_hosts` with stable ordering.
- new Language Club rows store `scheduling_scope_key = language_club_channel:<host_voice_channel_id>`.
- existing live E1 rows are migrated away from the fixed `language_club_default` key when a host channel is present.
- successful run creates exactly one native Discord Scheduled Event and stores its ID in `events.discord_scheduled_event_id`.
- successful run publishes exactly one announcement message and stores its ID in `events.discord_announcement_message_id`.
- duplicate checks are channel-scoped, so the same start time can exist in different host channels but not twice in the same host channel.
- `event_state_transitions` still records `null -> drafted -> published` on full success and `null -> drafted -> publish_failed` on post-persistence failure.
- no reminders, posters, analytics, edit flows, or generic venue abstractions are introduced.

## Validation plan

### Automated

- migration test for `event_hosts` creation and legacy Language Club `scheduling_scope_key` rewrite
- service test: command override channel persists and changes duplicate scope
- service test: fallback to configured default host channel still works
- service test: duplicate host users are rejected before persistence
- service test: host snapshot rows are written in display order
- service test: Scheduled Event success + announcement success -> `published` with both Discord IDs
- service test: Scheduled Event failure -> `publish_failed`, no announcement send, no scheduled event ID
- service test: Scheduled Event success + announcement failure -> `publish_failed`, scheduled event ID retained

### Manual/live

- run `/event create-language-club` for one language/host channel and confirm the native Discord Scheduled Event appears in the server event UI
- confirm the created Scheduled Event is attached to the selected voice/stage channel, not always the guild default
- confirm the announcement lands once in the configured announcement channel and mentions the selected channel and hosts
- run a second event at the same time in a different Language Club channel and confirm it is allowed
- run a second event at the same time in the same Language Club channel and confirm it is rejected

## Recommended first build cut

Implement this as one bounded build slice in this order:

1. migration for `event_hosts` plus legacy scheduling-scope rewrite
2. repo/service support for resolved host channel and host snapshots
3. command option expansion
4. Discord runtime publisher support for native Scheduled Event creation
5. tests and one live validation pass

This supersedes the narrower standalone channel/host-selection-only plan because the user now explicitly wants the native Discord Scheduled Event in the same next slice.
