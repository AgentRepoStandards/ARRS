# Proof Contracts v0.1

The Proof Contract turns a verification claim into reviewable evidence. A schema-valid plan names the task, category, risk, scope, acceptance criteria, ordered command steps, residual risks, deviations and execution authorization when policy requires it. Execute it to capture command results and logs; validate the resulting manifest before declaring readiness.

## Category contracts

| Category | Required evidence                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug      | The original behavioural reproduction fails before the fix and the same scenario succeeds after it; relevant checks and regression protection also pass. |
| Feature  | Executable behavioural verification covers the acceptance criteria, together with required checks and tests.                                             |
| Refactor | Equivalent scenario succeeds before and after the change, alongside required checks and tests.                                                           |
| Docs     | Proportionate configured checks and mechanical verification; a runtime scenario is unnecessary when runtime behaviour is unaffected.                     |

For before/after work, capture the baseline before editing and retain it with the change. An expected nonzero reproduction is evidence of the bug, not permission for a required check to fail. `check`, `test` and risk-required checks must succeed. A plan that omits required checks or acceptance evidence is invalid even if every included command exits zero.

## Plan and manifest

Both schemas use `schemaVersion: "0.1"`. A step records `phase`, a standard `command`, optional verification `target`, `expectExitCode`, and optional acceptance `criterion`. Phases are `before`, `check`, `test`, `behavior`, `after` and `mechanical`. Scope paths are repository-relative. Link acceptance evidence using exact criterion text.

The generated manifest also records a unique `id`, `createdAt`, overall `status`, results with configured `argv`, actual exit status and duration, log references and SHA-256 digests, and `scopeHashes`. Evidence lives in ignored `.arrs/evidence/<id>/`. Before capture and every proof/review write, the CLI requires conservative whole-directory ignore protection strictly below root `.arrs/`; current validation rechecks it. Capture/review output reports the protection method and limits. Git verifies an existing directory or ancestor with a normalized, non-slash-suffixed query; absent directories without a confirmed ignored ancestor and cases without Git/worktree require the canonical scoped marker as a bounded local convention. Unsupported/unsafe ignore state stops before command effects or writes. Existing files are preserved and may require deliberate repair; see [evidence protection](security.md). A failed required command produces failed proof; validation checks the contract, recorded status, logs, current configured argument vectors and scope hashes. Regenerate evidence after changing covered files or the covered command mapping.

Proof source scopes are checked after safe repository-path resolution: the repository root and the root `.git`, `.arrs` and `node_modules` trees are prohibited, including dotted or repeated-separator aliases and descendants. Case variants are prohibited when their first root entry has the same filesystem identity as a reserved entry; distinct uppercase source entries on case-sensitive filesystems remain supported. Identity checks use non-following metadata only for possible first-component aliases, so unrelated excluded dependency symlinks remain outside source admission. Supplied scope spelling remains unchanged in plans, hashes and logs. Source scope aliases retain the maximum configured sensitive-path and Feature Map risk floor through filesystem identity, so an alternate spelling cannot lower proof or work admission requirements. Previously captured prohibited-alias proof fails technical and accepted validation, review attachment, work readiness/completion and audit; recapture with legitimate source rather than rewriting evidence. Legitimate source aliases, similarly named siblings and nested reserved directories remain supported.

Directory scope hashes include every file, including nested `build`, `vendor`, `dist` and other reserved-name directories. Only the exact repository-root `.git`, `.arrs` and `node_modules` trees are excluded from directory traversal; nested directories sharing those names remain covered. Exclusions are compared without inspecting their filesystem entries, so an unrelated root dependency symlink does not affect source-only proof; declared and visited source still reject symlinks. Explicit file scopes hash their bytes. Architecture `generated: true` affects scanning only: generated files inside declared proof scope remain hashed because changing them can change behavior. Keep disposable output outside declared source scopes; symlinks and oversized traversal fail rather than silently reducing coverage. Proofs made with an older CLI may need regeneration because previously omitted files now contribute to their hashes.

For feature/docs work:

```sh
arrs proof run .agent/plans/proof.json --execute
arrs proof validate .arrs/evidence/<id>/proof.json
```

For a bug or refactor, capture and finish the same session across the edit:

