# 1. Title

Post-M0 Event Slice E2: Language Club Reminders

## 2. Why this slice

This is the next smallest useful event-operations slice after seeded Language Club create-and-publish because it reduces missed coordination without widening event types or approval logic.

It proves scheduled background work against already-published events while keeping blast radius low:

- one routine event type
- one configured guild
- one configured in-server announcement channel
- fixed reminder cadence
- SQLite reminder rows before any reminder send attempt

## 3. User-facing value

Staff no longer need to manually post the standard reminder messages for seeded Language Club events.

Published events gain:

- a stored reminder schedule in SQLite
- deterministic reminder delivery in Discord
- stable reminder IDs and message IDs for later ops reporting and follow-up slices

## 4. In scope

- auto-create reminder rows only after a supported Language Club event reaches `published`
- only one supported policy path:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility fallback: `classification = routine_language_club`
- fixed reminder keys `t_minus_24h` and `t_minus_1h`
- one reminder target: the same in-server announcement channel already used for the original publish
- one background job path to deliver due reminder rows
- reminder state persistence before and after each send attempt
- exact no-op behavior when a due reminder row is already terminal

## 5. Out of scope

- coverage assignment or conversation partner nudges
- DMs or role mentions outside the configured announcement copy
- approval workflow
- Regional Sharing or Cerita Aja Dulu reminders
- event edit, reschedule, cancel, retry UI, or delete flows
- Discord Scheduled Event reminders
- Google Calendar, Google Sheets, or any external sync execution
- attendance capture, closeout, analytics, or content queue generation

## 6. Dependencies

- `docs/exec-plans/active/post-m0-seeded-language-club-publish-slice.md`
- Milestone 0 job runner foundation
- seeded `language_club_default@v1` template and its configured guild/channel/timezone settings
- existing `events` and `event_state_transitions` tables from slice E1

## 7. State machine with allowed transitions

### Non-persisted result

- `skipped` — service intentionally does nothing and writes no new reminder state

Skip reasons in this slice:

- event is not a supported published Language Club event
- reminder key already exists for that event
- reminder row is already in a terminal state
- scheduled send time is already in the past at schedule-creation time

### Persisted states

- `scheduled`
- `sent`
- `send_failed`

### Allowed transitions

- `null -> scheduled`
- `scheduled -> sent`
- `scheduled -> send_failed`

### Rules

- reminder rows are created only from an already-published event
- one reminder row exists per `event_id + reminder_key`
- `sent` and `send_failed` are terminal in this slice
- repeated due-job execution must not create a second Discord reminder message for the same row

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `event_reminders`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `guild_id` TEXT NOT NULL
- `reminder_key` TEXT NOT NULL
- `target_channel_id` TEXT NOT NULL
- `state` TEXT NOT NULL
- `scheduled_send_at` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `sent_at` TEXT NULL
- `send_failed_at` TEXT NULL
- `send_error` TEXT NULL
- `discord_message_id` TEXT NULL
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
- UNIQUE (`event_id`, `reminder_key`)

Required reminder keys in this slice:

- `t_minus_24h`
- `t_minus_1h`

### Existing `job_runs` contract assumed from Milestone 0

The job runner should already support a durable record for:

- `job_key`
- `job_type`
- `status`
- `started_at`
- `finished_at`
- `error`

This slice should reuse that foundation rather than inventing ad-hoc reminder-only execution state.

## 9. Discord command/interaction surface

No new slash command is required in this slice.

Operator trigger:

- successful `/event create-language-club` publish flow from slice E1

Runtime trigger:

- background reminder job scans for due `event_reminders.state = scheduled`

Behavior:

- Discord adapter stays dumb and passes persisted event/reminder data to the service
- service decides whether reminder rows should be created and whether a due row may send
- reminder delivery posts one message to the configured in-server announcement channel
- there are no reminder edit, delete, or resend commands in this slice

## 10. Approval and publication boundaries

- no approval state is added or simulated in this slice
- reminder delivery is allowed only for already-published routine Language Club events
- reminder publication means one additional in-server announcement-channel message only
- no DMs, public-web publishing, social publishing, or external sync is allowed
- unsupported event types or approval-required events get no reminder rows

## 11. Acceptance criteria

- when a supported Language Club event becomes `published`, exactly two `event_reminders` rows are created
- rows are not created for `drafted`, `publish_failed`, or unsupported event types
- due-job execution sends exactly one reminder message per due row and stores `discord_message_id`
- successful send updates reminder state to `sent`
- failed send updates reminder state to `send_failed` and stores `send_error`
- duplicate reminder creation attempts do not create duplicate rows
- duplicate due-job execution against an already `sent` row produces no second Discord message
- reminder copy does not mention coverage, attendance, or approval language

## 12. Validation checklist

- verify reminders are created only after event state is `published`
- verify `t_minus_24h` and `t_minus_1h` rows have the expected UTC send times
- verify duplicate schedule-creation logic respects the unique constraint
- verify a due reminder sends exactly one message to the configured announcement channel
- verify `sent` rows store `sent_at` and `discord_message_id`
- verify `send_failed` rows store `send_failed_at` and `send_error`
- verify no reminder rows are created for non-Language Club or approval-required events
- verify reminder jobs do not touch attendance, coverage, or analytics state

## 13. Required configuration to lock before implementation

- reminder offsets for this slice:
  - `t_minus_24h = 24 hours before scheduled_start_at`
  - `t_minus_1h = 1 hour before scheduled_start_at`
- final Bahasa Indonesia wording for each reminder message
- job runner poll interval and due-window tolerance
- whether reminder rows should be skipped instead of backfilled when a newly published event is already inside an offset window
- reuse of the slice E1 guild, staff auth, announcement channel, and timezone config

## 14. Risks and follow-up slice

### Risks

- fixed offsets are easy to reason about but inflexible
- `send_failed` requires manual follow-up because retry tooling is still out of scope
- publishing an event very close to start time may skip or compress reminder behavior unless rules are locked clearly

### Follow-up slice

Add structured Language Club coverage records and internal nudges that reuse the same job foundation without relying on ad-hoc Discord-only state.
