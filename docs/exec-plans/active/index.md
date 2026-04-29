# Active Execution Plans

Recommended execution order:

1. `milestone-0-foundation-and-bot-skeleton.md` — bootstrap the Discord runtime, SQLite foundation, and job runner skeleton.
2. `post-m0-seeded-language-club-publish-slice.md` — deliver the first routine event create-and-publish path with durable event policy fields.
3. `post-e2-language-club-assigned-reminders-slice.md` — add explicit Language Club assignment plus club-aware reminder scheduling and delivery.
4. `post-m0-language-club-attendance-closeout-slice.md` — add conservative aggregate attendance closeout for published Language Club events.
5. `post-m0-discord-voice-session-capture-slice.md` — make voice analytics feasible with live allowlisted session capture and daily voice aggregates.
6. `post-m0-discord-activity-daily-snapshots-slice.md` — add on-demand text-only daily snapshots for allowlisted text channels.
7. `post-m0-staff-weekly-ops-report-slice.md` — generate one staff-only weekly ops report from SQLite event, attendance, text, and voice data.
8. `post-m0-staff-analytics-drilldown-slice.md` — add staff-only ephemeral channel/member analytics drilldown with audit logging.
9. `post-m0-language-club-coverage-and-nudges-slice.md` — store Language Club coverage assignments and send internal nudges.
10. `post-m0-regional-sharing-routine-publish-slice.md` — widen routine event publishing to constrained Regional Sharing flows.
11. `post-m0-cerita-aja-dulu-approval-request-slice.md` — add approval-request creation for approval-required Cerita Aja Dulu events.
12. `post-m0-cerita-aja-dulu-approved-publish-slice.md` — add approver review plus audited publish execution for Cerita Aja Dulu.

Intentionally not yet planned as active build slices:

- content queue generation and approval execution
- knowledge assistant and cited staff-support answer flows
- admin web UI
- external sync execution for Google Calendar, Google Sheets, or other integrations
