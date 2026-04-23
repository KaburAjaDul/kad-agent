# Initiation Prompt

Use this as the first orchestration prompt in `KAD-Agent`.

```text
We are defining KAD-Agent for Kabur Aja Dulu, an Indonesian Discord community that helps Indonesian workers migrate abroad as skilled workers or through education.

The bot is a semi-autonomous community operations copilot.

Primary V1 priorities:
1. Event operations
2. Analytics and reporting

Secondary priorities:
3. Community activation support
4. Content queue drafting
5. Staff-facing knowledge assistant

Event types:
- Big events
- Cerita Aja Dulu: stage-based event with Indonesian diaspora speakers sharing experience
- Language Club: members join language voice channels and learn foreign languages
- Regional Sharing: gather diaspora by region, encourage interaction with members, and activate regional channels

Roles and participants:
- Admins
- Moderators / volunteers
- Conversation partners
- Members
- Channels are organized by region, language, interests, and other community needs

Trusted knowledge policy:
- curated internal Markdown docs only
- SQLite is acceptable
- public migration/education advice must be treated as high-risk

Autonomy policy:
- routine events can be created automatically
- larger events require approval
- social outputs should go into a queue
- public publishing should not be autonomous in V1

Integrations wanted soon:
- Discord scheduled events
- Google Sheets
- Google Calendar

Language and tone:
- Bahasa Indonesia
- warm

Please review the existing docs in this repo and refine, challenge, or strengthen them where needed.

Then produce the next implementation-ready slice after Milestone 0, focusing on the smallest useful event-operations foundation.

The architecture should assume:
- pure Discord bot first
- small admin web panel later is fine
- deterministic workflow engine + SQLite source of truth
- local LLM can be used for summaries/drafts, but not as the workflow source of truth
- per-member stats are desirable in V1 but must be staff-restricted
```
