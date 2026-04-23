# Bot Architecture

## Shape

KAD-Agent is a Discord-first bot with deterministic workflow state and optional LLM-assisted drafting.

Operational truth lives in SQLite.

## Top-Level Components

- Discord command surface
- background job and reminder runner
- SQLite data store
- event workflow engine
- analytics pipeline
- content queue generator
- knowledge retrieval over curated Markdown docs
- Google Sheets and Google Calendar integrations

## Domains

### `events`

- event templates
- event creation rules
- reminder plans
- attendance and wrap-up flow

### `volunteers`

- volunteer request flow
- role coverage tracking
- conversation partner assignment

### `analytics`

- text activity aggregation
- voice activity aggregation
- event and member reporting

### `content`

- draft queue generation
- social-draft lifecycle
- approval state before publishing

### `knowledge`

- doc indexing
- source retrieval
- answer composition with citations

### `discord`

- slash commands
- interaction handlers
- channel and role adapters

### `integrations`

- Google Sheets sync
- Google Calendar sync

## Source Of Truth Rules

- workflow state: SQLite
- trusted guidance: Markdown under `docs/knowledge/`
- approval state: SQLite
- scheduled reminders: SQLite-backed jobs
- LLM output: drafts only unless explicitly approved and grounded

## Data Model Direction

Initial tables should likely include:

- `guilds`
- `channels`
- `roles`
- `members`
- `events`
- `event_templates`
- `event_roles`
- `event_assignments`
- `event_reminders`
- `attendance`
- `activity_text_daily`
- `activity_voice_daily`
- `content_queue`
- `knowledge_documents`
- `approval_requests`
- `job_runs`

## Interface Boundaries

- Discord API access goes through domain repo or provider boundaries
- Google integrations go through dedicated integration adapters
- LLM access goes through a provider abstraction
- service layers own policy, approval, and automation rules
