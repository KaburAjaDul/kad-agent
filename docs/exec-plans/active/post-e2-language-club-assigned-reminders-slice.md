# Post-E1.6 Event Slice E2: Assigned Language Club Reminders

## Decision

Club assignment belongs inside E2 as the first implementation phase, not as a separately shipped E1.7 prerequisite.

Do not ship generic Language Club reminders first. Reminder rows and reminder copy must be created only for events that carry an explicit Language Club assignment in SQLite.

If the build needs smaller review commits, split internally as:

1. E2a: club registry and create-time event assignment.
2. E2b: reminder schedule creation and reminder delivery.

These are one product slice because reminder behavior is not correct until it is club-aware.

## Objective

Make routine Language Club reminders deterministic and club-aware after the committed E1/E1.5/E1.6 foundation.

Staff must assign each `/event create-language-club` event to a specific configured club/session. SQLite remains the source of truth for the assigned club, selected host voice/stage channel, host snapshots, reminder schedule, delivery state, and Discord message IDs.

## In scope

- one configured guild only
- routine Language Club only:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility classification `routine_language_club`
- a minimal `language_clubs` registry for assignable club/session identities
- required club assignment on `/event create-language-club`
- preserve per-event `host_voice_channel` and host snapshots from E1.5/E1.6
- create exactly two reminder rows after a supported assigned Language Club event is published:
  - `t_minus_24h`
  - `t_minus_1h`
- deliver due reminder rows to the existing configured announcement channel
- reminder copy must include the assigned club display name and selected voice/stage channel
- idempotent schedule creation and due-job delivery

## Schema changes

### `language_clubs`

