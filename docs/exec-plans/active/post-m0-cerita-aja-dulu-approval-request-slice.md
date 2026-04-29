# 1. Title

Post-M0 Event Slice E6: Cerita Aja Dulu Approval Request

## 2. Why this slice

This is the safest first Cerita Aja Dulu slice because it creates deterministic draft and approval-request records without publishing anything to member-facing channels.

It proves the approval-backed path while keeping blast radius low:

- one approval-required event type
- one configured guild
- one seeded template
- SQLite event and approval records before any public publish action

## 3. User-facing value

Authorized staff can submit a Cerita Aja Dulu proposal from Discord and get:

- a stored event draft in SQLite
- a stored pending approval request in SQLite
- stable `event_id` and `approval_request_id` values for later approver review

## 4. In scope

- one staff-only slash command: `/event request-cerita-aja-dulu`
- command usable only in one configured Discord guild
- one seeded template: `cerita_aja_dulu_default@v1`
- one deterministic approval-backed event policy path:
  - `event_type = cerita_aja_dulu`
  - `approval_class = approval_required`
  - compatibility mirror if still needed: `classification = approval_required_cerita_aja_dulu`
- service writes a fixed `scheduling_scope_key = cerita_aja_dulu_default` for every supported Cerita Aja Dulu event in this slice
- service resolves one configured in-server Cerita announcement channel and stores it as non-null `announcement_channel_id` on the event row for later approved publish reuse
- service stores `host_voice_channel_id = NULL` for Cerita because this slice does not use a host voice channel
- service derives title and description from the seeded template plus `speaker_name` and scheduled start time
- when a new record set is required, service persists the event draft in SQLite before creating the approval request row
- service persists at most one open approval request for the publish action
- duplicate request creation for the same open pending fingerprint returns the existing event plus approval request instead of creating any new rows
- event lifecycle is recorded with stable IDs and transition rows
- ephemeral Discord response returns both IDs and the exact pending status

## 5. Out of scope

- approval decision, approval review UI, or approver queue list
- any public event announcement publish
- reminder scheduling, reminder delivery, or coverage nudges
- attendance capture, wrap-up summaries, analytics outputs, or content queue generation
- event edit, reschedule, cancel, retry, or delete flows
- Discord Scheduled Event creation
- Google Calendar, Google Sheets, or any external sync execution
- multi-guild or multi-template support

## 6. Dependencies

- Milestone 0 foundation and bot skeleton
- deterministic approval policy from `docs/design-docs/event-approval-workflow.md`
- existing `events` and `event_state_transitions` foundation from routine event slices

## 7. State machine with allowed transitions

### Non-persisted result

- `hard_rejected` — request is rejected before any `events` or `approval_requests` row is created

Hard rejection reasons in this slice:

- wrong guild
- actor fails configured staff authorization rule
- template is not `cerita_aja_dulu_default@v1`
- event type or approval class does not match the supported Cerita Aja Dulu path
- schedule input is invalid
- `speaker_name` is missing or invalid
- announcement channel config is missing or invalid
- approver configuration is missing or ambiguous
- conflicting duplicate already occupies the same shared event slot: `guild_id + event_type + scheduling_scope_key + scheduled_start_at` with a different normalized publish payload or request fingerprint

### Persisted event states

- `drafted`
- `approval_pending`

### Persisted approval request states

- `pending`

### Allowed transitions

- `null -> drafted`
- `drafted -> approval_pending`
- `null -> pending`

### Rules

- this slice creates no `approved`, `rejected`, `published`, or `publish_failed` outcomes
- request creation does not imply or simulate approval
- `approval_pending` is the terminal event state for this slice
- exactly one open request exists per `event_id + action_type`; in this slice, `pending` is the only open state
- same normalized payload plus open pending fingerprint is an idempotent success path: return the existing `event` and `approval_request` and create no new rows

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `event_templates` additions or required fields

- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL

Required seed row in this slice:

- `template_key = cerita_aja_dulu_default`
- `template_version = 1`
- `event_type = cerita_aja_dulu`
- `approval_class = approval_required`

### `events` additions or required fields

- `announcement_channel_id` TEXT NOT NULL
- `host_voice_channel_id` TEXT NULL
- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `scheduling_scope_key` TEXT NOT NULL
- `featured_speaker_name` TEXT NULL

The event row should continue storing:

- `template_key`
- `template_version`
- `state`
- `title`
- `description`
- `scheduled_start_at`
- `scheduled_end_at`
- `created_by_discord_user_id`
- `source_interaction_id`

Shared `events` contract for Cerita in this slice:

- write fixed `scheduling_scope_key = cerita_aja_dulu_default`
- populate `announcement_channel_id` from the one configured in-server Cerita publish target at request time and persist it for E7 reuse
- store `host_voice_channel_id = NULL`; Cerita does not use it
- enforce `UNIQUE (guild_id, event_type, scheduling_scope_key, scheduled_start_at)`
- same open fingerprint remains an idempotent return path; a different normalized payload or fingerprint in the same shared slot is a hard rejection

