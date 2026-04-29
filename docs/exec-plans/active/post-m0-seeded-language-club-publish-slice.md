# 1. Title

Post-M0 Event Slice E1: Seeded Language Club Create And Publish

## 2. Why this first slice

This is the smallest useful event-operations foundation after Milestone 0 because it proves one end-to-end path with the lowest safe blast radius:

- one staff-only Discord command
- one seeded template: `template_key = language_club_default`, `template_version = 1`
- one supported durable policy path:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility mirror: `classification = routine_language_club`
- one configured guild
- one configured in-server announcement channel
- SQLite persistence before publish

It is the safest first slice because unsupported and non-routine requests are hard-rejected, there is no fake approval state, and publication is limited to one in-server announcement post.

## 3. User-facing value

Authorized staff can create and publish one routine Language Club announcement from Discord with a single command and get:

- a stored event record in SQLite
- a clear success or failure response
- a stable event ID for later reminders, attendance, analytics, and integrations

## 4. In scope

- one staff-only slash command: `/event create-language-club`
- command usable only in one configured Discord guild
- service accepts only the seeded template `language_club_default@v1`
- service accepts only the supported routine Language Club policy path:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility mirror written as `classification = routine_language_club`
- service writes a fixed `scheduling_scope_key = language_club_default` for every supported Language Club event in this slice
- service derives title and description from the seeded template plus scheduled start time
- service persists the event in SQLite before any Discord publish attempt
- successful publish posts exactly one announcement message to one configured in-server announcement channel
- event lifecycle is recorded with stable IDs and transition rows
- event row stores stable fields needed for later staff-only analytics and future integrations, including guild/channel/template/external-reference fields
- ephemeral Discord response returns either success details or an exact rejection reason

## 5. Out of scope

- approval workflow, approval review UI, or any approval-like persisted state
- Cerita Aja Dulu, Regional Sharing, custom events, or non-routine Language Club variants
- volunteer coverage or conversation partner coverage
- reminders, attendance capture, wrap-up summaries, analytics outputs, or content queue generation
- event edit, reschedule, cancel, retry, or delete flows
- Discord Scheduled Event creation
- Google Calendar, Google Sheets, or any external sync execution
- multi-guild, multi-template, multi-channel, or public-web publishing support

## 6. State machine with allowed transitions

### Non-persisted result

- `hard_rejected` — request is rejected before any `events` row is created

Hard rejection reasons in this slice:

- wrong guild
- actor fails configured staff authorization rule
- template is not `language_club_default@v1`
- event type or approval class does not match the supported routine Language Club path
- schedule input is invalid
- duplicate event exists for the same `guild_id + event_type + scheduling_scope_key + scheduled_start_at`

### Persisted states

- `drafted`
- `published`
- `publish_failed`

### Allowed transitions

- `null -> drafted`
- `drafted -> published`
- `drafted -> publish_failed`

### Rules

- there is no `approval_pending`, `approved`, `rejected`, or `cancelled` state in this slice
- `hard_rejected` is a command result, not a persisted state
- `publish_failed` is terminal for this slice

## 7. Minimum schema contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `event_templates`

- `id` TEXT PRIMARY KEY
- `template_key` TEXT NOT NULL
- `template_version` INTEGER NOT NULL
- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `classification` TEXT NOT NULL
- `title_template` TEXT NOT NULL
- `description_template` TEXT NOT NULL
- `default_timezone` TEXT NOT NULL
- `default_duration_minutes` INTEGER NOT NULL
- `created_at` TEXT NOT NULL
- UNIQUE (`template_key`, `template_version`)

Required seed row:

- `template_key = language_club_default`
- `template_version = 1`
- `event_type = language_club`
- `approval_class = routine_auto_publish`
- compatibility mirror: `classification = routine_language_club`

### `events`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `announcement_channel_id` TEXT NOT NULL
- `host_voice_channel_id` TEXT NULL
- `template_id` TEXT NOT NULL
- `template_key` TEXT NOT NULL
- `template_version` INTEGER NOT NULL
- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `classification` TEXT NOT NULL
- `scheduling_scope_key` TEXT NOT NULL
- `state` TEXT NOT NULL
- `title` TEXT NOT NULL
- `description` TEXT NOT NULL
- `timezone` TEXT NOT NULL
- `scheduled_start_at` TEXT NOT NULL
- `scheduled_end_at` TEXT NOT NULL
- `created_by_discord_user_id` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `drafted_at` TEXT NOT NULL
- `published_at` TEXT NULL
- `publish_failed_at` TEXT NULL
- `publish_error` TEXT NULL
- `discord_announcement_message_id` TEXT NULL
- `discord_scheduled_event_id` TEXT NULL
- `google_calendar_event_id` TEXT NULL
- FOREIGN KEY (`template_id`) REFERENCES `event_templates`(`id`)
- UNIQUE (`guild_id`, `event_type`, `scheduling_scope_key`, `scheduled_start_at`)

Canonical shared `events` contract for event slices:

