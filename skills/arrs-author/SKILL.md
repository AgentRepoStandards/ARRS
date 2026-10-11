---
name: arrs-author
description: Author or adapt a minimal-context ARRS workflow and its provenance.
---

# arrs-author

## Inputs

Workflow trigger, repository controls and optional pinned upstream source.

## Workflow

1. Identify the reusable workflow, distinct trigger branches and completion criterion. Inspect existing workflows and the enforced controls before adding another instruction.
2. Write concise frontmatter name and description, then explicit inputs, ordered steps and outputs. Reach deeper reference through contextual pointers; keep unrelated reference and provenance outside the invocation body.
3. Integrate risk, architecture, verification and proof gates appropriate to the workflow. Use ordinary file/command concepts; optional harness capabilities have a serial fallback.
4. For upstream-derived work, record pinned source paths/hashes, adaptation version and major changes in separate provenance. Preserve required attribution. Source sync stages references and never overwrites adaptations.
5. Run `arrs skills test` after authoring. When reconciling upstream, inspect `arrs skills diff`, edit adaptations deliberately and record a rationale with the reconcile command. Static pack tests verify contract shape and provenance; assess agent behavior through real task evidence and review.

## Completion

Concise portable workflow, separate provenance and passing pack tests.