Add a narrow one-guild club/session registry:

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `club_key` TEXT NOT NULL
- `display_name` TEXT NOT NULL
- `default_host_voice_channel_id` TEXT NOT NULL
- `state` TEXT NOT NULL, initially only `active`
- `created_by_discord_user_id` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_by_discord_user_id` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- `UNIQUE (guild_id, club_key)`

### `events`

Add club assignment fields:

- `language_club_id` TEXT NULL REFERENCES `language_clubs`(`id`)
- `language_club_key` TEXT NULL
- `language_club_display_name` TEXT NULL

New E2 Language Club rows must set all three fields before any Discord side effect.

Keep `events.host_voice_channel_id` as the selected per-event voice/stage venue. Keep `scheduling_scope_key = language_club_channel:<host_voice_channel_id>` for venue collision compatibility, and add a separate service/database guard for same-club same-start duplicates.

Recommended index:

- unique on `(guild_id, event_type, language_club_key, scheduled_start_at)` where `event_type = 'language_club'` and `language_club_key IS NOT NULL`

### `event_reminders`

The existing foundation `event_reminders` shape is not the E2 delivery contract. Migrate it to the E2 shape by renaming the old table to a legacy foundation table, then creating the delivery table below.

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL REFERENCES `events`(`id`)
- `guild_id` TEXT NOT NULL
- `language_club_key` TEXT NOT NULL
- `reminder_key` TEXT NOT NULL
- `target_channel_id` TEXT NOT NULL
- `state` TEXT NOT NULL
- `scheduled_send_at` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `sent_at` TEXT NULL
- `send_failed_at` TEXT NULL
- `send_error` TEXT NULL
- `discord_message_id` TEXT NULL
- `UNIQUE (event_id, reminder_key)`

Indexes:

- `(state, scheduled_send_at)` for due sweeps
- `(guild_id, language_club_key, scheduled_send_at)` for future ops/reporting

Allowed states in this slice:

- `scheduled`
- `sent`
- `send_failed`

## Command and setup changes

### `/setup language-club-upsert`

Admin-only setup command for the configured guild.

Inputs:

- `club_key` string, normalized to a lowercase slug
- `display_name` string
- `default_host_voice_channel` voice/stage channel in the same guild

Behavior:

- creates or updates one active `language_clubs` row
- rejects invalid slugs and wrong-guild/non-voice channels
- does not publish or schedule anything

### `/setup language-club-list`

Admin-only, ephemeral list of configured active clubs for the guild.

### `/event create-language-club`

Add required input:

- `club_key` string

Keep existing inputs:

- `date`
- `time`
- optional `host_voice_channel`
- optional `host_1`, `host_2`, `host_3`

Behavior:

- resolve `club_key` from `language_clubs` for the current guild before persistence
- reject unknown/inactive club keys before persistence
- if `host_voice_channel` is omitted, use `language_clubs.default_host_voice_channel_id`
- if `host_voice_channel` is provided, persist the override while preserving the assigned club identity
- reject duplicate selected hosts before persistence
- reject same-club same-start duplicates before Discord side effects
- continue rejecting same-channel same-start duplicates through the existing channel-scoped scheduling key

## Service/runtime changes

- add a language-club registry repo/service for setup and lookup
- extend `createLanguageClubEvent` input/result and persistence with assigned club fields
- schedule reminders only after an assigned routine Language Club event reaches `published`
- reminder creation must be idempotent: one row per `event_id + reminder_key`
- skip a reminder row if its computed `scheduled_send_at` is already in the past when rows are created
- extend the background reminder sweep from discovery-only to delivery-capable
- inject a Discord reminder publisher into the job runner/runtime rather than letting service code import Discord APIs directly
- record one `job_runs` row per sweep with count/success/failure summary

## Reminder copy constraints

Reminder copy must be deterministic and not LLM-generated.

It may include:

- assigned club display name
- event start time in the event timezone
- selected voice/stage channel mention
- native Discord Scheduled Event reference if already stored and easy to format

It must not include:

- coverage or conversation-partner language
- attendance/analytics claims
- approval language
- migration or education guidance
- DMs or external links beyond normal Discord event/channel mentions

## Acceptance criteria

- admin can upsert and list active Language Club identities for the configured guild
- `/event create-language-club` requires a valid `club_key`
- unknown or inactive `club_key` is rejected before any event row or Discord side effect
- successful create persists `language_club_id`, `language_club_key`, and `language_club_display_name` on `events`
- if no per-event host channel override is supplied, the event uses the selected club default host voice/stage channel
- duplicate same-club same-start create attempts are rejected
- duplicate same-channel same-start create attempts remain rejected
- after successful publish of an assigned routine Language Club, exactly two future `event_reminders` rows are created when both offsets are still future
- no reminder rows are created for unassigned legacy events, unpublished events, `publish_failed` events, unsupported event types, or approval-required events
- due reminder sweep sends exactly one Discord message per due scheduled row and stores `discord_message_id`
- successful send transitions `scheduled -> sent`
- failed send transitions `scheduled -> send_failed` and stores `send_error`
- repeated sweeps over `sent` or `send_failed` rows do not send duplicate messages
- reminder messages name the assigned club and selected channel
- all workflow truth remains in SQLite; Discord Scheduled Events are not treated as source of truth

## Out of scope

- approval workflow
- analytics, attendance, closeout, wrap-up, or reports
- media/posters/banner upload
- Regional Sharing or Cerita Aja Dulu
- event edit, reschedule, cancel, delete, retry UI, or reconciliation
- editing Discord Scheduled Events after creation
- reminder DMs, role-DM fanout, or volunteer/private nudges
- coverage assignment, conversation partner assignment, or shortage nudges
- public migration or education guidance
- Google Calendar, Google Sheets, CSV export, or any external sync
- multi-guild generalized configuration
- self-serve member signup or club discovery UX

## First build order

1. Add migrations and repository tests for `language_clubs`, event club assignment fields, and E2 `event_reminders`.
2. Add setup service/commands for club upsert/list.
3. Update `/event create-language-club` service/command to require and persist `club_key`.
4. Add idempotent reminder scheduling after publish.
5. Upgrade reminder sweep to send due reminders through an injected Discord publisher.
6. Add service/runtime tests and run one live validation with two configured clubs in different voice/stage channels.
