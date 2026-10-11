---
name: arrs-research
description: Research an engineering decision against pinned or dated primary sources.
---

# arrs-research

## Inputs

Bounded engineering question and repository constraints.

## Workflow

1. State the question, decision it informs and repository constraints. Read the relevant Feature Map and ADRs so investigation stays scoped.
2. Investigate primary sources: official documentation, source code, specifications or first-party APIs. Record source URLs, revision/version or access date, uncertainty and assumptions. Separate observed fact from inference.
3. Save concise cited findings in the repository's research convention, or alongside the relevant execution plan. Delegation is optional and harness-independent; a single agent can perform the same steps.
4. Explain compatibility with architecture, risk and verification requirements. Identify what still needs an executed experiment before it is a decision.
5. Link the findings from the work item or ADR. Research does not itself authorize external changes, install remote code or establish a passed behavior proof.

## Completion

Cited primary-source findings with version/date and decision-relevant uncertainty.
