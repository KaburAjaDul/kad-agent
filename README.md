# KAD-Agent

Discord agent for Kabur Aja Dulu community.

Current direction:

- semi-autonomous community operations copilot
- event operations first
- analytics and reporting second
- content queue drafting third
- staff-facing knowledge support from curated Markdown docs only

The repository is set up to use repo-local OpenCode orchestration with:

- `build` for reviewed implementation work
- `research` for product, architecture, policy, and planning work

Start in `docs/product-specs/kad-agent.md` and `docs/exec-plans/active/milestone-0-foundation-and-bot-skeleton.md`.

## Event Slice E1 local/live validation

- Use Node 24+ (or another Node release that includes `node:sqlite`).
- Copy `.env.example` to `.env` and fill the runtime basics only: `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, plus any preferred `DATABASE_PATH` / log settings.
- Keep `BOT_DRY_RUN=true` for DB-only smoke checks. Before live Discord validation, set `BOT_DRY_RUN=false`. `npm run start` and `npm run register-commands` now refuse to run live steps while dry-run is still enabled.
- Install dependencies: `npm install`
- Initialize SQLite: `npm run db:init`
- Register slash commands in the target guild explicitly: `npm run register-commands -- --guild-id <discord-guild-snowflake>`
- Start the bot runtime: `npm run start`
- In Discord, as a guild admin, run `/setup e1-configure` and set the announcement channel, host voice channel, timezone, and at least one staff role.
- Optionally confirm with `/setup e1-show`.
- Then run `/event create-language-club` with a `date` (`YYYY-MM-DD`) and `time` (`HH:mm`).

Success looks like this:

- Discord: the command returns an ephemeral success reply like `Event berhasil dibuat dan dipublish...`, and the configured announcement channel receives the Language Club announcement message.
- SQLite: `language_club_guild_config` and `language_club_staff_roles` contain the guild setup, and the latest `events` row is `state=published` with the configured announcement/voice channel IDs and a non-empty `discord_announcement_message_id`; `event_state_transitions` records `drafted` then `published` for the same `event_id`.

Example SQLite spot checks with built-in Node SQLite:

- `node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('./data/kad-agent.sqlite'); console.log(db.prepare('SELECT id, state, announcement_channel_id, host_voice_channel_id, discord_announcement_message_id FROM events ORDER BY created_at DESC LIMIT 1').get()); db.close();"`
- `node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('./data/kad-agent.sqlite'); console.log(db.prepare('SELECT event_id, from_state, to_state FROM event_state_transitions ORDER BY occurred_at DESC LIMIT 2').all()); db.close();"`
