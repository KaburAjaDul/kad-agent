# Architecture

## Product Shape

KAD-Agent is a Discord-first operations bot.

Primary surfaces:

- Discord slash commands and workflows
- scheduled jobs and reminders
- internal reports and summaries

Later surface:

- small admin web panel if needed

## Domain Boundaries

Organize code by domain.

```text
Domain
├── types/       # Domain types and interfaces
├── config/      # Constants and policy values
├── repo/        # Data access and external boundary parsing
├── service/     # Business logic and workflow rules
├── runtime/     # Job runners, command handlers, orchestration wiring
└── discord/     # Discord-facing adapters and response formatting
```

Potential domains:

- `events`
- `volunteers`
- `analytics`
- `content`
- `knowledge`
- `discord`
- `integrations`

## Dependency Direction

```text
types -> config -> repo -> service -> runtime -> discord
```

Rules:

1. Lower layers do not import higher layers.
2. SQLite, Google APIs, and Discord APIs enter through repo or provider boundaries.
3. Service layer owns event rules, approval rules, and analytics interpretation.
4. Runtime wires commands, jobs, approvals, and background flows.
5. Discord-facing code formats outputs but does not own business policy.

## Source Of Truth

- operational truth lives in SQLite
- trusted migration and education knowledge lives in curated Markdown under `docs/knowledge/`
- LLMs may summarize or draft, but they do not become the workflow source of truth

## Approval Model

- routine events: may be automated
- large events: require approval before publication
- public guidance: only from approved knowledge docs
- public social output: queue first, human approval before publishing

## Worktree Strategy

Git worktree isolation is not implemented yet.

For now, all agent and subagent work happens in the same repository checkout.

We should introduce worktree isolation later only when:

1. multiple implementation slices need to run in parallel
2. isolated experimental branches would reduce merge risk
3. review sandboxes are needed for larger autonomous changes
4. concurrent background implementation work becomes common enough to justify the added complexity
