---
name: arrs-spec
description: Specify a feature or resolve a design decision for a repository change.
---

# arrs-spec

## Inputs

Request, relevant product context and repository configuration.

## Workflow

1. Read the request and the relevant product context, Feature Maps and ADRs reached through `arrs.json`. Check the implementation for existing behavior. Record the goal and explicit scope.
2. Write independently testable acceptance criteria, affected Feature Maps, invariants, architectural boundaries, verification strategy and likely risk. Use current paths as navigation pointers, with behavior as the durable contract.
3. Separate facts from unresolved decisions. Investigate repository facts yourself. Record consequential trade-offs as ADRs; ask the responsible human for decisions the risk policy reserves for them. Keep decision questions distinct from executable work.
4. For substantial multi-session work, save an execution plan with objective, constraints, milestones, current state, decisions, discoveries and verification. Each unresolved item has an owner and a resolution condition.
5. Save the specification locally with the unresolved decisions visible. Mark agent-ready only when another agent can locate the relevant boundaries, run verification and determine acceptance from the artifact alone. Publish to a tracker only within authorization and its configured adapter.

## Completion

Local specification or decision record, acceptance criteria, risk and verification plan.
