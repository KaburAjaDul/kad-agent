# Knowledge Safety

## Trusted Source Policy

KAD-Agent should answer migration and education questions only from curated internal Markdown docs.

These docs should live under `docs/knowledge/`.

## Required Behavior

- cite the source document used
- refuse or escalate if the source is missing
- do not present uncertain guidance as fact
- separate community operations help from migration guidance

## Risk Areas

- visa and legal eligibility
- country-specific skilled worker pathways
- education pathway requirements
- personal-case recommendations

## Safe Pattern

The bot may:

- summarize an approved internal document
- answer a staff question with citations
- say it is unsure and ask for human review

The bot may not:

- invent advice from memory
- answer from public web research alone
- give personalized migration judgments without approved source support
