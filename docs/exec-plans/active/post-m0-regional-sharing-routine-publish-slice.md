# 1. Title

Post-M0 Event Slice E5: Regional Sharing Routine Create And Publish

## 2. Why this slice

This is the second routine event-type slice after seeded Language Club publish.

It widens event operations in a controlled way by reusing the same Discord-first and SQLite-backed pattern while adding only one new variable: a configured `region_key` that determines where the event should publish.

## 3. User-facing value

Authorized staff can create and publish one constrained Regional Sharing announcement from Discord and get:

- a stored event record in SQLite
- a clear `region_key` tied to the event for later follow-up work
- one exact announcement message in the configured in-server region channel

## 4. In scope

- one staff-only slash command: `/event create-regional-sharing`
- command usable only in one configured Discord guild
- one seeded template: `regional_sharing_default@v1`
- one deterministic event policy path:
  - `event_type = regional_sharing`
  - `approval_class = routine_auto_publish`
  - compatibility mirror: `classification = routine_regional_sharing`
- service accepts only region choices from a configured allowlist
- each allowed `region_key` maps to one configured announcement channel and one configured host voice channel placeholder
- service derives `scheduling_scope_key` from the selected `region_key` and uses that shared scope field for duplicate checks
- service derives title and description from the seeded template plus the selected region and scheduled start time
- service persists the event in SQLite before any Discord publish attempt
- successful publish posts exactly one announcement message to the configured in-server regional channel
- event lifecycle is recorded with stable IDs and transition rows

## 5. Out of scope

- unconfigured or free-text regions
- approval workflow or non-routine Regional Sharing variants
- reminders, attendance, volunteer coverage, or post-event summaries
- Language Club or Cerita Aja Dulu behavior changes
- event edit, reschedule, cancel, retry, or delete flows
- Discord Scheduled Event creation
- Google Calendar, Google Sheets, or any external sync execution
- multi-guild support

## 6. Dependencies

- Milestone 0 foundation and bot skeleton
- the existing seeded Language Club publish slice as the implementation pattern to copy, not as a direct feature dependency
- deterministic event-type policy from `docs/design-docs/event-approval-workflow.md`

## 7. State machine with allowed transitions

### Non-persisted result

- `hard_rejected` — request is rejected before any `events` row is created

Hard rejection reasons in this slice:

- wrong guild
- actor fails configured staff authorization rule
- template is not `regional_sharing_default@v1`
- event type or approval class does not match the supported routine Regional Sharing path
- region choice is not configured
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

- this slice adds no approval-pending or review state
- `hard_rejected` is a command result, not a persisted state
- `publish_failed` is terminal for this slice

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `event_templates` additions or required fields

- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL

Required seed row in this slice:

- `template_key = regional_sharing_default`
- `template_version = 1`
- `event_type = regional_sharing`
- `approval_class = routine_auto_publish`
- compatibility mirror: `classification = routine_regional_sharing`

### `events` additions or required fields

- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `scheduling_scope_key` TEXT NOT NULL
- `region_key` TEXT NOT NULL
- `region_label` TEXT NOT NULL

The event row should continue storing:

- `announcement_channel_id`
- `host_voice_channel_id`
- `template_key`
- `template_version`
- `state`
- `title`
- `description`
- `scheduled_start_at`
- `scheduled_end_at`
- `created_by_discord_user_id`
- `source_interaction_id`
- `discord_announcement_message_id`

Shared scheduling-scope rule for this slice:

- derive `scheduling_scope_key` directly from the selected `region_key`
- enforce `UNIQUE (guild_id, event_type, scheduling_scope_key, scheduled_start_at)`
- reuse the same shared `events.scheduling_scope_key` model introduced for E1 rather than adding a region-specific uniqueness rule

## 9. Discord command/interaction surface

### Slash command

`/event create-regional-sharing`

Inputs:

- `region` — one configured choice value, not free text
- `date` — `YYYY-MM-DD`
- `time` — `HH:mm`

Behavior:

- guild-only; not valid in DMs
- staff-only by configured rule
- Discord adapter passes normalized `region/date/time` input to the service
- service resolves channel mapping, template compatibility, event type, approval class, and `scheduling_scope_key`
- on success, reply ephemerally with `event_id`, selected region, scheduled start, and publish result
- on rejection, reply ephemerally with the exact reason and write no event row

No buttons, modals, or multi-step region creation flows are included in this slice.

## 10. Approval and publication boundaries

- only the exact seeded routine Regional Sharing path is auto-publishable
- auto-publish is allowed only when all of the following are true:
  - configured guild match
  - authorized staff actor
  - seeded template match: `regional_sharing_default@v1`
  - `event_type = regional_sharing`
  - `approval_class = routine_auto_publish`
  - `region_key` resolves to one configured in-server announcement channel
- unsupported or custom region behavior is hard-rejected rather than silently downgraded
- publication means one Discord announcement message in-server only
- no social publishing, web publishing, or external sync is allowed

## 11. Acceptance criteria

- startup fails fast if required guild, region allowlist, region channel mapping, host voice channel mapping, timezone, or staff auth config is missing
- database migration and seed support exactly one routine Regional Sharing template row
- valid command in the configured guild creates one `events` row in `drafted`, then one announcement message, then updates the row to `published`
- successful publish stores `discord_announcement_message_id`, `scheduling_scope_key`, `region_key`, and `region_label`
- failed publish stores `publish_failed`, `publish_failed_at`, and `publish_error`
- every persisted lifecycle step writes an `event_state_transitions` row with actor ID and timestamp
- invalid or unsupported requests create no `events` row
- duplicate event start time for the same `guild_id + event_type + scheduling_scope_key` is rejected

## 12. Validation checklist

- verify slash command exposes only configured region choices
- verify unauthorized actor receives ephemeral rejection
- verify wrong-guild invocation is rejected before persistence
- verify unknown or removed `region_key` is rejected before persistence
- verify duplicate schedule for the same region-derived scheduling scope is rejected before persistence
- verify SQLite row stores `event_type`, `approval_class`, `scheduling_scope_key`, `region_key`, and mapped channel IDs
- verify transition history is `null -> drafted -> published` on success
- verify transition history is `null -> drafted -> publish_failed` on Discord publish failure
- verify no approval, reminder, attendance, or integration side effects are triggered

## 13. Required configuration to lock before implementation

- Discord guild ID for this slice
- staff authorization rule
- default timezone for schedule parsing
- region allowlist with stable keys and human-readable labels
- per-region announcement channel ID and host voice channel ID mapping
- seeded template content:
  - title template
  - description template
  - default duration in minutes
- final Bahasa Indonesia wording for the announcement copy

## 14. Risks and follow-up slice

### Risks

- region-to-channel mapping adds configuration surface and can drift if channel IDs change
- constrained region allowlists are safe early, but operators may still ask for free-text flexibility too soon
- this slice expands routine publishing but still does not solve reminders, coverage, or attendance for Regional Sharing

### Follow-up slice

Add reminders for published Regional Sharing events only after the constrained region model proves stable in one guild.
