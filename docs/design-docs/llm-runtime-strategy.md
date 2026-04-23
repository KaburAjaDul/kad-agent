# LLM Runtime Strategy

## Principle

Use deterministic code and SQLite for workflow truth.

Use LLMs for drafting, summarization, and interpretation.

## Recommended Split

Deterministic system owns:

- event state
- approvals
- reminders
- attendance tracking
- analytics storage
- content queue state

LLM may assist with:

- event summary drafting
- weekly report drafting
- content idea generation
- source-cited answer composition from trusted docs

## Local LLM

A local OpenAI-compatible endpoint is a good fit for:

- low-cost summaries
- content drafts
- internal support responses

## Guardrail

The model should never be the source of operational truth.