```sh
arrs proof start .agent/plans/proof.json --execute
# Make the bounded implementation change after baseline capture.
arrs proof finish .arrs/evidence/<session-id>/session.json --execute
arrs proof validate .arrs/evidence/<attempt-id>/proof.json
```

Replace identifiers with the paths returned by the commands: `start` returns the baseline session and `finish` returns the chosen attempt manifest. The [example plan](../templates/proof-plan.json) is a draft contract for a report-export feature; adapt its scope and target to actual files, and capture technical evidence before requesting actual implementation review. It does not claim completed review or passing evidence.

Each `proof finish` reserves a new UUID attempt directory before executing commands. Its immutable `attempt.json` records the original session path/digest, attempt timestamp and source-to-copy baseline log mapping. Baseline logs are checked against the original plan and current scenario argv, copied byte for byte with unchanged hashes, and included with the new after results. Use the returned `.arrs/evidence/<attempt-id>/proof.json` path to validate or attach that attempt; the attempt ID differs from the baseline session ID.

After a failed finish, correct the implementation and run `proof finish` again with the **original session path**. Do not rerun the failing baseline against fixed code or delete previous evidence. Failed/completed attempts remain immutable. An interrupted attempt can retain its allocation marker, baseline copies and partial logs without a manifest; that directory records capture history, not a completed verification claim. Allocation collisions fail before executing commands.

Existing v0.1 manifests with baseline and after logs in one directory remain readable. New completed attempts validate their own copied baseline, so later damage to the original baseline prevents further retries but does not invalidate an intact completed copy. Tampering with the copy, stale scope, changed argv or failed required checks still invalidates the selected manifest. `attempt.json` supplies diagnostic provenance rather than authenticated lineage; preserve the original session for review. Subsequent review must identify the selected attempt, not carry acceptance from a different run.

## Authorization and completed review

`authorization: {"humanApproval": "..."}` records actual permission for policy-controlled execution before capture. R3/R4 execution remains blocked without required human authorization. R2 baselines do not require review of an implementation that has yet to be written. An explicit authorization record takes precedence over legacy `review.humanApproval`.

A manifest's `status: "passed"` and `proof validate` establish **technical success**: checks, behavior, logs and current scope validate. They permit `ready-for-review`; they do not claim completed review. After examining the actual diff and selected passing proof, record the review in a repository-relative input file, for example:

```json
{
  "schemaVersion": "0.1",
  "stage": "implementation",
  "independent": "Actual separate reviewer, reviewed revision, findings and evidence reference",
  "humanApproval": "Actual human approval of this implementation, when policy requires it"
}
```

Omit fields not required by the current risk policy. Do not copy example text as an approval. Attach and validate the selected attempt:

```sh
arrs proof review .arrs/evidence/<attempt-id>/proof.json .agent/reviews/review-input.json
arrs proof validate .arrs/evidence/<attempt-id>/proof.json --accepted
```

Attachment first rejects failed, stale or noncanonical evidence. It writes a new immutable `review-<uuid>.json` beside the canonical manifest, binding its attempt ID, raw manifest SHA-256, exact scope hashes and review timestamp. It leaves the session, logs and manifest unchanged. The public `proof-review` schema describes this generated record; the input contains only `schemaVersion`, `stage`, and actual independent/human records. Multiple attachments remain append-only history. Accepted validation requires a valid binding satisfying **current** policy; retries do not inherit another attempt's review. Changed source, commands, logs or manifest bytes invalidate acceptance.

Completed work and audit's `proof-evidence` control use the same accepted validator. Pending review cannot satisfy those gates. R0/R1 proofs with no configured review requirements need only current canonical technical evidence. Required deviations and residual risks remain reviewable and cannot override mandatory checks.

Compatibility: existing v0.1 manifests remain technically readable. Legacy plan `review.independent` is an ambiguous plan note, never automatically completed implementation review; legacy `review.humanApproval` remains a fallback execution authorization. Evidence requiring review must receive an explicit new implementation attachment before acceptance. New optional authorization fields and the `proof-review` schema require this corrected CLI; older CLIs reject unknown fields. See [the lifecycle decision](adr/0004-proof-authorization-and-review.md).

## Trust boundary

Inspect evidence without execution or mutation:

```sh
arrs proof explain .arrs/evidence/<attempt-id>/proof.json --json
arrs proof history --selected .arrs/evidence/<attempt-id>/proof.json --json
arrs proof report .arrs/evidence/<attempt-id>/proof.json --output .arrs/reports/<new-name>
```