### `approval_requests`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `event_id` TEXT NOT NULL
- `action_type` TEXT NOT NULL
- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `state` TEXT NOT NULL
- `requested_by_discord_user_id` TEXT NOT NULL
- `requested_at` TEXT NOT NULL
- `request_reason` TEXT NULL
- `request_fingerprint` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `approver_discord_user_id` TEXT NULL
- `decision_at` TEXT NULL
- `decision_reason` TEXT NULL
- `executed_at` TEXT NULL
- `execution_result` TEXT NULL
- `execution_error` TEXT NULL
- `supersedes_request_id` TEXT NULL
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)

Open-request and idempotency rules for this slice:

- enforce one open request per `event_id + action_type`
- in this slice, `pending` is the only open state
- historical terminal requests for the same `event_id + action_type` remain allowed for later supersede flows
- duplicate request creation for the same open `event_id + action_type + request_fingerprint` must return the existing event plus pending request row set and create no new rows
- do not model this with `UNIQUE (event_id, action_type, state)` because that does not express open-request semantics cleanly

Required `action_type` in this slice:

- `publish_event_announcement`

## 9. Discord command/interaction surface

### Slash command

`/event request-cerita-aja-dulu`

Inputs:

- `speaker_name`
- `date` — `YYYY-MM-DD`
- `time` — `HH:mm`

Behavior:

- guild-only; not valid in DMs
- staff-only by configured rule
- Discord adapter passes normalized input to the service and does not decide approval policy
- service resolves the configured Cerita announcement target, writes `scheduling_scope_key = cerita_aja_dulu_default`, derives the event draft, normalizes the reviewed publish payload, and computes the request fingerprint before deciding whether anything new should be persisted
- if the same open pending request already exists for the same fingerprint, service returns the existing event and approval request and creates no new rows
- if the same shared event slot is already occupied by a different normalized payload or request fingerprint, service hard-rejects the conflicting duplicate and creates no rows
- on success, reply ephemerally with `event_id`, `approval_request_id`, scheduled start, and `pending` status
- on rejection, reply ephemerally with the exact reason and write no persisted rows

No buttons, modals, approval queue posts, or approver review commands are included in this slice.

## 10. Approval and publication boundaries

- Cerita Aja Dulu is never auto-publishable in this slice
- creating the request stores internal workflow truth only
- this slice must not publish a public announcement message, schedule reminders, or trigger external sync
- only the approval request for `publish_event_announcement` is created
- any attempt to treat request creation as publish approval is a hard rejection

## 11. Acceptance criteria

- startup fails fast if required guild, Cerita announcement channel, timezone, staff auth, or approver auth config is missing
- valid command in the configured guild creates one `events` row in `drafted`, one state transition to `approval_pending`, and one `approval_requests` row in `pending`
- successful request creation stores non-null `announcement_channel_id`, fixed `scheduling_scope_key = cerita_aja_dulu_default`, `host_voice_channel_id = NULL`, `featured_speaker_name`, and a stable `request_fingerprint`
- duplicate request creation for the same open pending fingerprint returns the existing event and approval request and creates no new rows
- conflicting duplicate creation for the same `guild_id + event_type + scheduling_scope_key + scheduled_start_at` slot with a different normalized payload or fingerprint is hard-rejected and creates no rows
- historical terminal requests remain compatible with later supersede flows for the same `event_id + action_type`
- invalid or unsupported requests create no persisted rows
- no member-facing announcement message is sent by this slice

## 12. Validation checklist

- verify unauthorized actor receives ephemeral rejection
- verify wrong-guild invocation is rejected before persistence
- verify malformed date/time is rejected before persistence
- verify missing or invalid `speaker_name` is rejected before persistence
- verify missing Cerita announcement channel config is rejected before persistence
- verify missing approver config is rejected before persistence
- verify event row stores non-null `announcement_channel_id`, `host_voice_channel_id = NULL`, fixed `scheduling_scope_key = cerita_aja_dulu_default`, `event_type`, `approval_class`, and `featured_speaker_name`
- verify approval row stores `action_type`, `request_fingerprint`, requester ID, and `pending` state
- verify repeated same-fingerprint request creation returns the existing event and approval request and does not increase row counts
- verify conflicting duplicate input for the same shared event slot but a different normalized payload or fingerprint is rejected before persistence
- verify the contract permits historical terminal requests for the same `event_id + action_type`
- verify event transition history includes `null -> drafted -> approval_pending`
- verify no public publish, reminder, or integration side effect is triggered

## 13. Required configuration to lock before implementation

- Discord guild ID for this slice
- in-server announcement channel ID for approved Cerita Aja Dulu publish target
- staff authorization rule for requesters
- approver authorization rule for later review
- default timezone for schedule parsing
- seeded template content:
  - title template
  - description template
  - default duration in minutes
- final Bahasa Indonesia wording for the draft announcement copy
- request fingerprint fields to include at minimum:
  - target announcement channel ID
  - title
  - description
  - scheduled start and end

## 14. Risks and follow-up slice

### Risks

- no approver queue surface means request IDs must be carried into the next review slice
- no edit or supersede flow means changed event details require careful follow-up design
- request creation alone may feel incomplete to operators if the pending status copy is not very clear

### Follow-up slice

Add approver review and approved publish execution for pending Cerita Aja Dulu requests, with separate approval and publish audit fields stored in SQLite.
