# 1. Title

Post-M0 Analytics Slice A3: Staff Weekly Ops Report

## 2. Why this slice

This is the first visible analytics output after voice capture, text snapshots, and Language Club attendance closeout exist. It turns existing SQLite event, attendance, and activity data into one conservative staff-only weekly summary without introducing public analytics, exports, or per-member exposure.

## 3. User-facing value

Authorized staff can generate one weekly operations report in Discord that combines event activity, conservative attendance totals, and server activity into a single staff-readable summary.

## 4. In scope

- one staff-only slash command: `/analytics weekly-ops-report`
- one configured guild only
- one configured reporting timezone
- one configured staff-only report destination channel
- aggregation from SQLite only; no direct report computation from raw Discord history
- event summary from `events` rows already stored in SQLite
- conservative attendance summary from `attendance.record_kind = aggregate_closeout`
- activity summary from `activity_text_daily` and `activity_voice_daily`
- one persisted report record in SQLite for audit and replay reference
- deterministic Markdown report body posted in Discord to staff only

## 5. Out of scope

- any public or member-visible report delivery
- per-member statistics or member naming
- CSV exports, spreadsheets, or web dashboards
- inferred attendance or attendance backfill when a closeout row is missing
- causal claims such as “event X caused activity Y”
- any LLM-generated narrative in this slice

## 6. Data contract and report contents

### Required upstream data

- complete text snapshots for all 7 dates in the requested week from Slice A2
- deterministic daily voice aggregates from Slice A1
- `events` rows with persisted schedule/state data from prior event slices
- `attendance` rows from `docs/exec-plans/active/post-m0-language-club-attendance-closeout-slice.md`

If any day in the requested week is missing text snapshots, the command must reject and list the missing dates instead of publishing a partial report.

### `weekly_ops_reports`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `week_start_date` TEXT NOT NULL
- `week_end_date` TEXT NOT NULL
- `timezone` TEXT NOT NULL
- `generated_by_discord_user_id` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `destination_channel_id` TEXT NOT NULL
- `destination_message_id` TEXT NOT NULL
- `published_event_count` INTEGER NOT NULL
- `closed_out_event_count` INTEGER NOT NULL
- `recorded_attendance_total` INTEGER NOT NULL
- `total_text_messages` INTEGER NOT NULL
- `total_voice_minutes` INTEGER NOT NULL
- `distinct_active_members` INTEGER NOT NULL
- `report_markdown` TEXT NOT NULL
- `generated_at` TEXT NOT NULL
- UNIQUE (`guild_id`, `week_start_date`)

### Minimum report sections

- reporting week window and timezone
- published event count for the week
- published event count by `event_type` if more than one exists
- published event count by `approval_class` if more than one exists
- closed-out event count for the week
- conservative recorded attendance total from stored `aggregate_closeout` rows only
- total text messages for the week
- total voice connected minutes for the week
- distinct active members across text or voice for the week
- top 3 text channels by aggregate message count
- top 3 voice channels by aggregate voice minutes
- one explicit note that the report is aggregate-only, staff-only, and uses stored attendance rather than inferred attendance

## 7. Privacy boundaries

- report output is aggregate-only
- no member names, member IDs, rankings, or per-member counts appear in the weekly report
- report is posted only to the configured staff-only destination channel
- command acknowledgement may be ephemeral, but the shared report body stays in the staff-only report channel
- if destination channel or authorization is ambiguous, no report is posted

## 8. Discord command and delivery surface

### Slash command

`/analytics weekly-ops-report`

Inputs:

- `week_start` — `YYYY-MM-DD`, must be the Monday of the requested reporting week

Behavior:

- guild-only; not valid in DMs
- allowed only in configured staff analytics command channels
- actor must hold `analytics_viewer_role_ids` or `analytics_member_viewer_role_ids`
- reads only from SQLite activity tables, SQLite event records, and SQLite attendance records
- posts exactly one report message to the configured staff-only report channel
- replies ephemerally to the actor with report success or exact rejection reason

## 9. Dependencies and sequencing

- hard dependency: `docs/exec-plans/active/post-m0-discord-voice-session-capture-slice.md`
- hard dependency: `docs/exec-plans/active/post-m0-discord-activity-daily-snapshots-slice.md`
- hard dependency: `docs/exec-plans/active/post-m0-language-club-attendance-closeout-slice.md`
- should land before Slice A4 drilldown so weekly reporting becomes the default shared analytics view

## 10. Acceptance criteria

- startup fails fast if report destination channel, staff command channel IDs, timezone, or analytics role IDs are missing
- database migration creates `weekly_ops_reports` with the stated uniqueness rule
- command rejects if `week_start` is not a Monday in the configured reporting timezone
- command rejects if any required text snapshot is missing for the requested week
- successful command posts exactly one report message to the configured staff-only report channel
- successful command writes one `weekly_ops_reports` row containing the exact posted Markdown body and totals, including `closed_out_event_count` and `recorded_attendance_total`
- report totals are derived from SQLite and do not require raw Discord history at generation time
- report body contains no per-member data
- no public or DM delivery path exists in this slice

## 11. Validation checklist

- verify a week with zero published events still reports `published_event_count = 0`
- verify a week with snapshots but no activity reports zero totals cleanly
- verify a week with no closeout rows reports `recorded_attendance_total = 0` without inferring attendance
- verify duplicate generation for the same `guild_id + week_start_date` is rejected or explicitly handled before implementation; default is reject in this slice
- verify top-channel sections exclude channels outside the analytics allowlist
- verify the posted report matches the persisted `report_markdown`
- verify report generation never exposes member IDs in the shared channel output

## 12. Required configuration to lock before implementation

- Discord guild ID for analytics
- reporting timezone
- staff analytics command channel IDs
- staff-only weekly report destination channel ID
- `analytics_viewer_role_ids`
- `analytics_member_viewer_role_ids`
- final weekly week-start rule: Monday

## 13. Risks and follow-up slice

### Risks

- strict “all 7 days present” gating may delay report generation when a text snapshot day is missed
- aggregate-only reporting is safer, but it may push staff toward follow-up requests for detail
- one destination channel keeps privacy tight but reduces distribution flexibility

### Follow-up slice

Add staff-only drilldown over the same SQLite analytics tables, with explicit authorization separation between aggregate and per-member access.
