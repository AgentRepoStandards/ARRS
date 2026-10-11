---
name: arrs-slice
description: Decompose a specification into independently executable vertical slices.
---

# arrs-slice

## Inputs

Saved specification and repository configuration.

## Workflow

1. Read the specification, related Feature Maps and boundary policy. Preserve unresolved decisions as blockers; reject guesses that would change acceptance.
2. Draft vertical slices: each delivers a user-visible behavior through the necessary layers and has its own acceptance and verification. Keep each slice small enough for a fresh agent session. For a mechanically inseparable migration, use expand–migrate–contract with explicit integration verification.
3. Each work item contains goal, category, scope, Feature Maps, entry points, invariants, boundaries, risk, configured command/target, acceptance criteria, blockers, out-of-scope work and human-required decisions. Include context pointers that resolve from the repository; hidden chat context is not an input.
4. Check the dependency graph for cycles, missing blockers and overlapping edits. A ready slice has no unresolved blocker and enough context to satisfy the risk policy.
5. Save one durable item per slice. Use the repository work-item schema and configured tracker mapping; local items are sufficient. Publishing or closing external issues follows existing authorization.

## Completion

Self-contained work items with a dependency graph and demonstrable vertical behavior.
