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

- Use Node 24 (the supported engine; it includes `node:sqlite`).
- Install dependencies reproducibly: `npm ci`
- Keep `.env` out of version control. `.env.example` documents key names only; inject runtime values through the process environment or a secret manager.
- For a safe local smoke, set only `BOT_DRY_RUN=true` (and optionally `DATABASE_PATH`) or run `npm run start:dry-run`. This initializes the local SQLite schema, seeds foundation data, and runs one reminder sweep without Discord credentials or network calls.
- Before live Discord validation, set `BOT_DRY_RUN=false` and inject the required logical keys `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_ALLOWED_GUILD_IDS`. The guild allowlist is a comma-separated list of Discord snowflakes. `npm run start` and `npm run register-commands` refuse live use without these controls.
- Publication observe/active mode additionally requires one target guild. Set either `DISCORD_TARGET_GUILD_ID` or `DISCORD_TARGET_GUILD_ID_FILE`, never both. A file-backed target may reuse `DISCORD_ALLOWED_GUILD_IDS_FILE` only when that protected file contains exactly one guild ID; `DISCORD_TARGET_GUILD_NAME` remains non-secret configuration.
- Initialize SQLite: `npm run db:init`
- Register slash commands in the target guild explicitly: `npm run register-commands -- --guild-id <discord-guild-snowflake>`
- Start the bot runtime: `npm run start`
- In Discord, as a guild admin, run `/setup e1-configure` and set the announcement channel, host voice channel, timezone, and at least one staff role.
- Optionally confirm with `/setup e1-show`.
- Then run `/event create-language-club` with a `date` (`YYYY-MM-DD`) and `time` (`HH:mm`).

Success looks like this:

- Discord: the command returns an ephemeral success reply like `Event berhasil dibuat dan dipublish...`, and the configured announcement channel receives the Language Club announcement message.
- SQLite: `language_club_guild_config` and `language_club_staff_roles` contain the guild setup, and the latest `events` row is `state=published` with the configured announcement/voice channel IDs and a non-empty `discord_announcement_message_id`; `event_state_transitions` records `drafted` then `published` for the same `event_id`.

## Build and CI checks

The production build emits compiled JavaScript and declarations under `dist/`:

```sh
npm run typecheck
npm test
npm run build
npm run audit
npm run start:dry-run
```

The CI workflow runs those checks and a container build with Node 24 and `npm ci`, using only the `contents: read` permission and no repository secrets.

## Container usage

The multi-stage image compiles the app from lockfile-resolved dependencies on
the supported Node 24 major and runs it as the unprivileged numeric identity
`10001:10001`, matching the homelab volume and secret ownership contract.
`/data` is a persistent volume, and the compiled entrypoint is
`/nodejs/bin/node dist/index.js`. The final distroless runtime base is pinned by
digest and contains no npm, shell, or package manager. The two build-only
stages intentionally track the supported `node:24-bookworm-slim` major and do
not ship in the release image; rotating either builder tag or runtime digest is
an explicit release-maintenance task.

```sh
docker build -t <image-name>:<tag> .
docker volume create <volume-name>
docker run --rm --init \
  --env BOT_DRY_RUN=true \
  --mount type=volume,src=<volume-name>,dst=/data \
  <image-name>:<tag> --dry-run
```

For a live runtime, inject `BOT_DRY_RUN=false`, `DISCORD_APP_ID=<discord-app-id>`, `DISCORD_BOT_TOKEN=<discord-bot-token>`, and `DISCORD_ALLOWED_GUILD_IDS=<discord-guild-id>` at runtime and keep the same `/data` volume. Replace placeholders before executing; do not put secret values in this README, the image, or a committed `.env` file.

```sh
docker run --rm --init \
  --env BOT_DRY_RUN=false \
  --env DISCORD_APP_ID=<discord-app-id> \
  --env DISCORD_BOT_TOKEN=<discord-bot-token> \
  --env DISCORD_ALLOWED_GUILD_IDS=<discord-guild-id> \
  --mount type=volume,src=<volume-name>,dst=/data \
  <image-name>:<tag>
```

The container health check calls `/readyz` over loopback. It turns healthy only
after migrations, seeds, and the Discord login have completed. `/healthz`
reports process liveness but does not assert Discord readiness.

Do not dump the SQLite database into CI logs or support tickets. Use the
automated repository tests for state-transition checks and a scoped,
access-controlled operator procedure for any production inspection.
