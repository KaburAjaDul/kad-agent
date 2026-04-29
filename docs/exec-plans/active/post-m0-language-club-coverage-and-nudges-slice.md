# 1. Title

Post-M0 Event Slice E4: Language Club Coverage And Nudges

## 2. Why this slice

After publish and reminder delivery, the next operational pain point is missing conversation partner coverage.

This slice keeps the scope small by storing one supported coverage role in SQLite and sending internal nudges from those stored assignment records instead of relying on ad-hoc Discord memory.

## 3. User-facing value

Authorized staff can assign Language Club conversation partners from Discord and get:

- durable coverage records in SQLite
- a clear `open` vs `filled` coverage signal for each event
- deterministic internal nudges when coverage is still open or assigned partners need a reminder

## 4. In scope

- only one supported event path:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility fallback: `classification = routine_language_club`
- only one supported coverage role key: `conversation_partner`
- create one `event_roles` row for supported published Language Club events with a fixed required count
- staff-only slash commands to add and remove assignment records for that role
- store assignments in SQLite, not in Discord-only message state
- schedule internal coverage nudges from persisted role and assignment rows
- one shortage nudge type for still-open coverage
- one assignee nudge type for already-assigned conversation partners
- nudge delivery limited to one configured internal coordination channel

## 5. Out of scope

- volunteer signup buttons or self-serve claiming
- DMs to volunteers or members
- multiple role types beyond `conversation_partner`
- approval workflow
- public announcement edits or reminder edits
- attendance capture, analytics outputs, or content queue generation
- Regional Sharing or Cerita Aja Dulu coverage support
- external Google or Discord sync execution

## 6. Dependencies

- `docs/exec-plans/active/post-m0-seeded-language-club-publish-slice.md`
- `docs/exec-plans/active/post-m0-language-club-reminders-slice.md`
- Milestone 0 job runner foundation
- existing `events` table with published Language Club rows

## 7. State machine with allowed transitions

### Coverage requirement states

- `open`
- `filled`

Allowed transitions:

- `null -> open`
- `open -> filled`
- `filled -> open`

Rules:

- `open` vs `filled` is determined by active assignment count compared with the stored required count
- the required count is frozen onto the `event_roles` row when the event first becomes eligible for coverage tracking

### Assignment states

- `assigned`
- `removed`

Allowed transitions:

- `null -> assigned`
- `assigned -> removed`

### Nudge states

- `scheduled`
- `sent`
- `skipped`
- `send_failed`

Allowed transitions:

- `null -> scheduled`
- `scheduled -> sent`
- `scheduled -> skipped`
- `scheduled -> send_failed`

Rules:

- shortage nudges may move to `skipped` if coverage becomes `filled` before send time
- assignee nudges may move to `skipped` if no active assignment remains when the job runs
- terminal nudge rows must not produce duplicate Discord messages

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `event_roles`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `role_key` TEXT NOT NULL
- `required_count` INTEGER NOT NULL
- `state` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
- UNIQUE (`event_id`, `role_key`)

Required `role_key` in this slice:

- `conversation_partner`

### `event_assignments`

- `id` TEXT PRIMARY KEY
- `event_role_id` TEXT NOT NULL
- `event_id` TEXT NOT NULL
- `assigned_discord_user_id` TEXT NOT NULL
- `state` TEXT NOT NULL
- `assigned_by_discord_user_id` TEXT NOT NULL
- `assigned_at` TEXT NOT NULL
- `removed_at` TEXT NULL
- `source_interaction_id` TEXT NOT NULL
- FOREIGN KEY (`event_role_id`) REFERENCES `event_roles`(`id`)
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)

Assignment-history rule in this slice:

- each successful assignment creates a new `event_assignments` row in `assigned`
- each successful unassignment transitions the one active row for that `event_role_id + assigned_discord_user_id` pair to `removed` and sets `removed_at`
- keep historical `removed` rows; do not block repeated removal history for the same user and role
- enforce at most one active `assigned` row per `event_role_id + assigned_discord_user_id`, for example with a partial unique index on rows where `state = assigned`

