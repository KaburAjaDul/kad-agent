# 1. Title

Post-M0 Analytics Slice A2: Discord Text Activity Daily Snapshots

## 2. Why this slice

This is the smallest safe text-analytics foundation after Milestone 0 and after live voice capture is defined separately in Slice A1.

It is intentionally narrow:

- one staff-only slash command
- one configured guild
- one configured reporting timezone
- one allowlisted set of Discord text channels
- SQLite daily text snapshots only

## 3. User-facing value

Authorized staff can capture one closed day of Discord text activity into SQLite and get stable daily message counts that later slices can reuse for weekly reporting and drilldown.

## 4. In scope

- one staff-only slash command: `/analytics snapshot-daily`
- one configured guild only
- one reporting date input in `YYYY-MM-DD`
- one configured reporting timezone used for daily boundaries
- collection from configured allowlisted guild text channels only
- SQLite persistence of daily text snapshots at the minimum supported grain
- per-run status tracking in SQLite
- idempotent recompute for the same `guild_id + activity_date` by replacing prior text snapshot rows for that day inside one transaction
- ephemeral Discord success or failure response to the requesting staff actor

## 5. Out of scope

- voice capture or voice daily aggregation, which belong to Slice A1
- scheduled automation or cron execution
- today or future-date snapshots
- public reports or public analytics commands
- exports, dashboards, or web UI
- message content, attachments, links, reactions, threads, forums, stages, or DMs
- attendance inference or event-performance interpretation
- any LLM formatting or narrative generation

## 6. Minimum grain and schema contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`
- `activity_date` is stored as `YYYY-MM-DD` in the configured reporting timezone

### Minimum supported grain

- text grain: one row per `guild_id + activity_date + channel_id + member_discord_user_id`
- no message-level raw records are persisted

### `analytics_snapshot_runs`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `activity_date` TEXT NOT NULL
- `timezone` TEXT NOT NULL
- `requested_by_discord_user_id` TEXT NOT NULL
- `source_interaction_id` TEXT NOT NULL
- `status` TEXT NOT NULL
- `text_rows_written` INTEGER NOT NULL DEFAULT 0
- `total_messages` INTEGER NOT NULL DEFAULT 0
- `started_at` TEXT NOT NULL
- `finished_at` TEXT NULL
- `error` TEXT NULL

Allowed `status` values:

- `running`
- `succeeded`
- `failed`

### `activity_text_daily`

- `id` TEXT PRIMARY KEY
- `snapshot_run_id` TEXT NOT NULL
- `guild_id` TEXT NOT NULL
- `activity_date` TEXT NOT NULL
- `timezone` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `member_discord_user_id` TEXT NOT NULL
- `message_count` INTEGER NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- FOREIGN KEY (`snapshot_run_id`) REFERENCES `analytics_snapshot_runs`(`id`)
- UNIQUE (`guild_id`, `activity_date`, `channel_id`, `member_discord_user_id`)

## 7. Privacy boundaries

- collection is limited to configured allowlisted text channels only
- no analytics collection occurs for DMs, group DMs, or channels outside the allowlist
- no message content, attachment metadata, message links, or transcripts are stored
- per-member rows may exist in SQLite for staff analytics, but they are not surfaced publicly by this slice
- this slice creates no public Discord output and no member-visible analytics output

## 8. Discord command surface

### Slash command

`/analytics snapshot-daily`

Inputs:

- `date` — `YYYY-MM-DD`

Behavior:

- guild-only; not valid in DMs
- allowed only in configured staff analytics command channels
- actor must hold `analytics_viewer_role_ids` or `analytics_member_viewer_role_ids`
- `date` must be earlier than the current date in the configured reporting timezone
- command recomputes the full day and replaces prior text snapshot rows for that date in one transaction
- response is ephemeral and includes run status plus total messages written

## 9. Dependencies and sequencing

- depends on Milestone 0 bot/runtime/database foundation
- recommended after `docs/exec-plans/active/post-m0-discord-voice-session-capture-slice.md` so voice feasibility lands first
- should land before Slice A3 weekly reporting and Slice A4 drilldown

## 10. Acceptance criteria

- startup fails fast if guild ID, reporting timezone, staff command channel IDs, analytics role IDs, or text channel allowlists are missing
- database migration creates `analytics_snapshot_runs` and `activity_text_daily`
- successful command writes one `analytics_snapshot_runs` row and the corresponding daily text snapshot rows
- rerunning the same date replaces prior snapshot rows for that `guild_id + activity_date`
- text snapshots store only counts, not content
- unauthorized actors receive an ephemeral rejection and no snapshot rows are changed
- invocation outside configured staff channels is rejected
- public channels receive no output from this slice

## 11. Validation checklist

- verify today and future dates are rejected
- verify non-allowlisted channels contribute no rows
- verify successful rerun changes the latest `snapshot_run_id` on replaced rows
- verify duplicate natural keys do not exist in `activity_text_daily`
- verify total message counts in the ephemeral response match persisted totals
- verify failed runs keep the error on `analytics_snapshot_runs`
- verify no message bodies or transcript-like fields exist in the schema

## 12. Required configuration to lock before implementation

- Discord guild ID for analytics
- reporting timezone
- staff analytics command channel IDs
- `analytics_viewer_role_ids`
- `analytics_member_viewer_role_ids`
- allowlisted text channel IDs

## 13. Risks and follow-up slice

### Risks

- channel allowlists require deliberate maintenance as the server evolves
- manual command execution does not guarantee weekly coverage until automation or operational habit exists
- text-only snapshots still rely on staff discipline to backfill missed days

### Follow-up slice

Use these daily text snapshots plus Slice A1 voice aggregates and existing event records to generate one staff-only weekly ops report in Discord.
