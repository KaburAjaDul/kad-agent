# Milestone 0: Foundation And Bot Skeleton

## Objective

Bootstrap KAD-Agent as a Discord-first operations bot with repo-local orchestration, deterministic workflow state, and the minimum skeleton needed to begin event operations work.

## Scope

- repo-local orchestration setup
- core product and policy docs
- initial Discord bot runtime skeleton
- SQLite foundation
- reminder/job runner foundation
- Google Sheets and Calendar integration boundaries

## Non-Goals

- full event workflow implementation
- full analytics pipeline
- public publishing automation
- public migration guidance assistant

## Milestones

### Milestone 0.1: Repo Bootstrap

Acceptance criteria:

- `opencode.json` is present and usable
- `.opencode/` agents and prompts are present
- product, architecture, event, approval, and knowledge docs exist

### Milestone 0.2: Runtime Skeleton

Acceptance criteria:

- Node/TypeScript project scaffold exists
- Discord runtime entrypoint exists
- command registration path exists
- config loading is validated

### Milestone 0.3: Data Foundation

Acceptance criteria:

- SQLite client exists
- first schema migration exists
- core tables for events, reminders, approvals, and activity snapshots are outlined

### Milestone 0.4: Job Foundation

Acceptance criteria:

- background job runner exists
- reminder job shape exists
- routine vs approval-required event handling path is explicit in code structure

## Risks

- overbuilding the bot before event workflows are scoped
- letting LLM behavior leak into deterministic workflow truth
- designing analytics without clear staff-only visibility rules
- under-specifying approval boundaries for large events

## Recommended First Slice

Implement the bot skeleton only:

- project scaffold
- config loading
- Discord runtime entrypoint
- SQLite client and first schema
- reminder job interface
- approval request model

## Validation

- typecheck passes
- bot can start with validated config
- SQLite database initializes cleanly
- first schema migration runs
- one routine reminder job can be represented in code and storage