### `event_role_nudges`

- `id` TEXT PRIMARY KEY
- `event_role_id` TEXT NOT NULL
- `nudge_key` TEXT NOT NULL
- `target_channel_id` TEXT NOT NULL
- `state` TEXT NOT NULL
- `scheduled_send_at` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `sent_at` TEXT NULL
- `skipped_at` TEXT NULL
- `send_failed_at` TEXT NULL
- `send_error` TEXT NULL
- `discord_message_id` TEXT NULL
- FOREIGN KEY (`event_role_id`) REFERENCES `event_roles`(`id`)
- UNIQUE (`event_role_id`, `nudge_key`)

Required `nudge_key` values in this slice:

- `coverage_open_t_minus_24h`
- `assigned_partner_t_minus_2h`

## 9. Discord command/interaction surface

### Slash commands

`/event assign-language-club-coverage`

Inputs:

- `event_id`
- `user`

`/event unassign-language-club-coverage`

Inputs:

- `event_id`
- `user`

Behavior:

- guild-only; not valid in DMs
- staff-only by configured rule
- service ensures the event is a supported published Language Club event before assignment changes are allowed
- on success, reply ephemerally with current active assignment count, required count, and resulting coverage state
- on rejection, reply ephemerally with the exact reason and write no invalid assignment state

No signup buttons, modals, or volunteer self-service flows are included in this slice.

## 10. Approval and publication boundaries

- this slice does not create or simulate approval workflow state
- coverage nudges are internal operations messages only
- nudge delivery is allowed only to one configured internal coordination channel
- no member-facing announcement, DM, social publish, or external sync is allowed
- unsupported event types or unpublished events must reject assignment changes

## 11. Acceptance criteria

- when a supported Language Club event becomes eligible for coverage tracking, one `event_roles` row exists for `conversation_partner`
- valid assignment command writes one new `event_assignments` row in `assigned`
- valid unassignment command transitions the single active assignment row to `removed`
- reassignment after removal is allowed and creates a fresh `assigned` row while keeping older `removed` rows as history
- role state updates to `filled` when active assignments meet required count and back to `open` when they do not
- exactly one shortage nudge row and one assignee nudge row exist per event role
- due shortage nudge sends only when coverage is still `open`
- due assignee nudge sends using current active assignment rows, not ad-hoc Discord state
- successful nudge delivery stores `discord_message_id`
- failed nudge delivery stores terminal failure state and error text

## 12. Validation checklist

- verify unsupported or unpublished events reject assignment changes before persistence
- verify duplicate active assignment for the same user and role is rejected
- verify assign -> unassign -> assign for the same user and role succeeds by creating a new active row while preserving prior `removed` history
- verify `event_roles.required_count` is frozen for the event once created
- verify `open -> filled -> open` transitions occur as assignment count changes
- verify shortage nudge is skipped if coverage is filled before send time
- verify assignee nudge mentions only currently assigned users
- verify terminal nudge rows do not send duplicate Discord messages on repeated job execution
- verify no public announcement or reminder message is modified by this slice

## 13. Required configuration to lock before implementation

- staff authorization rule for assignment commands
- internal coordination channel ID for coverage nudges
- required `conversation_partner` count for each Language Club event
- nudge offsets for this slice:
  - `coverage_open_t_minus_24h`
  - `assigned_partner_t_minus_2h`
- final Bahasa Indonesia wording for shortage and assignee nudges

## 14. Risks and follow-up slice

### Risks

- one-role-only coverage is intentionally narrow and will not represent the full event staffing picture
- internal channel nudges are safer than DMs, but still rely on staff watching the right channel
- no volunteer self-service means assignments remain manual

### Follow-up slice

Extend coverage beyond one role only after the team confirms the stored assignment model and nudge cadence are working in practice.