Explanation links exact acceptance text to ordered successful results, shows required checks, current command bindings and source hashes, and distinguishes technical success, `ready-for-review` and acceptance. Failed and interrupted attempts remain selectable in expanded history JSON. Provenance only groups local diagnostic assertions. Protected proof still requires the independently selected `--baseline` and `--baseline-sha256` options. Legacy evidence retains its declared-scope limitation.

Reports require whole-directory ignore protection and a new output directory strictly beneath `.arrs/reports/`, outside configured evidence. They produce a static HTML preview and contained `explanation.json`; existing reports are preserved. Source/log paths are inert text. Raw logs are omitted by default. Explicit `--excerpts` exports at most 100 excerpts, each bounded to 8192 UTF-8 bytes after heuristic redaction; `--redaction none` explicitly opts out. Original hashes are verified and displayed separately from exported excerpt hashes. Redaction/truncation never changes canonical evidence. Metadata and missed secrets may still be private; inspect the local preview before choosing to share. The command performs no upload or network action. See [the output/privacy decision](adr/0006-local-proof-explanations.md).

Declared-source hash verification detects stale or altered recorded files. Without the explicit changeset capability it does not establish complete changed-file scope. Neither form binds proof to a trusted machine, authenticates reviewers or stops a malicious author replacing both logs and hashes. Commands, tests, criteria, policy and proof share repository trust. CI and protected review must independently validate hostile changes and control weakening. ARRS offers local engineering evidence rather than signed attestation.

## Protected policy transitions

Existing local commands use the current checkout's configuration and policy. CLI results label this `candidate-only`: they can establish local technical evidence, but cannot establish that a change to those governing controls was authorized.

For a policy transition, the human or trusted workflow must select a known-good external repository directory **before the edit** and retain its identity and digest independently of candidate-authored files. Inspect that selected source with the corrected CLI:

```sh
arrs baseline inspect /absolute/path/to/known-good-source --json
```

The source must satisfy existing configuration, policy, Feature Map and architecture validation. Build its unchanged source first when configured generated module references require it. The returned `selection` contains the canonical absolute root and SHA-256 over configuration, selected policies, the scanner's Feature Map JSON inventory and the bounded non-following source filesystem identity inventory, including directories and generated source. Exact root metadata/evidence/dependencies are excluded before inspection; source symlinks reject. Keep the source and its identity inventory immutable and available; prepare/build the known-good source before selecting its digest. Replacing source entries or rebuilding with replacement files can invalidate the selection even when bytes remain identical. Restore the original retained source rather than repinning edited candidates; neither a local timestamp nor a digest authenticates pre-change history. A candidate-derived snapshot first selected after the edit is ineligible.

Supply the independent selection to every protected operation:

```sh
arrs risk arrs.json --risk R3 --baseline /absolute/path/to/known-good-source --baseline-sha256 <selected-digest>
arrs proof run .agent/plans/proof.json --execute --baseline /absolute/path/to/known-good-source --baseline-sha256 <selected-digest>
arrs proof validate .arrs/evidence/<id>/proof.json --baseline /absolute/path/to/known-good-source --baseline-sha256 <selected-digest>
```

The same options apply to proof start/finish/review, accepted validation, work validation/transitions and audit. The CLI stamps `policyBaseline: {"root":"...","sha256":"..."}` into captured plans, sessions, manifests, transitioned work and generated reviews. That field records the selection; it cannot authenticate or supply it. Bound records require matching external context on later calls. A session started candidate-only cannot gain protected selection at finish. Missing, changed or mismatched baseline state rejects rather than falling back. Protected validation also requires captured evidence to contain the selection; recapture rather than upgrading an unbound manifest.

Classification retains requested, baseline and candidate floors, including normalized source paths and actual filesystem aliases. Required checks from both configurations/classes remain required. The stronger autonomy, independent review and human approval gates apply, and the earlier behavioral threshold remains active. Baseline/current mapped targets remain required when their source overlaps the declared scope. Work also retains requirements of explicitly selected baseline features. Technical readiness still precedes completed review; baseline selection supplies neither execution authorization nor implementation acceptance.

