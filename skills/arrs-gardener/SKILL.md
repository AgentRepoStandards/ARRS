---
name: arrs-gardener
description: Find repository drift and propose bounded improvements that prevent recurring failures.
---

# arrs-gardener

## Inputs

Audit, scan and repeated-failure evidence scoped to repository health.

## Workflow

1. Run the repository Gardener scan and read audit results, recent failure evidence and the affected Feature Maps. Distinguish adoption prerequisites and unexecuted/unsupported controls from reproduced application defects. Trace dependent findings to their cause; missing configuration is not evidence that equivalent existing engineering controls are absent. Scope investigation to demonstrated friction.
2. For each candidate separate observation, evidence, recommended enforcement and proposed change. Inspect architectural drift, duplicate abstractions, stale references, weak or flaky verification, dependency creep, dead code, instruction bloat, exceptions and repeated workarounds.
3. When a recurring mistake is mechanically detectable, recommend the strongest affordable control: type/schema, static rule, executable test or CI gate. Use instructions only for judgement a gate cannot express.
4. Rank candidates by impact, confidence and scope. Each proposed change contains risk, behavior to preserve, verification and expected improvement. The scan creates recommendations; implementation follows arrs-implement with explicit scope and review.
5. Capture a local report and bounded work items. Verify a new control rejects an intentional violation and passes restored code. Avoid unbounded rewrites and automatic production operations.

## Completion

Evidence-backed improvement candidates or a bounded verified enforcement change.
