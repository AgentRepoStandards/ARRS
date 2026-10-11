# Native test scheduling

## Objective and context

Preserve every existing test and admission check while changing native test scheduling. The sixth hosted PR Windows Node 24 job failed the real packed-consumer install at its existing 60-second limit. Its recorded native error was ETIMEDOUT. The sixth push Windows Node 22 job returned a null Git test child status after approximately 120.018 seconds; its native error and signal were not recorded. The underlying causes and any benefit from scheduling changes remain unestablished.

Read the root operating contract, risk policy, Proof Contract and current Feature Maps before implementation. Both admission scripts are sensitive R3 paths. Current and retained baseline Feature Maps have no implementation or entry-point overlap with this scope, so no additional mapped verification target is required. Standard verification, check, test and build remain mandatory, with independent review and human implementation acceptance.

## Intended changes and constraints

The exact implementation paths are:

- `scripts/test.mjs`
- `scripts/verify.mjs`
- `tests/changeset.test.mjs`
- `tests/changeset-cases.mjs` (new shared case catalog)
- `tests/changeset-group-a.mjs` (new native group entry)
- `tests/changeset-group-b.mjs` (new native group entry)
- `tests/test-runner.test.mjs`
- `.agent/plans/native-test-scheduling.md`

Full admission must run the genuine packed-consumer case alone, then every remaining discovered suite under the existing bounded concurrency. Preserve all 427 original callbacks: one package case and 426 remaining cases. Augment the existing three test-runner callbacks with actual package-phase ordering and failure-folding regressions without replacing their current assertions. Ordinary failure in an earlier phase must remain fatal while later suites are attempted where possible. Errors, signals and null statuses cannot count as success; no empty native test invocation or fabricated combined summary is permitted.

Standard verification must execute all 28 unchanged Git cases through two disjoint native 14-case groups under one child process with concurrency two. The original changeset test entry still executes all 28 cases for full admission. Preserve case names, assertions, conditional platform skips, actual CLI/Git behavior, independent filesystem/Git storage, complete inventories and immutable baseline checks. Keep real CLI/proof/audit acceptance and all 18 graph cases active.

Configured command bindings stay unchanged. Retain the 120-second Git child limit, 300-second configured standard verification, 900-second configured full test limit, and both 60-second native pack/install limits. Raw hosted `npm test` does not acquire an ARRS runner deadline merely from that configuration. Do not change production code, dependency locks, workflow, policy or earlier canonical evidence.

## Proof, milestones and current state

The unchanged protected before capture passed configured standard verification in 179,647 milliseconds, including all 28 Git cases and all 18 graph cases with no skips. Independent review found no blocker in the exact proposal, and that reviewed implementation has been applied. Candidate execution, hosted qualification and human implementation acceptance remain pending. The protected proof scope is `scripts/test.mjs`, `scripts/verify.mjs`, the complete `tests` directory and this plan. Directory coverage admits future group files without writing implementation stubs before the baseline; the intended changed-file list remains the eight paths above.

The passing before capture used the original independently selected immutable baseline. Next freeze the reviewed source and capture check, all tests, the same configured standard verification and build; validate the selected protected proof and obtain actual independent review of the frozen source and results. Preserve the before session, all six earlier proof contexts and every failed hosted attempt.

Complete the exact final Ubuntu/Windows and Node 22/24 hosted qualification before requesting overall R3 implementation acceptance. Existing public-launch and Actions authorization permits corrective execution; it does not record acceptance of this implementation. Windows parent-directory crash durability and cold-cache/latest-range consumer installation remain unqualified. This is the historical preparation status for source freeze. Record subsequent selected after results and hosted qualification in ignored evidence and the PR checks without changing covered source after freeze. This plan claims no passing after capture, hosted qualification, timing improvement or completed approval.
