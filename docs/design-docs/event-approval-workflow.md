# Event Approval Workflow

## Purpose

KAD-Agent needs one deterministic approval path for large and non-routine events.

The goal is simple: make it obvious which events may auto-publish, which must wait for approval, and which requests should stop immediately.

This workflow stays Discord-first for operators and SQLite-backed for workflow truth. Discord surfaces collect input and show outcomes. Service rules classify the request, enforce authority, and write the audit trail.

## Working model

### `event_type` vs `approval_class`

Persist and reason about two separate values:

- `event_type` — what kind of event this is
- `approval_class` — how publish policy treats it

Recommended supported values for the current roadmap:

| event_type | meaning | default approval_class |
|---|---|---|
| `language_club` | recurring language-learning event | `routine_auto_publish` |
| `regional_sharing` | recurring region-based community event | `routine_auto_publish` |
| `cerita_aja_dulu` | featured-speaker storytelling event | `approval_required` |

Recommended approval classes:

- `routine_auto_publish`
- `approval_required`
- `hard_stop`

`approval_class` is determined by service policy, not by user input.

### Compatibility with the existing `classification` field

The seeded Language Club publish slice currently uses a single composite classification such as `routine_language_club`.

That is acceptable as a short bridge, but new work should treat `classification` as a compatibility mirror, not the policy source of truth. The durable model is:

- `event_type = language_club`
- `approval_class = routine_auto_publish`

## Deterministic classification rules

1. Resolve the seeded template and its supported `event_type`.
2. Resolve the policy table for that `event_type`.
3. Evaluate any explicit policy flags stored with the template or request.
4. Produce exactly one outcome:
   - `routine_auto_publish`
   - `approval_required`
   - `hard_stop`

For the current scope, keep the policy table intentionally narrow:

- seeded routine Language Club -> `routine_auto_publish`
- seeded routine Regional Sharing -> `routine_auto_publish`
- seeded Cerita Aja Dulu -> `approval_required`
- unsupported custom event formats, custom publish targets, or unknown templates -> `hard_stop`

Do not let free-text descriptions decide risk. The service should only use configured template keys, event type, and explicit policy flags.

## Approver authority

Approval authority should be explicit and configurable per guild.

Recommended rule set:

- requester must satisfy the staff rule to create an approval request
- approver must satisfy a separate approver rule to review a pending request
- approver authority is for a specific action type, not blanket ownership of every future event action
- self-approval should be disallowed by default
- exact approver role IDs and/or explicit user allowlists should live in config, not be inferred from message location

For the first approval-backed slice, the relevant action type is:

- `publish_event_announcement`

## Approval-required actions

The following actions require approval whenever `approval_class = approval_required`:

- publishing the in-server announcement message
- re-publishing after a material content change
- publishing to a different target channel than the one reviewed
- retrying publish if the implementation changes the reviewed payload or target

Internal draft creation does not itself require approval. The approval boundary is the public-in-server publish action.

## Blocked pre-approval actions

Before approval exists, the service must block:

- announcement publish to member-facing channels
- reminder scheduling or reminder delivery that assumes the event is publicly published
- coverage nudges that assume a confirmed public event
- attendance closeout as a published-event outcome
- any external sync execution

Allowed pre-approval actions:

- storing the event draft
- storing the approval request
- showing requester-visible ephemeral responses
- internal-only notes or queue references if later added

## Approval record

Recommended `approval_requests` fields:

- `id`
- `guild_id`
- `event_id`
- `action_type`
- `event_type`
- `approval_class`
- `state`
- `requested_by_discord_user_id`
- `requested_at`
- `request_reason`
- `request_fingerprint`
- `source_interaction_id`
- `approver_discord_user_id`
- `decision_at`
- `decision_reason`
- `executed_at`
- `execution_result`
- `execution_error`
- `supersedes_request_id`

Important expectations:

- one open request per `event_id + action_type`
- `request_fingerprint` should capture the reviewed publish payload and target
- a material event edit should supersede the old request instead of silently reusing it

## Approval record state machine

Recommended states:

- `pending`
- `approved`
- `rejected`
- `cancelled`
- `expired`
- `executed`
- `execution_failed`

Allowed transitions:

- `null -> pending`
- `pending -> approved`
- `pending -> rejected`
- `pending -> cancelled`
- `pending -> expired`
- `approved -> executed`
- `approved -> execution_failed`

Rules:

- only `pending` requests are reviewable
- terminal requests are immutable except for audit enrichment
- `executed` means the approved action actually ran
- `approved` is permission to execute, not proof that publish already happened
- `execution_failed` preserves approval history while making the failed execution explicit

## Publish semantics

Publish should remain a separately audited execution step even if the user experience is a single approver command.

Before publish executes, service must verify:

- event is still in the expected pre-publish state
- approval request is `approved`
- `request_fingerprint` still matches the event payload and target channel
- the event is not already `published`

When publish succeeds:

- event state becomes `published`
- `approval_requests.state` becomes `executed`
- publish message ID and `published_at` are stored

When publish fails after approval:

- event state becomes `publish_failed`
- `approval_requests.state` becomes `execution_failed`
- failure details are stored for operator follow-up

## Audit and idempotency expectations

Keep the workflow calm and exact:

- SQLite is the source of truth for requests, decisions, and publish outcomes
- every persisted event state change should write an `event_state_transitions` row
- all actor IDs must be stored as Discord snowflake strings
- timestamps must be UTC ISO 8601 strings
- duplicate request creation for the same open `event_id + action_type + request_fingerprint` should return the existing open request instead of creating a second one
- duplicate review attempts on terminal requests should no-op with an exact rejection reason
- duplicate publish execution against an already-published event should return the stored publish result and write no second announcement

## Hard-stop rules

Hard-stop and escalate instead of bluffing when:

- the template or `event_type` is unsupported
- the publish target is not the configured reviewed target
- approver config is missing or ambiguous
- the actor lacks authority for the requested action
- self-approval is attempted while disabled
- the event changed after approval and no new request exists
- the request tries to bypass Discord-first, SQLite-backed workflow truth
- the request mixes event operations with public migration or education guidance that should come from approved knowledge docs
