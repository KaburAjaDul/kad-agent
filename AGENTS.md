# Agent Operating Manual

## Quick Start

```bash
/research turn the KAD event operations workflow into implementation-ready docs
/build implement the first SQLite schema and Discord bot skeleton from the approved plan
```

## Navigation

| What you need | Where to find it |
|---------------|------------------|
| Architecture | `ARCHITECTURE.md` |
| Product spec | `docs/product-specs/` |
| Design docs | `docs/design-docs/` |
| Execution plans | `docs/exec-plans/active/` |
| Knowledge docs | `docs/knowledge/` |
| Agent prompts | `.opencode/prompts/` |
| Agent definitions | `.opencode/agents/` |
| Skills | `.opencode/skills/` |

## Visible Primaries

- `build`: coordinate scoped implementation toward a reviewed patch
- `research`: coordinate evidence gathering toward a spec, architecture note, policy, or execution brief

## Hidden Workers

- `scoper`: shape work into milestones, first slices, and planning artifacts
- `researcher`: gather repo and external evidence
- `builder`: implement one bounded slice
- `reviewer`: approve or reject plans, code, and safety posture

## Core Product Direction

KAD-Agent is a semi-autonomous Discord operations copilot for Kabur Aja Dulu.

V1 priorities:

- event operations
- analytics and reporting

Secondary priorities:

- community activation support
- content queue drafting
- staff-facing knowledge support from curated Markdown docs

## Safety Rules

- routine events may be automated
- larger events require approval
- public migration or education guidance must come from approved internal docs
- risky or uncertain answers must escalate instead of bluffing
- public publishing goes through a queue, not direct autonomous posting
