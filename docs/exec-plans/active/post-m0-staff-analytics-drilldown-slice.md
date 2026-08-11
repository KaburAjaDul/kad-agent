# 1. Title

Post-M0 Analytics Slice A4: Staff Analytics Drilldown

## 2. Why this slice

After daily text snapshots and live voice aggregates exist, staff need a narrow way to investigate one member or one channel without widening analytics access broadly. This slice keeps drilldown staff-only, ephemeral, auditable, and grounded in SQLite daily analytics tables.

## 3. User-facing value

Authorized staff can inspect one recent member or channel activity window from Discord using a single command, with explicit privacy gates and no public output.

## 4. In scope

- one staff-only slash command: `/analytics drilldown`
- one configured guild only
- reads only from SQLite daily snapshot tables
- one target per request: either a Discord member or a Discord channel
- one bounded time window per request: `7d` or `28d`
- channel drilldown returns aggregate channel metrics only
- member drilldown returns staff-restricted per-member metrics only
- every request is written to an access audit table, including denied requests
- all responses are ephemeral only

## 5. Out of scope

- bulk queries across many members or channels
- exports, attachments, spreadsheets, or API access
- public posting, shared report posting, or DMs
- arbitrary date ranges longer than 28 days
- ranking boards, scorecards, or automated interventions
- any LLM summarization in this slice

## 6. Authorization boundaries and schema contract

### Authorization rules

- `channel` drilldown requires `analytics_viewer_role_ids` or `analytics_member_viewer_role_ids`
- `member` drilldown requires `analytics_member_viewer_role_ids`
- all drilldowns must be invoked from configured staff analytics command channels
- if the actor has only aggregate access and requests member detail, the request is denied
- if role mapping or command-channel eligibility is ambiguous, the request is denied

### `analytics_access_audit`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `actor_discord_user_id` TEXT NOT NULL
- `access_tier` TEXT NOT NULL
- `query_scope` TEXT NOT NULL
- `target_discord_id` TEXT NOT NULL
- `window_days` INTEGER NOT NULL
- `window_end_date` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `decision` TEXT NOT NULL
- `denial_reason` TEXT NULL
- `delivered_surface` TEXT NOT NULL
- `created_at` TEXT NOT NULL

Allowed `access_tier` values:

- `aggregate`
- `member_detail`

Allowed `query_scope` values:

- `channel`
- `member`

Allowed `decision` values:

- `granted`
- `denied`

Allowed `delivered_surface` values:

- `ephemeral`

### Returned metrics

For `channel` drilldown:

- total text messages in window
- total voice connected minutes in window
- distinct active members in window
- active days in window

For `member` drilldown:

- total text messages in window
- total voice connected minutes in window
- total voice sessions in window
- active days in window
- top channels by that member’s aggregate activity within the window

## 7. Privacy boundaries

- all drilldown responses are ephemeral only
- channel drilldown stays aggregate and does not list other members
- member drilldown may expose one member’s counts to authorized staff only
- no message content, message links, transcripts, or copied raw rows are returned
- no shared-channel summary or persistence of drilldown output text is required beyond the audit row

## 8. Discord command surface

### Slash command

`/analytics drilldown`

Inputs:

- `scope` — `channel` or `member`
- `channel` — required when `scope = channel`
- `member` — required when `scope = member`
- `window` — `7d` or `28d`

Behavior:

- guild-only; not valid in DMs
- allowed only in configured staff analytics command channels
- reads from `activity_text_daily` and `activity_voice_daily` only
- writes one `analytics_access_audit` row for both granted and denied requests
- returns an ephemeral result or denial reason only to the requesting actor

## 9. Dependencies and sequencing

- hard dependency: `docs/exec-plans/active/post-m0-discord-voice-session-capture-slice.md`
- hard dependency: `docs/exec-plans/active/post-m0-discord-activity-daily-snapshots-slice.md`
- recommended sequencing dependency: `docs/exec-plans/active/post-m0-staff-weekly-ops-report-slice.md` should land first so drilldown is a follow-up path, not the default analytics surface

## 10. Acceptance criteria

- startup fails fast if staff command channel IDs or analytics role IDs are missing
- database migration creates `analytics_access_audit`
- channel drilldown succeeds for authorized aggregate staff and returns only aggregate channel metrics
- member drilldown succeeds only for authorized member-detail staff
- denied member-detail requests still write an audit row with `decision = denied`
- all responses are ephemeral and no shared-channel drilldown post is created
- drilldown windows longer than 28 days are rejected
- drilldown output reads only from SQLite daily snapshots

## 11. Validation checklist

- verify aggregate-only staff can run `scope = channel`
- verify aggregate-only staff are denied for `scope = member`
- verify denied requests still populate `analytics_access_audit`
- verify channel drilldown does not leak member identifiers
- verify member drilldown shows only the requested member’s metrics
- verify command usage outside configured staff channels is rejected and audited as denied if feasible
- verify drilldown works when the weekly report slice already exists but does not require a weekly report row to be present

## 12. Required configuration to lock before implementation

- Discord guild ID for analytics
- staff analytics command channel IDs
- `analytics_viewer_role_ids`
- `analytics_member_viewer_role_ids`
- final drilldown windows: `7d` and `28d`

## 13. Risks and follow-up slice

### Risks

- per-member drilldown is useful but raises review burden on role assignment hygiene
- ephemeral-only output protects privacy but reduces collaborative sharing inside staff workflows
- audit logging adds operational accountability but also creates another retention-managed table

### Follow-up slice

Add optional staff-approved deterministic summaries over the same analytics data, but keep weekly reports aggregate-only and keep per-member responses ephemeral.
