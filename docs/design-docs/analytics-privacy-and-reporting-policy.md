# Analytics Privacy And Reporting Policy

## Purpose

Lock the minimum privacy, authorization, and reporting rules for staff-facing analytics before any analytics implementation begins.

This policy applies to Discord activity snapshots, weekly staff reports, and staff analytics drilldowns.

## Core policy

- SQLite is the source of truth for analytics state, snapshots, report records, and access audit records.
- Analytics are for internal operations support, not public gamification or member ranking.
- Staff-only is the default visibility level for all analytics surfaces.
- Data collection and reporting should be minimal, deterministic, and explainable.

## Staff-only visibility policy

- All analytics commands, reports, and drilldowns are staff-facing only.
- No analytics output may be posted in public channels, community announcement channels, or member-visible threads.
- Aggregate reports are allowed only in configured staff report destinations.
- Per-member analytics are desirable in V1 for operations follow-up, but they remain staff-restricted at all times.

## Allowed Discord roles and surfaces

### Role tiers

- `analytics_viewer_role_ids`
  - may run aggregate analytics commands
  - may view weekly ops reports
  - may request channel-level aggregate drilldowns
- `analytics_member_viewer_role_ids`
  - includes all aggregate access above
  - may request per-member drilldowns
  - should be narrower than general staff when possible

### Allowed surfaces

- staff-only slash commands in configured staff channels
- ephemeral slash-command responses to authorized staff
- one or more configured staff-only report channels
- staff-only report threads created under those staff report channels if explicitly configured later

### Disallowed surfaces

- public channels
- member-visible forum posts or threads
- DMs as a reporting destination
- external dashboards or web UIs in V1

## Metric categories

Allowed V1 metric categories:

- event operations aggregates
  - published event count
  - event classification count
  - event state totals relevant to staff operations
- Discord activity aggregates
  - text message count
  - voice connected minutes
  - voice session count
  - distinct active members
- channel-level aggregates
  - per-channel text totals
  - per-channel voice totals
  - per-channel distinct active members
- member-level operational metrics
  - per-member text totals
  - per-member voice totals
  - per-member active-day counts
  - per-member per-channel totals when a staff drilldown is explicitly authorized
- system audit metrics
  - snapshot run status
  - report generation status
  - analytics access audit records

Disallowed V1 metric categories:

- message content analytics
- sentiment or behavioral scoring
- migration-risk or moderation-risk scoring
- inferred demographics or sensitive profiling
- public leaderboards or member ranking boards

## Per-member restrictions

- Per-member analytics are allowed only for authorized staff with `analytics_member_viewer_role_ids`.
- Per-member analytics must be limited to operational counts and durations.
- Per-member analytics must not include message content, attachments, links, transcripts, or quoted messages.
- Per-member analytics must not be posted to shared channels; they are ephemeral-only.
- Weekly staff reports must stay aggregate-only and must not name or rank individual members.
- Per-member analytics should be used for follow-up, staffing, and event support, not for punitive automation.

## Report destinations

- Aggregate weekly reports may be posted only to configured staff-only Discord report channels.
- Aggregate report acknowledgements may also be returned ephemerally to the requesting staff actor.
- Per-member and targeted drilldown results must be returned ephemerally only.
- No V1 report export destination exists outside Discord staff surfaces and SQLite storage.

## Retention and minimization expectations

- Collect only daily snapshots, not raw message logs or raw voice session timelines.
- Use a configured allowlist of eligible Discord channels for analytics collection.
- Exclude DMs, group DMs, and any channel not explicitly included for analytics.
- Retain `activity_text_daily` and `activity_voice_daily` for 180 days by default.
- Retain generated weekly report records for 180 days by default.
- Retain analytics access audit records for 365 days by default.
- Do not store message bodies, attachment filenames, voice recordings, or transcripts in analytics tables.
- Do not retain duplicate derived outputs when the same fact already exists in a source snapshot table.

## Export restrictions

- No CSV, spreadsheet, API, or bulk export feature is in scope for V1.
- No automated forwarding of analytics outputs to public or mixed-visibility channels is allowed.
- If staff manually copy data outside the bot, that is outside product support and should be treated as a human-controlled action.

## LLM usage boundaries

- LLMs may summarize already-authorized aggregate analytics for staff-facing Discord output.
- LLMs may help draft weekly narrative summaries from authorized aggregate metrics.
- LLMs must not decide authorization, role access, or data scope.
- LLMs must not receive raw message content because analytics collection does not store it.
- LLM use for per-member analytics should be avoided in V1; deterministic formatting is preferred.
- If an LLM is used at all, pass only the minimum authorized metrics needed for that response.
- Analytics data must not be treated as long-term LLM memory or training material.

## Safe default behavior when access is ambiguous

- If role access is ambiguous, deny the request.
- If the command surface is ambiguous, deny the request.
- If the destination channel is ambiguous, do not post a report.
- If channel analytics scope is not configured, do not collect or report analytics.
- If a user requests per-member data without the member-level role, deny the request instead of downgrading silently.
- When in doubt, return no analytics data and ask for staff configuration review.
