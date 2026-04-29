# Post-E1 Follow-Up Slice: Language Club Discord Scheduled Event Creation

## Objective

Add native Discord Scheduled Event creation to the already-bounded seeded Language Club flow after per-event channel/host selection exists.

The slice keeps one routine path only:

- `/event create-language-club`
- `template_key = language_club_default`, `template_version = 1`
- `event_type = language_club`
- `approval_class = routine_auto_publish`
- one configured guild

SQLite remains the workflow source of truth. `events.discord_scheduled_event_id` is stored only as the external Discord projection/ID, not as the workflow authority.

## Why now

- the channel/host-selection slice already gives each Language Club event a resolved voice/stage channel, which is the missing prerequisite for native Discord Scheduled Event creation
- this is the next smallest visible improvement after announcement publish without widening into reminders, media, attendance, or edit tooling
- it narrows the earlier combined plan into a safer sequence: select the venue first, then add Scheduled Event creation on top of the same seeded path

## In scope

- keep the existing post-channel-selection `/event create-language-club` command path
- keep the same single-guild, staff-authorized, routine Language Club policy path
- keep existing per-event `host_voice_channel` resolution behavior from the prior slice
- create exactly one Discord Scheduled Event for the resolved `events.host_voice_channel_id`
- build the Scheduled Event from the stored event row values:
  - title
  - description
  - scheduled start/end
  - selected voice/stage channel
- persist the returned Scheduled Event ID in `events.discord_scheduled_event_id`
- continue publishing the normal in-server announcement only after Scheduled Event creation succeeds
- return ephemeral success with:
  - `event_id`
  - `discord_scheduled_event_id`
  - `discord_announcement_message_id`

## Out of scope

- any new event type, template, approval path, or guild expansion
- edit, reschedule, cancel, delete, retry, reconciliation, or backfill flows
- reminders, reminder sync, attendance, wrap-up, analytics, content queue, or external calendar sync
- posters, banners, cover images, media upload, or Scheduled Event artwork
- changes to the already-approved channel/host snapshot model beyond reading it
- any Discord read-back sync loop where Discord becomes the workflow source of truth

## Schema/runtime changes

### Schema

- no new table is required for this slice
- reuse `events.discord_scheduled_event_id` as nullable `TEXT` external ID storage
- keep `events.host_voice_channel_id` and channel-scoped `scheduling_scope_key` from the prior slice
- keep `event_state_transitions` and the existing narrow event state machine unchanged
- if the active branch does not yet carry `discord_scheduled_event_id`, add that nullable column; otherwise no schema migration is needed for this slice

### Runtime

- extend the Discord-facing publisher/provider boundary with a bounded `createScheduledEvent(...)` operation
- create the Scheduled Event from persisted SQLite event data, not from raw command input
- write `discord_scheduled_event_id` back to SQLite immediately after Discord success and before announcement publish
- keep SQLite as the only place that decides whether the event is `drafted`, `published`, or `publish_failed`

## Command/runtime behavior

### Command surface

- no new slash command is introduced
- no new required command inputs are introduced
- existing per-event channel and host inputs remain as defined by the prior slice
- success response adds the stored `discord_scheduled_event_id`

### Runtime flow

1. Validate the same bounded routine Language Club path as the prior slice.
2. Resolve the final host voice/stage channel using the already-supported per-event selection behavior.
3. Reject duplicates using the existing unique slot key:
   - `guild_id + event_type + scheduling_scope_key + scheduled_start_at`
4. Persist the `events` row in `drafted` plus any prior-slice host snapshot rows before external side effects.
5. Create one Discord Scheduled Event using the persisted event title, description, start/end, and resolved host voice/stage channel.
6. On success, update `events.discord_scheduled_event_id`.
7. Publish the normal announcement message to the configured announcement channel.
8. On full success, mark the event `published` and write the transition row.
9. On post-persistence failure, mark the event `publish_failed`, store the exact failure, and stop.

## Idempotency and partial-failure rules

- persist first, then call Discord
- the existing unique scheduling-slot constraint remains the main duplicate guard
- existing `drafted`, `published`, or `publish_failed` rows for the same slot all block a second create attempt in this slice
- never create a second Discord Scheduled Event for a row that already has a non-null `discord_scheduled_event_id`
- if Scheduled Event creation fails before Discord returns an ID:
  - keep the row
  - set `state = publish_failed`
  - keep `discord_scheduled_event_id = NULL`
  - do not send the announcement message
- if Scheduled Event creation succeeds but the SQLite write of `discord_scheduled_event_id` fails:
  - do not send the announcement message
  - return failure
  - require manual reconciliation/cleanup; no automatic delete flow exists in this slice
- if Scheduled Event creation succeeds and the ID is stored, but announcement publish fails:
  - keep the stored `discord_scheduled_event_id`
  - set `state = publish_failed`
  - keep `discord_announcement_message_id = NULL`
  - do not attempt Scheduled Event deletion automatically
- no retry command, repair command, or Discord-to-SQLite reconciliation job is included here

## Acceptance criteria

- a valid create request on the supported seeded Language Club path creates exactly one Discord Scheduled Event and stores its ID in `events.discord_scheduled_event_id`
- the created Scheduled Event uses the already-resolved per-event voice/stage channel from `events.host_voice_channel_id`
- successful end-to-end execution still publishes exactly one announcement message and stores `discord_announcement_message_id`
- full success records `null -> drafted -> published`
- post-persistence failure records `null -> drafted -> publish_failed`
- Scheduled Event creation failure prevents announcement publish
- unsupported or invalid requests create no event row and no Discord Scheduled Event
- no edit/reschedule/cancel/delete, reminder, media, attendance, analytics, or external sync behavior is introduced

## Validation

### Automated

- service test: successful create persists `discord_scheduled_event_id`, then publishes announcement, then marks `published`
- service test: Scheduled Event creation failure yields `publish_failed`, no scheduled-event ID, and no announcement send
- service test: Scheduled Event success followed by announcement failure yields `publish_failed` with retained `discord_scheduled_event_id`
- service test: duplicate create for the same scheduling slot is rejected without a second Discord Scheduled Event call
- adapter/runtime test: selected voice/stage channel ID is the one passed to Discord Scheduled Event creation

### Manual/live

- run `/event create-language-club` with a selected Language Club voice/stage channel and confirm a native Discord Scheduled Event appears in the server events UI
- confirm the stored SQLite row contains the returned `discord_scheduled_event_id`
- confirm the announcement still lands exactly once in the configured announcement channel
- confirm the Scheduled Event is bound to the selected per-event channel, not a stale guild default

## Risks

- Discord side effects after draft persistence can still leave manual cleanup work when later steps fail
- Scheduled Event API permissions and channel eligibility may fail even when normal announcement publish permissions are valid
- without edit/reschedule/cancel tooling, incorrect Scheduled Event details require manual operator cleanup in Discord
- this slice intentionally keeps one guild and one routine path, so future widening will need explicit policy and reconciliation design
