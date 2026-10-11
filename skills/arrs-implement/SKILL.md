---
name: arrs-implement
description: Implement an agent-ready work item through the ARRS gates and proof package.
---

# arrs-implement

## Inputs

Ready work item with acceptance, Feature Maps, risk and verification target.

## Workflow

1. Locate the work item, affected Feature Maps and current implementation. Confirm acceptance and blockers. Establish risk using the repository policy and sensitive paths; apply its autonomy and human execution authorization gates before capture. Independent review and human acceptance follow the completed implementation and evidence.
2. Inspect the paved road: module interfaces, allowed dependencies, existing patterns and configured commands. Save or resume an execution plan for substantial work. For multiple slices, schedule only ready work with disjoint edits; use serial work when the harness lacks safe isolation.
3. Establish the before evidence required by the task category, then implement the smallest correct change at existing interfaces. Add dependencies only with a recorded justification. Use arrs-tdd when test-first work is requested or appropriate.
4. Run configured static checks, relevant tests and real behavior verification against every acceptance criterion. Retain failing exits; verification failed is an actionable state, never completion.
5. Update Feature Maps and decisions that changed. Assemble the appropriate proof manifest and validate its logs, scope and gates. Independent review comes from another reviewer when the risk policy requires it; a self-review is not independent.
6. Report changed behavior, evidence, residual risk and review status. Mark ready-for-review only after required checks pass. Attach actual implementation-stage review and human acceptance using `arrs proof review` on the selected immutable attempt, then validate `proof validate --accepted`. Mark completed only after its bound review satisfies current policy; plan notes cannot replace it, and retries require their own review. Commit, publish or merge according to the repository's authorized workflow.

## Completion

Working behavior, updated context, validated proof and explicit work state.
