# Post-M0 Event Slice E1: Discord-Backed Operational Config Setup

## 1. Objective

Make Event Slice E1 live-setup possible from Discord by moving guild-specific operational config out of env and into SQLite, while keeping bot secrets in env.

Current pain point to remove:

- live validation still depends on `DISCORD_GUILD_ID`
- live validation still depends on `DISCORD_EVENT_ANNOUNCEMENT_CHANNEL_ID`
- live validation still depends on `DISCORD_LANGUAGE_CLUB_HOST_VOICE_CHANNEL_ID`
- live validation still depends on `LANGUAGE_CLUB_DEFAULT_TIMEZONE`
- live validation still depends on `LANGUAGE_CLUB_STAFF_ROLE_IDS`

## 2. Why this is the smallest safe slice

This slice stays narrowly focused on one already-existing workflow:

- one event path: E1 seeded Language Club create-and-publish
- one persistence target: SQLite
- one setup surface: Discord slash commands
- one authorization boundary for setup: guild admin only
- one runtime behavior change: resolve E1 config from DB instead of env

It avoids overbuilding a generic settings framework, web UI, or multi-domain admin layer.

## 3. Recommended scope

- add one SQLite-backed per-guild E1 config record
- add one SQLite-backed per-guild E1 staff-role mapping table
- add one admin-only Discord setup command to upsert E1 config for the current guild
- add one admin-only Discord status command to show whether E1 is configured for the current guild
- remove the startup and command-registration dependency on env-backed E1 guild/channel/role/timezone values
- make `/event create-language-club` load config by `interaction.guildId` from SQLite
- keep all existing E1 event policy and publish behavior unchanged after config is resolved
- update `.env.example` and README so only bot/runtime secrets remain env-backed for live use

## 4. Explicit non-goals

- no generic cross-domain settings framework
- no admin web panel
- no modal or multi-step setup wizard
- no config history/version browser
- no bulk multi-guild rollout tooling
- no env-to-DB import script requirement
- no change to E1 event policy, seeded template policy, approval class, or publish semantics
- no widening to Regional Sharing, Cerita Aja Dulu, analytics config, or knowledge config

## 5. Command surface

Recommended minimum command surface:

### `/setup e1-configure`

Inputs:

- `announcement_channel` — required channel option
- `host_voice_channel` — required channel option
- `timezone` — required string option
- `staff_role_1` — required role option
- `staff_role_2` — optional role option
- `staff_role_3` — optional role option
- `staff_role_4` — optional role option
- `staff_role_5` — optional role option

Behavior:

- guild-only; never valid in DMs
- admin-only
- infers `guild_id` from the current interaction; user never types a guild ID
- validates all inputs before writing
- upserts one config row for the current guild
- replaces the stored E1 staff-role set for the current guild with the submitted set
- replies ephemerally with the stored summary

### `/setup e1-show`

Behavior:

- guild-only; never valid in DMs
- admin-only
- returns whether E1 is configured for the current guild
- returns the stored announcement channel, host voice channel, timezone, and allowed staff roles
- replies ephemerally only

Out of scope for this slice:

- reset/delete command
- test-publish command
- buttons, modals, autocomplete, or guided discovery

## 6. Minimal schema additions

Use a narrow E1-specific schema instead of a generic settings system.

### `language_club_guild_config`

- `guild_id` TEXT PRIMARY KEY
- `announcement_channel_id` TEXT NOT NULL
- `host_voice_channel_id` TEXT NOT NULL
- `default_timezone` TEXT NOT NULL
- `configured_by_discord_user_id` TEXT NOT NULL
- `configured_at` TEXT NOT NULL
- `updated_by_discord_user_id` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

Notes:

- one row means E1 is configured for that guild
- timestamps are UTC ISO 8601 strings
- all Discord snowflakes are stored as raw `TEXT`

### `language_club_staff_roles`

- `guild_id` TEXT NOT NULL
- `discord_role_id` TEXT NOT NULL
- `added_by_discord_user_id` TEXT NOT NULL
- `added_at` TEXT NOT NULL
- PRIMARY KEY (`guild_id`, `discord_role_id`)
- FOREIGN KEY (`guild_id`) REFERENCES `language_club_guild_config`(`guild_id`)

Notes:

- keep staff roles normalized as rows, not comma-separated text and not JSON
- write the full submitted set transactionally on each setup update

## 7. Runtime and registration changes required

This slice is not just a new command. It must also remove the env dependency from the live path.

Required runtime changes:

