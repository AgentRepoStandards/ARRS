# Scoped readiness

Readiness answers what a maintainer must resolve before delegating a concrete change. It inspects local contracts and previously captured evidence, then proposes actions without executing configured commands or changing work, proof or review records.

```sh
arrs readiness feature export --json
arrs readiness work .agent/work-items/export.json --json
arrs readiness work .agent/work-items/export.json --base <explicit-commit> --json
```

The feature view discovers selected maps, scoped context, verification bindings and effective risk. Task suitability stays unknown until a concrete work item supplies its task identity, category, exact acceptance and intended scope. Unrelated repository proof cannot establish feature correctness.

The work view composes [task preparation](task-preparation.md), [changeset scope](adr/0006-explicit-git-changesets.md), [proof explanation](proof-contract.md) and the existing work validator. The `eligibility` fields distinguish `readyForAgent`, `humanControlledExecution`, `readyForReview`, `completed` and `autonomous`. The `admission` arrays retain the shared validator's actual projected-state errors. An explicit scope or risk blocker can make advice stricter; any resulting difference from shared state admission is reported rather than used to relax policy.

For an R1 work item with resolved context, dependencies and decisions, agent eligibility matches shared work admission. R3 continues to require human-controlled execution and actual authorization, even when checks pass. R4 never receives autonomous execution advice. Technical evidence can permit review only when the selected canonical attempt matches the work's task, category, risk, exact criteria and required targets. Missing implementation review leaves acceptance pending; completion advice requires current bound review through the shared accepted validator.

Every dimension supplies a diagnostic status, reason, source paths and available SHA-256 identities or recorded times, prerequisite dimension IDs and a remediation. Outputs use version `0.1` and a deterministic `identity`. There is no percentage or trust score. Missing context, inherited or absent target names, unresolved decisions, stale source/log/command/review bindings and protected baseline drift remain explicit blockers.

Use `--base` only for a concrete work view. The caller-selected base, HEAD, index and working state pin the complete Git inventory, including deleted and renamed endpoints. Uncovered changes block advice and sensitive paths raise requirements. Current and comparison-base mapped targets remain required even when risk is unchanged; the item must retain every target and selected proof must show each exact current/protected binding passing. Without a base, the scope remains `declared-only`; context paths do not establish complete changeset coverage. Protected baseline selection is separate:

```sh
arrs readiness work .agent/work-items/export.json \
  --baseline /absolute/retained-before-checkout \
  --baseline-sha256 <selected-digest> --json
```

Bound work and proof cannot silently fall back to candidate-only controls. Without independently selected protected context, candidate policy evaluation is informational for control transitions. Readiness neither selects a baseline nor supplies execution authorization or implementation acceptance.

Repository audit remains visible as contextual information. An unrelated failing feature stays visible there without becoming the selected task's failure; required repository admission gates still apply. Architecture coverage is bounded to the selected adapter and declared scope. External-runtime coverage remains unevaluated during read-only audit. Unsupported language scope, semantic test quality and missing product knowledge remain unknown. Passing tests, maturity levels and outcome counts grant no global model trust.

Static CI syntax and hosted execution are separate dimensions. The public launch authorizes repository Actions execution, but actual hosted matrix results remain pending; static inspection does not invent a passing run or establish whether an external branch rule requires it.

Inputs and diagnostic references are bounded: work input is at most 64000 bytes, configuration/policy/map and proof JSON readers at most 1 MiB, selected proof logs at most 20 MiB, map discovery at most 256 files and contextual evidence discovery at most 2000 files. Symlinks and escaping repository paths reject. Oversized or unreadable observer inputs report a blocker or contextual limit without unbounded fallback reads. Display reasons/actions and source references are capped. Terminal output strips nonprinting control characters; `--json` emits the versioned read model. Blocked, failed or unsupported dimensions yield exit status 1; unevaluated evidence remains visible.

These local assertions do not authenticate reviewer identity, historical timing, test adequacy or hostile execution. No readiness query performs a work transition, configured command execution, evidence/review write, network request or remote issue mutation. See [ADR 0007](adr/0007-scoped-readiness.md) for compatibility.
