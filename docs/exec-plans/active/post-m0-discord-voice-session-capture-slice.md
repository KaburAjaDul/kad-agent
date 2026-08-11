# 1. Title

Post-M0 Analytics Slice A1: Discord Voice Session Capture And Daily Aggregates

## 2. Why this slice

Voice metrics are not feasible from an on-demand daily snapshot alone. This slice makes voice analytics possible by capturing live allowlisted voice session facts into SQLite and rolling them into deterministic daily aggregates without creating any public analytics surface.

It is intentionally narrow:

- one configured guild
- one configured reporting timezone
- one allowlisted set of Discord voice channels
- live Discord voice-state capture only
- SQLite operational session state plus daily voice aggregates only

## 3. User-facing value

Staff gain trustworthy staff-internal daily voice totals in SQLite that later weekly reports and drilldowns can reuse, without exposing any public output in this slice.

## 4. In scope

- capture Discord voice-state changes for one configured guild only
- track only allowlisted voice channels
- persist one active allowlisted voice session per connected member in SQLite
- flush elapsed time from active sessions into `activity_voice_daily`
- increment deterministic per-member per-channel `session_count` when an allowlisted session segment starts
- split open sessions at the configured local midnight boundary so daily rows remain correct by reporting date
- handle allowlisted channel-to-channel moves by closing the old segment and opening a new one
- keep all output staff-internal; no public analytics message, report, or dashboard is created

## 5. Out of scope

- text activity capture, which belongs to Slice A2
- weekly reports, drilldowns, or any visible analytics command output
- message content, voice recordings, transcripts, or speaker attribution beyond member/channel IDs and aggregate counts
- DMs, group DMs, stage channels, or non-allowlisted voice channels
- exports, dashboards, or web UI
- LLM summarization or narrative generation

## 6. Dependencies

- Milestone 0 bot/runtime/database foundation
- configured Discord gateway voice-state access for the target guild
- configured analytics privacy policy from `docs/design-docs/analytics-privacy-and-reporting-policy.md`

## 7. Deterministic capture model

### Non-persisted result

- `ignored` — a Discord voice-state change produces no analytics write

Ignored cases in this slice:

- event is outside the configured guild
- source and target channels are both outside the allowlist
- the state change carries no allowlisted session impact

### Active-session rules

- at most one open allowlisted voice session exists per `guild_id + member_discord_user_id`
- entering an allowlisted voice channel opens a new active session row and increments the target daily row’s `session_count`
- leaving an allowlisted voice channel flushes elapsed minutes into the matching daily row and removes the active session row
- moving between allowlisted voice channels flushes the old channel segment, then opens a new segment for the new channel
- crossing the configured local midnight boundary flushes minutes to the old `activity_date`, then carries the session forward into a new active row segment for the new date
- if runtime recovery finds stale open sessions after restart, the system must close them conservatively at recovery time rather than fabricate missing downtime minutes

## 8. Minimum schema additions/contract

### Storage conventions

- internal IDs are `TEXT` and generated as UUIDv7
- Discord IDs are stored as raw snowflake strings in `TEXT`
- timestamps are stored as UTC ISO 8601 strings in `TEXT`
- `activity_date` is stored as `YYYY-MM-DD` in the configured reporting timezone

### `voice_active_sessions`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `member_discord_user_id` TEXT NOT NULL
- `started_at` TEXT NOT NULL
- `last_transition_at` TEXT NOT NULL
- `activity_date` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- UNIQUE (`guild_id`, `member_discord_user_id`)

### `activity_voice_daily`

- `id` TEXT PRIMARY KEY
- `guild_id` TEXT NOT NULL
- `activity_date` TEXT NOT NULL
- `timezone` TEXT NOT NULL
- `channel_id` TEXT NOT NULL
- `member_discord_user_id` TEXT NOT NULL
- `connected_minutes` INTEGER NOT NULL
- `session_count` INTEGER NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- UNIQUE (`guild_id`, `activity_date`, `channel_id`, `member_discord_user_id`)

## 9. Discord/runtime surface

No new slash command is required in this slice.

Runtime triggers:

- Discord voice-state updates
- local-midnight rollover handling for open sessions
- startup recovery pass for stale open sessions if the process restarted

Behavior:

- Discord adapters collect raw voice-state transitions and pass normalized facts into the analytics service
- service decides whether the change affects allowlisted session state
- service owns session open/close logic and daily aggregate writes
- this slice produces no shared Discord message output

## 10. Privacy boundaries

- capture is limited to configured allowlisted voice channels only
- no analytics collection occurs for DMs, group DMs, or channels outside the allowlist
- no voice recordings, transcripts, or content-like payloads are stored
- stored facts are limited to member/channel identifiers, timestamps needed for active session tracking, and aggregate counts and durations
- this slice creates no public Discord output and no member-visible analytics output

## 11. Acceptance criteria

- startup fails fast if guild ID, reporting timezone, or allowlisted voice channel config is missing
- database migration creates `voice_active_sessions` and `activity_voice_daily`
- entering an allowlisted voice channel creates one active session row and increments the correct daily `session_count`
- leaving an allowlisted voice channel removes the active session row and updates the correct daily `connected_minutes`
- moving between allowlisted voice channels closes the prior segment and opens the next segment without double-counting minutes
- crossing the reporting-date boundary splits minutes across the correct two `activity_voice_daily` dates
- non-allowlisted voice activity produces no analytics rows
- no public channels receive output from this slice

## 12. Validation checklist

- verify only one active session row exists per guild/member at a time
- verify repeated leave or duplicate terminal transitions do not double-count minutes
- verify channel-to-channel moves write minutes to the old channel and increment `session_count` for the new channel
- verify midnight rollover splits the same continuous session across two dates correctly
- verify runtime recovery closes stale open rows conservatively instead of fabricating minutes
- verify no transcript-like or content-like fields exist in the schema

## 13. Required configuration to lock before implementation

- Discord guild ID for analytics
- reporting timezone
- allowlisted voice channel IDs
- expected behavior for conservative recovery after runtime restart

## 14. Risks and follow-up slice

### Risks

- conservative restart handling may undercount voice minutes during downtime
- channel allowlists require deliberate maintenance as the server evolves
- midnight rollover logic is easy to get subtly wrong if timezone rules are not locked clearly

### Follow-up slice

Add on-demand text-only daily snapshots so weekly reports and drilldowns can combine deterministic text and voice metrics.
