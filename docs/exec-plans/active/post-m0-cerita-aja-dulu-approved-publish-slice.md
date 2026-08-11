# 1. Title

Post-M0 Event Slice E7: Cerita Aja Dulu Approved Publish

## 2. Why this slice

This slice completes the minimum safe approval-backed Cerita Aja Dulu path after pending request creation exists.

It keeps the scope intentionally narrow:

- one approver-only review command
- one approval-required event type
- one configured guild
- one reviewed in-server announcement target already stored on the event row
- SQLite audit trail for both the approval decision and publish execution

## 3. User-facing value

Authorized approvers can review a pending Cerita Aja Dulu request from Discord and get:

- a clear approve or reject outcome
- one durable approval audit record in SQLite
- one public-in-server announcement only when the approved publish path succeeds

## 4. In scope

- one approver-only slash command: `/approval review-cerita-aja-dulu`
- command usable only in one configured Discord guild
- review supports exactly two decisions: `approve` or `reject`
- service accepts only pending Cerita Aja Dulu approval requests for `publish_event_announcement`
- reject path records the decision and writes no public announcement message
- approve path first verifies the stored request fingerprint and reviewed target while the request is still `pending`
- stale fingerprint mismatches expire the old request with an explicit reason and write no public announcement message
- only a still-valid pending request may transition to approved and then attempt one in-server publish
- event lifecycle and approval lifecycle are both recorded with stable IDs and timestamps
- ephemeral Discord response returns the exact review and publish result

## 5. Out of scope

- initial request creation
- buttons, modals, or approval inbox/list commands
- event edits, resubmission, supersede tooling, or retry UI
- reminders, attendance, coverage, analytics, or content queue generation
- Discord Scheduled Event creation
- Google Calendar, Google Sheets, or any external sync execution
- multi-guild or multi-channel publish fan-out

## 6. Dependencies

- `docs/exec-plans/active/post-m0-cerita-aja-dulu-approval-request-slice.md`
- deterministic approval rules from `docs/design-docs/event-approval-workflow.md`
- existing `events`, `approval_requests`, and `event_state_transitions` storage

## 7. State machine with allowed transitions

### Non-persisted result

- `hard_rejected` — review is rejected before any decision or publish state changes are written

Hard rejection reasons in this slice:

- wrong guild
- actor fails configured approver authorization rule
- self-approval is attempted while disabled
- request does not exist
- request is not in `pending`
- event does not exist or is not in `approval_pending`
- request action type is not `publish_event_announcement`
- stored `announcement_channel_id` is missing or invalid
- event is already published

### Persisted event states

- `approval_pending`
- `approval_rejected`
- `approved`
- `published`
- `publish_failed`

### Persisted approval request states

- `pending`
- `approved`
- `rejected`
- `expired`
- `executed`
- `execution_failed`

### Allowed transitions

- `approval_pending -> approval_rejected`
- `approval_pending -> approved`
- `approved -> published`
- `approved -> publish_failed`
- `pending -> rejected`
- `pending -> expired`
- `pending -> approved`
- `approved -> executed`
- `approved -> execution_failed`

### Rules