- `announcement_channel_id` is the stored in-server publish target and remains `TEXT NOT NULL`
- `host_voice_channel_id` is `TEXT NULL` in the shared contract; E1 still requires a configured value for supported Language Club events
- `scheduling_scope_key` is the normalized slot key inside an `event_type` and remains `TEXT NOT NULL` for all event types
- for the seeded Language Club path, always write `scheduling_scope_key = language_club_default`
- replace any earlier `UNIQUE (guild_id, template_key, scheduled_start_at)` assumption with `UNIQUE (guild_id, event_type, scheduling_scope_key, scheduled_start_at)`

### `event_state_transitions`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `from_state` TEXT NULL
- `to_state` TEXT NOT NULL
- `actor_discord_user_id` TEXT NOT NULL
- `occurred_at` TEXT NOT NULL
- `reason` TEXT NULL
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)

## 8. Discord command/interaction surface

### Slash command

`/event create-language-club`

Inputs:

- `date` — `YYYY-MM-DD`
- `time` — `HH:mm`

Behavior:

- guild-only; not valid in DMs
- staff-only by configured rule
- service combines `date + time + configured default timezone`
- service uses seeded template default duration; no duration override in this slice
- service writes `scheduling_scope_key = language_club_default` before duplicate checks and persistence
- Discord adapter sends normalized input to service and does not own policy decisions
- on success, reply ephemerally with `event_id`, scheduled start, and publish result
- on rejection, reply ephemerally with the exact reason and write no event row

No buttons, modals, or secondary event commands are included in this slice.

## 9. Approval and publication boundaries

- this slice does not create or simulate approval workflow state
- only the exact seeded routine Language Club path is auto-publishable
- auto-publish is allowed only when all of the following are true:
  - configured guild match
  - authorized staff actor
  - seeded template match: `language_club_default@v1`
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility mirror remains `classification = routine_language_club`
  - publish target is the one configured in-server announcement channel
- all unsupported or non-routine requests are hard-rejected
- publication means one Discord announcement message in-server only
- if Discord publish fails after draft persistence, state becomes `publish_failed` and manual follow-up is required

## 10. Acceptance criteria

- startup fails fast if required guild, announcement channel, host voice channel, timezone, or staff auth config is missing
- database migration creates `event_templates`, `events`, and `event_state_transitions` with the stated constraints, including non-null `announcement_channel_id`, non-null `scheduling_scope_key`, nullable shared `host_voice_channel_id`, and `UNIQUE (guild_id, event_type, scheduling_scope_key, scheduled_start_at)`
- database seed creates exactly one supported template row: `language_club_default@v1` with `event_type`, `approval_class`, and compatibility `classification`
- valid command in the configured guild creates one `events` row in `drafted`, then one announcement message, then updates the row to `published`
- successful publish stores `discord_announcement_message_id`
- failed publish stores `publish_failed`, `publish_failed_at`, and `publish_error`
- every persisted lifecycle step writes an `event_state_transitions` row with actor ID and timestamp
- invalid or unsupported requests create no `events` row
- duplicate event start time for the same `guild_id + event_type + scheduling_scope_key` is rejected
- announcement copy does not mention volunteer coverage or conversation partner coverage
- no approval-like state or approval record is written by this slice

## 11. Validation checklist

- verify slash command is registered only for the configured guild
- verify unauthorized actor receives ephemeral rejection
- verify wrong-guild invocation is rejected before persistence
- verify malformed date/time is rejected before persistence
- verify duplicate schedule for the shared Language Club scheduling scope is rejected before persistence
- verify SQLite row contains stable internal ID, Discord IDs, non-null `announcement_channel_id`, a Language Club `host_voice_channel_id` value, template key/version, `event_type`, `approval_class`, compatibility `classification`, fixed `scheduling_scope_key = language_club_default`, timezone, and external reference placeholders
- verify transition history is `null -> drafted -> published` on success
- verify transition history is `null -> drafted -> publish_failed` on publish failure
- verify configured announcement channel receives exactly one message for a successful run
- verify no reminder, approval, or integration side effects are triggered

## 12. Required configuration to lock before implementation

- Discord guild ID for this slice
- in-server announcement channel ID for this slice
- host voice channel ID to associate with each created Language Club event
- staff authorization rule: exact role IDs, exact Discord permission bit, or both
- default timezone for schedule parsing
- seeded template content:
  - title template
  - description template
  - default duration in minutes
- final Bahasa Indonesia wording for the announcement copy

## 13. Risks and follow-up slice

### Risks

- this slice creates a narrow publish path but does not solve reminder execution or partner coverage
- `publish_failed` requires manual cleanup because retry tooling is excluded
- fixed timezone parsing can still confuse operators if the command copy is unclear
- one-guild and one-channel constraints are safe now but will require explicit widening later

### Follow-up slice

Add reminder scheduling and reminder delivery for already-published seeded Language Club events, still limited to the same single guild, single template, and single announcement channel, and still without introducing broader approval flows.
