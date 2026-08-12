# Active Execution Plans

Recommended execution order:

0. `kaddy-24x7-homelab-program.md` — establish the one-runtime homelab ownership, lease, observability, and cutover gates.
1. `kaddy-e2e-foundation.md` — establish the private-authority, public-projection, and rollback contract before implementation slices.
2. `milestone-0-foundation-and-bot-skeleton.md` — bootstrap the Discord runtime, SQLite foundation, and job runner skeleton.
3. `post-m0-seeded-language-club-publish-slice.md` — deliver the first routine event create-and-publish path with durable event policy fields.
4. `post-e2-language-club-assigned-reminders-slice.md` — add explicit Language Club assignment plus club-aware reminder scheduling and delivery.
5. `post-m0-language-club-attendance-closeout-slice.md` — add conservative aggregate attendance closeout for published Language Club events.
6. `post-m0-discord-voice-session-capture-slice.md` — make voice analytics feasible with live allowlisted session capture and daily voice aggregates.
7. `post-m0-discord-activity-daily-snapshots-slice.md` — add on-demand text-only daily snapshots for allowlisted text channels.
8. `post-m0-staff-weekly-ops-report-slice.md` — generate one staff-only weekly ops report from SQLite event, attendance, text, and voice data.
9. `post-m0-staff-analytics-drilldown-slice.md` — add staff-only ephemeral channel/member analytics drilldown with audit logging.
10. `post-m0-language-club-coverage-and-nudges-slice.md` — store Language Club coverage assignments and send internal nudges.
11. `post-m0-regional-sharing-routine-publish-slice.md` — widen routine event publishing to constrained Regional Sharing flows.
12. `post-m0-cerita-aja-dulu-approval-request-slice.md` — add approval-request creation for approval-required Cerita Aja Dulu events.
13. `post-m0-cerita-aja-dulu-approved-publish-slice.md` — add approver review plus audited publish execution for Cerita Aja Dulu.

Intentionally not yet planned as active build slices:

- content queue generation and approval execution
- knowledge assistant and cited staff-support answer flows
- admin web UI
- external sync execution for Google Calendar, Google Sheets, or other integrations
