# Risk and autonomy

Classify the change by its greatest credible impact, not its line count or author. A documentation change that alters executable policy or hides a failing control can exceed R0. Feature Map risk is a starting point; changed sensitive paths and the actual behaviour can raise it. The configured risk policy is authoritative for commands and gates.

| Class | Typical impact                                                                   | Default autonomy                                             | Verification and review                                                     |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| R0    | Documentation, formatting and bounded mechanical edits                           | Unattended                                                   | Proportionate checks and evidence.                                          |
| R1    | Isolated low-risk implementation                                                 | Unattended within explicit scope                             | Checks, tests and the applicable proof.                                     |
| R2    | Meaningful product/application behaviour                                         | Review before acceptance                                     | Checks, tests, behavioural evidence and independent review.                 |
| R3    | Authentication, authorization, persistence, privacy, schemas or public contracts | Human-controlled                                             | Full relevant verification, independent review and explicit human approval. |
| R4    | Destructive production work, security-critical operations, payments or secrets   | Human-controlled; autonomous implementation excluded in v0.1 | Human-owned decision and execution with domain-specific controls.           |

Risk policies are versioned JSON with all five `classes` and `sensitivePaths`. Each class records `autonomy`, `requiredChecks`, `independentReview` and `humanApproval`. Each sensitive-path rule supplies a path, minimum risk and reason. Schema validity does not establish that a classification is substantively correct.

Proof capture enforces configured checks and human execution authorization (`authorization.humanApproval`, with legacy `review.humanApproval` fallback). Technical validation permits readiness for review; accepted validation additionally requires actual implementation review and human acceptance where policy requires them, bound to the selected manifest bytes, attempt and scope. Completion and audit share this accepted gate. Plan-review notes cannot supply completed review. Review and approval text is a local record, not authenticated identity. The tool cannot prove that a distinct human or agent actually reviewed the change; CI permissions and repository review controls must establish that independently.

Permission for unattended work belongs to a bounded workflow/model combination, category, risk and controls. Record supporting outcomes with [metrics](metrics.md). Maturity alone never grants every agent global trust. Reassess risk when scope changes, a new dependency appears or behaviour reaches a more sensitive boundary.

## ARRS checkout control coverage

This repository’s `.agent/policies/risk.json` adds R3 floors to the following control scope. These are explicit ARRS checkout rules; the classifier still reads the configured `riskPolicy` path and initialization does not impose these project filenames on consumers. Existing policy, security/evidence, CI and package rules remain protected, and all five class definitions and required checks/review/approval stay unchanged.

| Scope                     | Why R3 applies                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arrs.json`               | Command argv, configured contract paths and proof requirements determine execution and admission.                                                          |
| `schemas`                 | Every shipped schema defines which configuration, evidence, review and work records are admitted.                                                          |
| `src/core`                | Core owns path traversal, command execution, configuration/schema validation, risk, architecture, security, CI, audit, proof freshness and work admission. |
| `src/cli.ts`              | Option parsing and dispatch determine whether command effects and privileged execution are permitted.                                                      |
| `src/workflows/proof.ts`  | Capture/finalization/review writes determine which executed results are accepted as evidence.                                                              |
| `src/workflows/work.ts`   | Transitions mutate persisted work and enforce executable/reviewable/completed admission.                                                                   |
| `src/workflows/init.ts`   | Bootstrap preserves user files and generates executable contracts, control policies and evidence protection.                                               |
| `src/workflows/skills.ts` | Staging and reconciliation admit source inventories and pinned adaptation/license records before writes.                                                   |
| `assets/repo.cjs`         | The shipped standalone runner resolves argv and owns command termination/failure propagation.                                                              |
| `.agent/repo.cjs`         | The tracked repository runner implements actual local execution, independent of the shipped asset.                                                         |
| `repo`                    | The root dispatch wrapper selects the standalone runner and propagates its result.                                                                         |
| `assets/repo.template`    | The bootstrap dispatch wrapper determines the runner invoked in newly initialized repositories.                                                            |
| `.github/scripts`         | Hosted CI provisioning verifies downloaded toolchain artifacts and controls executable installation and version admission.                                 |
| `scripts/controls.mjs`    | The admission script composes architecture/security/schema/skills gates and preserves failures.                                                            |
| `scripts/test.mjs`        | The test admission script discovers suites and propagates actual failures.                                                                                 |
| `scripts/verify.mjs`      | The behavior admission script exercises execution, proof, audit and negative boundary scenarios.                                                           |

Each schema and core file is covered individually by its owning directory rule. Normalized safe paths and parent scopes receive the maximum overlapping floor; similarly named prefixes such as `schemas-old` do not match. Existing filesystem-identical source aliases, including case and Unicode spellings, receive the same maximum policy and Feature Map implementation/entry-point floors. Non-following bigint identity at matching source depth establishes directory overlap; explicit file identities also match hardlinks. Missing entries retain lexical overlap and identically spelled suffixes beneath an existing aliased parent; differently spelled absent entries have no identity to establish. Distinct entries on case-sensitive filesystems remain separate, and source symlinks still reject. This comparison does not discover unlisted hardlinks inside a directory rule or establish complete changed-file coverage. Lower declared proof/work risk is rejected through the existing shared classifier, including with a non-default policy location. Unrelated documentation such as `README.md` remains R0, and requesting R4 still returns R4.

A passing audit validates the configured policy and checks for declared sensitive coverage; it does not infer that every impactful path was selected. Review new controls, executable wrappers and serialized contracts for appropriate coverage as the repository grows.

## Pre-change policy selection

The current checkout can change the policy governing its own classification. Candidate-only risk output is informational for such transitions. Before editing governing controls, independently select and retain a known-good external source and the digest returned by `arrs baseline inspect <directory>`. Supply `--baseline <directory> --baseline-sha256 <digest>` to risk, proof, work and audit commands. The supported [transition contract](proof-contract.md#protected-policy-transitions) preserves maximum baseline/candidate/requested floors, combined class gates and unchanged command bindings. A reference authored into a candidate plan cannot authenticate itself; missing or stale context on a bound record fails. Local metadata cannot prove that selection happened before editing.