Protected admission requires identical argv and effective timeout for required checks, each planned command and applicable mapped targets. Command drift fails before execution or evidence/work mutation. This interface supports pointer, sensitive-rule and class-gate transitions with unchanged command bindings. Stage command changes through separate review and establish a new known-good source after that transition; the CLI does not execute two command variants. Audit pins its supplied baseline and command bindings before executing checks, and uses the same accepted validator for proof evidence. Unbound old evidence remains local candidate-only evidence when no protected context is supplied.

Custom configured policy/map locations remain supported; `arrs.json` remains the existing configuration filename. Optional v0.1 baseline fields require this CLI. Baseline selection alone does not discover all changed files; full Git coverage requires the separately negotiated changeset capability. No authenticated approval, signed attestation or protection against replacing both implementation and trusted workflow is claimed. See [ADR 0005](adr/0005-trusted-pre-change-policy.md).

The protected source domain excludes normalized root `.git`, `.arrs` and `node_modules` floor references (sensitive paths and Feature Map implementation/entry points) and scope/work-context queries, including filesystem-identical case aliases. These identity operands are outside the pinned source inventory and reject with an actionable diagnostic. Ancestor `.` remains supported for risk/audit, as do nested reserved-name source directories and distinct uppercase source on case-sensitive filesystems. Candidate-only consumers retain their prior behavior. Trust flags select exactly one root/digest pair; duplicate `--baseline` or `--baseline-sha256` options reject before effects rather than silently choosing the last value.

## Explicit Git changeset coverage

Existing v0.1 proof covers declared source. For complete proposed-change inventory, inspect an explicit local commit and compare its inventory with a plan:

```sh
arrs scope inspect --base <commit> --json
arrs scope check .agent/plans/task-proof.json --base <commit> --json
```

Git 2.52.x is the qualified version. Inspection retains committed, staged, raw-byte unstaged and nonignored untracked layers, and records aggregate base-object/current-byte endpoints. Renames cover both names; deleted files retain former object identity and explicit current absence. Uncovered paths fail with a nonzero exit. Exact root `.git`, `.arrs` and `node_modules` changes are listed as excluded; nested directories with those names remain source. Current and comparison-base maps/policy retain maximum diagnostic risk floors and mapped target obligations. A comparison base never supplies independently selected protected policy context.

To bind execution to this inventory, add `"changeset": {"version": "1", "mode": "git", "base": "<commit>"}` to a plan and recapture. The manifest stores a complete `changesetSnapshot`. Capture rejects uncovered paths, deficient risk or missing mapped verification steps before project commands. Validation recollects the bounded inventory and rejects base/HEAD/index/working drift, new untracked source or tampered snapshot fields. An absent explicitly scoped file hashes only with captured regular-base-blob deletion provenance; restoring it invalidates proof. Existing scopes still use their original source hashes.

Inspection uses argv, NUL-delimited paths and raw file bytes; it invokes no repository fsmonitor, external-diff, textconv or clean-filter command and performs no fetch or index write. Raw line-ending differences can be reported even when a Git clean filter would normalize them. Unsupported versions, symlinks/submodules/sparse or unmerged indexes, missing local objects, unsafe paths and exceeded limits cannot claim complete coverage. Two agreeing observations are required; concurrent changes fail with a retry diagnostic.

For non-Git repositories, `arrs scope inspect --manual <source...>` and `arrs scope check <plan> --manual` validate declared existing source and label assurance `declared-only`. Discovery of omitted changes and deletion provenance remain unknown. Manual results and old evidence cannot satisfy the opt-in Git capability. Optional fields require the corrected CLI; older versions reject them. See [ADR 0006](adr/0006-explicit-git-changesets.md). Local snapshot integrity remains distinct from authenticated verifier/reviewer trust and completed implementation acceptance.

## Offline authenticated receipt conformance

Opt-in [receipt verification](receipts.md) adds independently selected external verifier/provider/review roots and exact immutable Git candidate/base/control bindings in a separate version 1 format. It cannot upgrade declared-only evidence, substitute local review text for protected completed review, supply implementation acceptance or weaken retained command bindings. The first GitHub provider is an offline conformance adapter with actual local scenario fixtures; every successful verification remains `admission: false` and hosted assurance is unqualified. Hosted receipt issuance and provider admission require separately authorized qualification; enabling ordinary repository CI for the public launch does not qualify them. [ADR 0007](adr/0007-offline-trusted-receipts.md) defines consumer selection, event timing, replay and remaining trust responsibilities.
