---
title: Reviewing Code
inline-tokens: ~650
description: Findings-first review for plans, code, tests, and safety
---

## When to Use

Use for independent review, self-review, plan critique, and QA checks.

## Procedure

1. Confirm the change matches the request.
2. Check correctness and regression risk.
3. Check verification quality.
4. Check architecture boundaries.
5. Check safety and approval gates.

## KAD Safety Focus

- risky automation must be approval-gated
- migration and education guidance must come from approved sources
- per-member analytics must stay staff-restricted

## Success Criteria

- [ ] findings are the primary output
- [ ] file references are included where possible
- [ ] safety or approval gaps are not waved through
