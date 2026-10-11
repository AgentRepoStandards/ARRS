---
name: arrs-triage
description: Assess incoming work for context sufficiency, risk, blockers and agent suitability.
---

# arrs-triage

## Inputs

Incoming request, prior notes and repository state/tracker mapping.

## Workflow

1. Read the full request and prior notes, then find related Feature Maps and implementation. Verify reported bugs with a reproduction where possible; distinguish evidence from an unverified claim.
2. Assess readiness: goal, acceptance, entry points, invariants, boundaries, verification target and dependencies must be sufficient for a fresh agent. Record missing context or decisions explicitly.
3. Classify risk using policy and sensitive paths. Check blockers, reviewer availability and human-required decisions. Agent suitability is specific to the risk, workflow and controls; no model receives universal trust.
4. Assign the appropriate reference state: needs-triage, needs-information, ready-for-agent, in-progress, verification-failed, ready-for-review, human-required, completed or rejected. Store risk and verification separately from label spelling.
5. Save an agent-ready brief or specific missing-information questions. Use configurable tracker mappings; local state works offline. External comments, closure and label changes require the task's existing authorization. Ready-for-agent is a checked readiness conclusion, not a label override that waives gates.

## Completion

Durable brief, readiness evidence, risk, blockers and explicit work state.
