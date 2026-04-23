# KAD-Agent Product Spec

## Summary

KAD-Agent is a semi-autonomous Discord operations copilot for the Kabur Aja Dulu community.

Its job is to reduce manual labor around:

- event creation and coordination
- volunteer and conversation partner reminders
- activity measurement and reporting
- content queue drafting from community activity
- staff-facing guidance from curated internal docs

Humans should spend more time making the server alive and less time pushing operational buttons.

## Community Context

Kabur Aja Dulu is an Indonesian Discord-based community that helps Indonesian workers migrate to another country as a skilled worker or through education.

The community runs:

- `Cerita Aja Dulu`: diaspora speaker stage events
- language club events in voice channels
- regional sharing events that gather diaspora and activate region-specific channels

The server includes:

- admins
- moderators / volunteers
- conversation partners
- general members
- channels organized by region, language, interests, and community needs

## Goals

1. Reduce operational burden for admins and volunteers.
2. Automate routine event and reminder work safely.
3. Give staff clear visibility into community health.
4. Turn community activity into a usable content queue.
5. Keep risky migration and education guidance source-bound and reviewable.

## Non-Goals For V1

- fully autonomous public migration advice
- autonomous public social publishing
- broad member-facing open chat assistant
- complex admin web panel

## Primary Users

- admins and organizers
- moderators / volunteers
- conversation partners
- content team

## V1 Priorities

1. event operations
2. analytics and reporting

Secondary V1 work:

3. content queue drafting
4. staff-facing knowledge support
5. community activation suggestions

## Core Capabilities

### Event Operations

- create event drafts from templates
- create reminder schedules
- request volunteers or conversation partners
- track role coverage
- send pre-event and day-of reminders
- generate post-event wrap-up summaries

### Analytics And Reporting

- text activity summaries
- voice activity summaries
- event participation summaries
- volunteer participation summaries
- per-channel and per-member reporting for staff

### Content Queue Drafting

- turn event summaries into content queue items
- draft ideas for Twitter, Instagram, and TikTok
- push drafts into a queue for human review

### Staff-Facing Knowledge Support

- answer from curated Markdown docs only
- cite source documents
- escalate when confidence is low or the question is risky

## Safety Requirements

- routine events may be automated
- larger events require approval before publication
- public migration and education guidance must come from approved internal docs
- risky or uncertain questions must escalate instead of bluffing
- public social output must go through a queue and approval step
- per-member analytics must be staff-restricted

## Integrations

Planned early integrations:

- Discord scheduled events
- Google Sheets
- Google Calendar

## Tone And Language

- Bahasa Indonesia
- warm
- clear and structured for operational messages

## Success Metrics

- reduced time to create and run events
- reduced missed volunteer coverage
- consistent reminder execution
- weekly reporting generated without manual work
- content queue items generated from event activity
- no unsupported public migration guidance
