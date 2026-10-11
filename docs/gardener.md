# Gardener

During adoption, trace incomplete configuration, blocked prerequisites and unexecuted or unsupported controls before treating diagnostics as application defects. Record existing inventory separately from reviewed dependency rationale. Use synthetic reproductions to distinguish diagnostic limitations from missing capability; a failing adoption audit does not establish the absence of equivalent application controls.

The Gardener improves the repository substrate using repeated failure and drift evidence. It does not take over normal product delivery or apply unbounded rewrites.

Run the read-only report after verification or when failures recur:

```sh
arrs gardener --json
```

v0.1 reports architecture/security findings and doctor gaps, agent instruction files exceeding 80 lines, deferred-work comments and suppression directives in source/tests, exact normalized source duplicates, and failure categories observed for at least two distinct tasks in a comparable workflow/risk cohort. Each finding names its evidence. Wider review can examine dead code, flaky tests, dependency creep, recurring workarounds and obsolete patterns; these are investigation prompts rather than claims of semantic detection.

Supported JavaScript/TypeScript maintenance scanning (including .mts/.cts module files) uses the existing TypeScript parser to identify literal ranges and then scans comments. Regexes, strings, raw template text and JSX text stay opaque; real comments inside template interpolation and JSX expressions remain visible. File-leading `@ts-nocheck`, comment-leading `@ts-ignore` and ESLint disable directives are maintenance candidates. Security enforcement remains separate and unchanged. Parse errors and known unsupported source languages produce warnings while evaluable comments remain visible. Individual source files are limited to 1 MB, excerpts to 240 characters; suspected credential excerpts are replaced with a redaction marker. This bounded redaction does not certify the absence of secrets.

Candidates retain the original observation/evidence/enforcement/change fields and add a stable SHA-256 `id`, `ruleId`, one-based source locations, source/configuration digests, proposed scope, suggested feature ownership/risk, mapped targets and uncertainty. Repeated reads of unchanged evidence return the same identity. A changed source or governing map/configuration invalidates that identity. Ownership and root cause remain suggestions requiring investigation. Legacy metrics lack a control digest; recurrence reports that limitation rather than equating such observations with authenticated comparable outcomes. Repeated events for one task cannot establish distinct-task recurrence.

Create one selected draft through the configured local work provider:

```sh
arrs gardener propose <candidate-sha256> --out .agent/work-items/garden-export.json --json
```

The CLI recomputes the finding before any write, rejects stale identities and unresolved source ownership/targets, and restricts the work file to the configured local work directory. It creates a schema-valid `needs-triage` work item and linked proposal/proof drafts under `.agent/plans/`. Companion documents stay outside the provider's work-item JSON inventory. The proposal retains evidence digests, objective, scope, acceptance, exclusions, residual uncertainty and review instructions. The proof draft deliberately requires a real failing before scenario and matching after scenario before capture. No authorization, passing evidence or completed approval is supplied.

An identical repeat preserves the existing bytes; any conflicting artifact rejects before writes. Symlinks and traversal reject through the existing safe repository-path resolver. Write failures remove only newly created artifact files; existing files remain intact. Reporting and draft creation execute no configured commands, send no network request and do not edit application source or promote work. A proposal does not satisfy readiness or acceptance gates.

Every candidate separates four things:

1. **Observation:** the specific drift or repeated failure.
2. **Evidence:** command result, path, count, local metric or reproducible scenario supporting it.
3. **Recommended enforcement:** the check, type, boundary or test that could prevent recurrence.
4. **Proposed change:** a bounded implementation and its verification.

For example, repeated forbidden imports support a boundary enforcement change; repeated ambiguous handoffs support a readiness schema or fixture; instruction bloat can support routing context into a Feature Map. Adding another sentence to `AGENTS.md` is weaker than an available mechanical gate.

Reports are read-only recommendations. Select one candidate, classify its risk, create a self-contained work item and use the normal proof/review workflow. Verify that the new control rejects the bad case and permits the paved road. Record exceptions with a reason and revisit them when their expiry or assumptions change.

Lifecycle recurrence uses the shared validated 0.2 outcome inventory. It groups distinct task/event identities by workflow/model aliases, risk, change category, retained control/version identity, features and compatible observation duration. Repeated attempts for one task cannot create recurrence; re-reading a report adds no events. Superseded observations are excluded, and legacy unwindowed events remain in a separately labeled unknown-control/window cohort. Each recurrence exposes task/event counts, actual chronological timestamp range (including variable fractional-second forms), a cohort digest and supporting immutable event IDs/provenance. At most 1,000 supporting references per group are rendered; truncation is explicit. A retained control hash identifies a local context and does not authenticate a verifier or establish common root cause. Missing source ownership remains an actionable proposal blocker.

Compiler suppression scanning uses TypeScript's parser-recognized Ignore directive ranges, including supported multiline block placement. Suspected AWS AKIA/ASIA tokens receive the same excerpt redaction as other supported credential families; security detection remains active. Proposal artifact destinations must be distinct, and companion documents cannot overlap the configured work-item inventory. Publication rechecks existing bytes and accepts an exclusive-create race only for identical payloads; conflicting bytes reject and only newly created artifacts are removed. The actual plain CLI proposal path is verified alongside JSON output.