- rejection records a terminal approval outcome and writes no public announcement
- approve path must verify the stored fingerprint before any `pending -> approved` transition
- stale fingerprint mismatch transitions the request to `expired` with an explicit stale reason, leaves the event in `approval_pending`, and requires a new request before publish
- successful publish must move both the event and approval request into terminal success states
- failed publish after approval must preserve the approval decision and record explicit execution failure
- duplicate review attempts on terminal requests must not create a second public announcement

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`

### `approval_requests` required decision and execution fields

- `approver_discord_user_id` TEXT NULL
- `decision_at` TEXT NULL
- `decision_reason` TEXT NULL
- `executed_at` TEXT NULL
- `execution_result` TEXT NULL
- `execution_error` TEXT NULL

Allowed `approval_requests.state` values in this slice:

- `pending`
- `approved`
- `rejected`
- `expired`
- `executed`
- `execution_failed`

For stale-request handling in this slice:

- fingerprint mismatch should write an explicit stale reason into `decision_reason` or an equivalent audit text field
- stale-request terminalization must leave the row non-open so a new request can later be created

### `events` required publish fields

- `announcement_channel_id` TEXT NOT NULL
- `host_voice_channel_id` TEXT NULL
- `event_type` TEXT NOT NULL
- `approval_class` TEXT NOT NULL
- `scheduling_scope_key` TEXT NOT NULL
- `published_at` TEXT NULL
- `publish_failed_at` TEXT NULL
- `publish_error` TEXT NULL
- `discord_announcement_message_id` TEXT NULL

Allowed `events.state` values added or used in this slice:

- `approval_pending`
- `approval_rejected`
- `approved`
- `published`
- `publish_failed`

Shared `events` contract reused in this slice:

- E6 already wrote fixed `scheduling_scope_key = cerita_aja_dulu_default`; this slice reuses that same shared uniqueness model and adds no Cerita-specific slot rule
- E6 populated `announcement_channel_id` from the configured Cerita publish target; approved publish must reuse the stored value as the reviewed target and destination
- `host_voice_channel_id` remains `NULL` and unused for Cerita

No new table is required if the request slice already introduced `approval_requests` with the expected fields.

## 9. Discord command/interaction surface

### Slash command

`/approval review-cerita-aja-dulu`

Inputs:

- `approval_request_id`
- `decision` — `approve` or `reject`
- `reason` — optional short internal decision note

Behavior:

- guild-only; not valid in DMs
- approver-only by configured rule
- Discord adapter passes normalized input to the service and does not decide authority or publish eligibility
- on `reject`, service records the decision, moves the event to `approval_rejected`, and returns an exact ephemeral result
- on `approve`, service first verifies the fingerprint and stored `announcement_channel_id` target while the request is still `pending`
- if the reviewed payload is stale, service expires the request with an explicit reason, leaves the event in `approval_pending`, and returns an exact ephemeral result with no publish attempt
- only after validation may service record approval, attempt one publish, and return the combined decision and publish result ephemerally

No approval buttons, modals, or bulk review flows are included in this slice.

## 10. Approval and publication boundaries

- only pending Cerita Aja Dulu requests for `publish_event_announcement` are reviewable
- only configured approvers may review
- approval applies to one reviewed payload and one reviewed target channel, captured by `request_fingerprint` and persisted as non-null `events.announcement_channel_id`
- stale reviewed payloads invalidate the old request instead of leaving it pending
- publish execution is allowed only after the approval decision is written for a still-valid request
- successful publish means one Discord announcement message in the stored in-server target channel
- no social publishing, no public-web publishing, and no external sync is allowed
- rejection never publishes anything

## 11. Acceptance criteria

- valid reject review moves the event to `approval_rejected`, moves the request to `rejected`, stores approver ID and decision timestamp, and sends no public announcement
- valid approve review verifies the pending request fingerprint before any approval state transition
- stale fingerprint mismatch moves the old request to `expired`, stores an explicit stale reason, leaves the event in `approval_pending`, and writes no announcement message
- successful approve-and-publish reuses the stored non-null `announcement_channel_id`, then stores `published`, `published_at`, `discord_announcement_message_id`, and request state `executed`
- failed publish after approval stores event state `publish_failed`, request state `execution_failed`, and exact error details
- duplicate review against a terminal request creates no second announcement message

## 12. Validation checklist

- verify unauthorized or self-approving actors receive exact ephemeral rejection
- verify unknown or non-pending request IDs are rejected before any publish attempt
- verify reject path stores decision audit data and publishes nothing
- verify approve path stores approval audit data only after fingerprint validation passes against the stored target channel
- verify stale fingerprint mismatch expires the request cleanly and keeps the event waiting for a fresh request
- verify successful publish uses the stored `announcement_channel_id` and stores message ID and timestamps on both event and request records
- verify failed publish stores explicit execution failure fields on both records
- verify no reminder, attendance, coverage, or external integration side effect is triggered

## 13. Required configuration to lock before implementation

- Discord guild ID for this slice
- approver authorization rule
- explicit self-approval policy
- configured Cerita announcement channel ID used by E6 to populate `events.announcement_channel_id`
- final Bahasa Indonesia wording for the public announcement copy
- maximum internal decision-note length
- exact request fingerprint definition and hashing strategy

## 14. Risks and follow-up slice

### Risks

- without edit and supersede tooling, material event changes after request creation still require manual discipline
- `publish_failed` still needs manual cleanup because retry UI is out of scope
- request-ID-based review is deterministic but less ergonomic than an approval inbox surface

### Follow-up slice

Add a staff-only approval inbox or queue message view and a clean supersede flow for materially edited approval-required events.