- `startApplication` must stop failing startup on missing E1 guild/channel/voice/timezone/role env values
- `registerCommands` must stop requiring E1 env config
- `startDiscordRuntime` must not need a preloaded `LanguageClubPublishConfig` from env
- `/event create-language-club` must look up the current guild's E1 config from SQLite at execution time
- missing DB config must return an exact ephemeral rejection and write no event row

Required command-registration rule for live testing:

- keep command registration guild-scoped by explicit CLI input such as `--guild-id <snowflake>`
- fail closed if `--guild-id` is omitted on the live registration path
- do not require that guild ID in env
- do not allow any global registration fallback in this slice

This keeps blast radius small while still removing env as the source of guild-specific operational truth.

## 8. Safety and authorization boundaries

### Setup boundaries

- setup commands are guild-only
- setup commands require Discord `Administrator` permission at command definition and runtime check
- setup commands never accept an arbitrary target guild ID
- setup commands write config only for `interaction.guildId`
- setup commands return ephemeral responses only

### Validation boundaries

- `announcement_channel` must be a sendable in-server text or announcement channel in the same guild
- `host_voice_channel` must be a guild voice or stage channel in the same guild
- `timezone` must be a valid IANA timezone
- at least one staff role is required
- all provided staff roles must belong to the same guild
- duplicate role inputs are deduplicated before persistence

### E1 execution boundaries after setup

- `/event create-language-club` remains guild-only and ephemeral on response
- if no SQLite config exists for the guild, the command hard-rejects before any event persistence
- config changes affect future E1 requests only; they do not mutate existing events
- this slice does not change routine-vs-approval policy; E1 remains the same seeded routine path
- bot secrets are never written to SQLite

### Source-of-truth rule

- after this slice lands, SQLite is the runtime source of truth for E1 guild/channel/voice/timezone/role config
- env must not remain a competing live source for those same values

## 9. What stays in env vs moves to DB

### Stays in env

- `DISCORD_APP_ID`
- `DISCORD_BOT_TOKEN`
- `DATABASE_PATH`
- `BOT_DRY_RUN`
- `JOB_POLL_INTERVAL_MS`
- `NODE_ENV`
- `LOG_LEVEL`

### Moves to SQLite

- `DISCORD_GUILD_ID`
- `DISCORD_EVENT_ANNOUNCEMENT_CHANNEL_ID`
- `DISCORD_LANGUAGE_CLUB_HOST_VOICE_CHANNEL_ID`
- `LANGUAGE_CLUB_DEFAULT_TIMEZONE`
- `LANGUAGE_CLUB_STAFF_ROLE_IDS`

Recommended transition rule:

- do not keep dual-read runtime behavior for these E1 settings after the slice is complete
- if temporary backward compatibility is needed during development, keep it behind a short-lived migration helper, not the durable live path

## 10. Acceptance criteria

- live `npm run register-commands` no longer requires E1 guild/channel/voice/timezone/role env values
- live `npm run start` no longer requires E1 guild/channel/voice/timezone/role env values
- `/setup e1-configure` stores one guild config row plus one-or-more staff role rows transactionally
- `/setup e1-show` returns the stored SQLite-backed values ephemerally
- `/event create-language-club` succeeds using DB-backed E1 config with no env read for guild/channel/voice/timezone/roles
- `/event create-language-club` hard-rejects cleanly when the guild is not configured in SQLite
- existing E1 publish behavior stays unchanged once config is resolved
- `.env.example` and README describe only secrets/runtime env requirements plus the Discord setup step

## 11. Recommended first bounded build slice

Implement only this:

1. migration for `language_club_guild_config` and `language_club_staff_roles`
2. repo methods to upsert/read E1 config by guild ID
3. `/setup e1-configure` and `/setup e1-show`
4. runtime wiring so `/event create-language-club` reads config from SQLite
5. removal of E1 env validation from live startup and command registration
6. README and `.env.example` updates

Do not include reset/delete/history/generic settings work in the first build.

## 12. Should this be built before live testing?

Yes.

Recommendation:

- build this slice before any real E1 live publish testing
- if a tiny immediate smoke check is needed before that, limit it to bot install, token validity, and `/ping`

Why:

- the current env-heavy live path is exactly the behavior being replaced
- otherwise live validation will certify a setup flow that is about to be removed
- startup, registration, and event execution all need to agree on one source of truth before meaningful E1 live testing

## 13. Main risks

- command registration scope can accidentally widen blast radius if the first rollout uses global commands instead of explicit guild scoping
- leaving both env and DB as live config sources would create drift and hard-to-debug authorization mistakes
- weak channel-type validation could allow invalid publish targets or voice targets into config
- under-scoping setup authorization could let non-admins change operational routing
- fixed-count role options may be slightly constraining for some guilds, but are acceptable for the first bounded slice
