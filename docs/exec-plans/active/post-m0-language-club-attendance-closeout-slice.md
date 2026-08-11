# 1. Title

Post-M0 Event Slice E3: Language Club Attendance Closeout

## 2. Why this slice

This is the smallest useful closeout slice after publish because it gives the team one deterministic attendance record per Language Club event without claiming full participant tracking.

It should land before weekly analytics reporting so later reports can read stable event-level attendance totals from SQLite instead of guessing from Discord history.

## 3. User-facing value

Authorized staff can close out a published Language Club from Discord and store:

- one stable attendance record in SQLite
- one clear event state transition to `closed_out`
- one exact operator trail for later analytics and wrap-up work

## 4. In scope

- one staff-only slash command: `/event close-language-club`
- command usable only in one configured Discord guild
- service accepts only supported published Language Club events:
  - `event_type = language_club`
  - `approval_class = routine_auto_publish`
  - compatibility fallback: `classification = routine_language_club`
- command records one aggregate attendee count for one event
- optional short internal closeout note is persisted with the record
- event state transitions from `published` to `closed_out`
- closeout action writes a deterministic audit trail with actor ID and timestamp

## 5. Out of scope

- member-level attendance or check-in rows
- automatic voice attendance capture
- attendance edits, reopen flow, delete flow, or resubmission UI
- reminders, coverage, volunteer nudges, or content queue generation
- weekly analytics report generation
- Regional Sharing or Cerita Aja Dulu closeout support
- approval workflow
- Google or Discord external sync execution

## 6. Dependencies

- published events from `docs/exec-plans/active/post-m0-seeded-language-club-publish-slice.md`
- existing `events` and `event_state_transitions` tables
- later weekly analytics reporting should depend on this slice, not the other way around

## 7. State machine with allowed transitions

### Non-persisted result

- `hard_rejected` — request is rejected before any attendance row is created

Hard rejection reasons in this slice:

- wrong guild
- actor fails configured staff authorization rule
- event does not exist
- event is not a supported Language Club event
- event state is not `published`
- scheduled end time has not been reached yet
- attendance closeout already exists for the event
- attendee count is negative or otherwise invalid

### Persisted event states

- `published`
- `closed_out`

### Allowed transitions

- `published -> closed_out`

### Rules

- this slice adds no `reopened` or `edited` state
- `closed_out` is terminal for this slice
- a closeout command writes one attendance row and one state transition row together or not at all

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `attendance`

- `id` TEXT PRIMARY KEY
- `event_id` TEXT NOT NULL
- `record_kind` TEXT NOT NULL
- `attendee_count` INTEGER NOT NULL
- `recorded_by_discord_user_id` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `recorded_at` TEXT NOT NULL
- `notes` TEXT NULL
- FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
- UNIQUE (`event_id`, `record_kind`)

Required `record_kind` in this slice:

- `aggregate_closeout`

### `events` additions

- `closed_out_at` TEXT NULL

This slice also expands the allowed `events.state` values to include `closed_out`.

## 9. Discord command/interaction surface

### Slash command

`/event close-language-club`

Inputs:

- `event_id` — stable ID returned by the publish slice
- `attendee_count` — non-negative integer
- `notes` — optional short internal note

Behavior:

- guild-only; not valid in DMs
- staff-only by configured rule
- service, not the Discord adapter, decides whether the event is eligible for closeout
- on success, reply ephemerally with `event_id`, stored attendee count, and the new `closed_out` state
- on rejection, reply ephemerally with the exact reason and write no attendance row

## 10. Approval and publication boundaries

- this slice does not create or simulate approval workflow state
- closeout is an internal staff-only recording action, not a publish action
- no public message, DM, social output, or external sync is sent by a successful closeout
- only already-published supported Language Club events may be closed out

## 11. Acceptance criteria

- valid command against a supported published Language Club event writes exactly one `attendance` row with `record_kind = aggregate_closeout`
- successful closeout updates the event state to `closed_out` and stores `closed_out_at`
- every successful closeout writes an `event_state_transitions` row with actor ID and timestamp
- invalid or duplicate closeout requests create no `attendance` row
- closeout command is rejected before scheduled end time
- persisted closeout does not imply or fabricate member-level attendance detail

## 12. Validation checklist

- verify unauthorized actor receives an exact ephemeral rejection
- verify wrong-guild invocation is rejected before persistence
- verify unknown `event_id` is rejected before persistence
- verify pre-end-time closeout is rejected before persistence
- verify duplicate closeout is rejected by service and uniqueness rules
- verify successful closeout stores `attendee_count`, `recorded_by_discord_user_id`, and `source_interaction_id`
- verify event transition history includes `published -> closed_out`
- verify no reminder, approval, or analytics side effects are triggered

## 13. Required configuration to lock before implementation

- staff authorization rule for closeout actions
- whether closeout is allowed exactly at `scheduled_end_at` or only after a short grace period
- maximum note length for the optional internal note
- final operator-facing rejection copy for early or duplicate closeout attempts

## 14. Risks and follow-up slice

### Risks

- attendee count is manually supplied and can still be inaccurate
- lack of edit or reopen flow means operator mistakes require manual cleanup
- aggregate-only attendance is enough for early analytics, but not for member-level insights

### Follow-up slice

Build weekly staff analytics summaries that consume `closed_out` events and `attendance.aggregate_closeout` records without inventing missing participant detail.
