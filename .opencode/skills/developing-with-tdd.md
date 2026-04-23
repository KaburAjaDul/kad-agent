---
title: Developing with TDD
inline-tokens: ~700
description: Test-first development for behavioral code changes
---

## When to Use

Use for new features, bug fixes, and behavior-changing refactors.

## Procedure

1. Name the behavior that should change.
2. Write the smallest failing test or failing check first.
3. Implement the minimum code to pass.
4. Refactor without changing behavior.
5. Record the verification commands you ran.

## KAD Guidance

- keep workflow truth in deterministic code and SQLite
- do not use the LLM as the operational source of truth
- keep risky approvals explicit in tests when possible

## Success Criteria

- [ ] failing check existed first
- [ ] relevant tests pass after the change
- [ ] verification commands are recorded
