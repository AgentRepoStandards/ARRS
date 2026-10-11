# Adopting ARRS

Start with `arrs init` from the target repository and read its summary. Initialization preserves existing files, including instructions and configuration. Resolve reported conflicts by integrating the generated contract into the existing convention. Run `arrs doctor` to identify missing commands, runtime prerequisites and invalid references. A generated file is a starting point, not demonstrated maturity.

Incomplete adoption records unproven ARRS capabilities. It does not establish poor application engineering or the absence of equivalent existing controls. Point configuration at supported existing mechanisms, then qualify their behavior.

## Diagnostic and configuration boundaries

Doctor checks configuration, executable availability, static knowledge/references, maps, architecture, security and installed skills. Its `agents` and `ci` checks explicitly report file presence. Audit separately assesses the operating contract and supported gate invocation. Neither file presence nor static inspection proves hosted execution or branch protection.

Reports retain `passed` and add `status`: `passed`, `failed`, `incomplete`, `blocked`, `not-evaluated` or `unsupported`. Audit may include prerequisite identifiers in `dependsOn`. Every non-passed status remains unproven. A missing mapping is incomplete configuration; its runtime check is blocked; a configured command in a read-only audit is not evaluated. An executed failure retains its exit status. Read-only audit invokes no configured commands and can reach at most Level 1. Review trusted argv mappings before `audit --execute`.

An initialized architecture policy with `modules: []` is a valid unconfigured scaffold. Both architecture checks reject capability until real boundaries are declared. Malformed entries still fail validation; empty or unconstrained policies cannot establish Level 2. Init does not infer architecture from directory names.

All detected manifest dependencies still require rationale in the configured security policy's `dependencies` array. It is separate from the expiring, scoped control waivers in `exceptions`. Init records no approval. Inventory alone demonstrates neither safety nor reviewed acceptance. The current gate matches names, without binding rationale to versions, sources or lockfiles. Review those changes and their risk explicitly. There is no trusted baseline mechanism: rewriting an inventory grants no approval. Secure change-aware approval needs a trustworthy comparison base and independent protection of baseline, manifest and lockfile changes.

`ci.workflow` selects a GitHub Actions `.github/workflows/*.yml` or `*.yaml` file. When creating config, init discovers a sole workflow or a unique workflow passing supported inspection; ambiguous cases require explicit selection. Existing config is preserved. Supported triggers are `push`, `pull_request` and `workflow_dispatch`; other triggers remain unproven even when valid GitHub features. Audit recognizes unconditional direct commands in supported jobs/steps: `./repo <gate>`, `node repo <gate>`, CLI `run <gate>`, `npm run <gate>` or `npm test`. Named npm scripts must exist. Comments and metadata are not gates. Conditions, unresolved reusable workflows, unsupported YAML/shell forms, custom shells and failure suppression remain unproven. This is bounded inspection; other providers are unsupported.

Matrices need nonempty literal dimensions; dynamic dimensions and include/exclude forms remain unproven. Multiple commands in one literal run step require an explicit supported Ubuntu/macOS default runner; Windows, self-hosted and unresolved runners need separate command steps. This conservative boundary accounts for [GitHub's documented shell failure behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell). No Windows shell runtime was exercised locally.

Dependencies must use literal `needs` identifiers, inline sequences (empty `[]` is supported), or indented block sequences without nested children. Quoted identifiers and trailing comments are supported; unquoted null/boolean values and dynamic or malformed forms remain unsupported. Forward references work after declarations are collected. Unknown jobs, self-dependencies and cycles, including disconnected auxiliary jobs, fail CI capability. The [specification](spec/0.1.md) defines the exact subset; this validation does not observe hosted execution.

`skills.path` already selects the ARRS pack location. Existing agent tools alone do not establish ARRS pack integrity/provenance. Install missing files or point at a supported installation; preserve and deliberately reconcile local adaptations.

Optional `work: { "provider": "local", "path": "your/work-items" }` selects repository-local JSON work items. Omission preserves `.agent/work-items`. Safe path rules apply and generated `.arrs` locations are excluded. Unsupported providers fail closed, including transitions. Items still require self-contained context, risk, verification, dependencies and proof-aware completion. External issue links alone cannot demonstrate these capabilities.

Context checks retain the root instruction budget, follow bounded local navigation, resolve configured paths and accept alternative operating-rule wording. These are heuristics, not proof of adequacy for every task. Empty sensitive-path coverage remains incomplete and blocks exercising declared floors. Classify actual sensitive paths after review; no fabricated paths or agent-controlled exemption are supplied.

## Greenfield

Choose a small technology stack and configure real `setup`, `dev`, `check`, `test`, `verify` and `build` argument vectors in `arrs.json`. Describe one user-visible capability in a Feature Map. Make its acceptance behaviour executable as a verification target. Add architectural ownership, risk policy and CI before adding more features. Finish by running checks and a Proof Contract, then `arrs audit --execute`.

## Existing well-structured repository

Map existing scripts and documentation rather than creating parallel versions. Use the current module boundaries as the initial architecture policy. Begin with public or sensitive capabilities and link their existing tests and behavioural scenarios. Preserve scoped agent instructions where they describe a real boundary. Bring CI onto the same command interface; then make its risk, proof and review requirements explicit.

## Legacy repository

Use successive bounded changes:

1. Map one important capability and make the current commands reproducible. Record uncertain ownership and failing behaviour as explicit limitations.
2. Introduce one boundary around a tractable module. Record justified exceptions for existing violations and prevent new violations in that scope.
3. Add a deterministic reproduction or acceptance scenario for the mapped capability and retain its proof.
4. Extend mapping and constraints feature by feature. Use Gardener evidence to choose the next control.

Avoid a single migration that rewrites architecture, tests and instructions together. An honest level 1 plus a bounded improvement plan is more useful than a nominal level 4 with skipped checks. Audit the whole repository's configured scope and describe exclusions; narrow adoption does not justify claims about unexamined code.

## Existing conventions and limitations

The interface supports another runtime by mapping commands to its executable argument vectors. The bundled architectural adapter understands JavaScript/TypeScript import syntax; other languages need their own mechanical boundary check. v0.1 has no general adapter registration platform. A non-TypeScript repository can still use mapping, command execution, risk, skills and proof workflows while its audit reports the relevant limitation.

Installed skills operate offline. Upstream status and update discovery require network access when requested; normal engineering sessions do not.

## Propose one existing capability

Guided adoption works against an existing valid repository contract. Initialization can produce an unconfigured scaffold; planning still explains its unresolved controls, but apply requires real declared ownership, existing configured check/test/build/verify commands and valid existing maps. Resolve those initial controls through a separately reviewed setup before applying a complete capability patch. The bundled adapter covers JavaScript/TypeScript with literal relative imports; other languages and alias resolution remain explicit unsupported decisions.

Copy [the adoption input](../templates/adoption-input.json) to `.agent/adoption/report-export.json` and replace every fact with your existing source, test paths, accountable modules, invariants and owner-provided acceptance. `verification.target` must be an explicit own configuration key. Supply `verification.command` only to append an absent target or confirm an identical existing binding. Existing targets and command mappings are preserved. Optional `architecture.modules` and `sensitivePaths` append only explicit new declarations; conflicting existing entries require a separate review. Missing facts remain blockers and discovered scripts remain sourced candidates.

```sh
arrs adopt plan .agent/adoption/report-export.json --json
arrs adopt plan .agent/adoption/report-export.json --output .arrs/adoption/report-export --json
```

The first command writes nothing. The second writes a fresh proposal in safely ignored local storage and returns its raw digest and a readable `patch.diff` preview (whole original/replacement lines, not an executable patch). Inspect ordered operations, blockers, checklist and the original/replacement bytes (base64), and review every affected path. Identical unchanged inputs produce identical proposals; export path/digest metadata lives outside the deterministic proposal. Neither command runs application scripts or installs packages.

Before editing governing controls, independently retain a known-good external checkout and the result of `arrs baseline inspect /absolute/known-good --json`. Keep that source immutable. Create a separate `.agent/adoption/authorization.json` after actual permission to execute the reviewed patch:

```json
{
  "schemaVersion": "0.1",
  "proposalSha256": "<raw SHA-256 returned for the reviewed proposal>",
  "humanApproval": "<actual execution authorization and its provenance>"
}
```

This records execution permission, not completed implementation approval. Never copy placeholder approval text. Apply with the independently retained selection:

```sh
arrs adopt apply .arrs/adoption/report-export/proposal.json \
  --authorization .agent/adoption/authorization.json \
  --baseline /absolute/known-good --baseline-sha256 <independently-retained-digest> --json
```

Existing governing-control edits require the baseline and separate authorization. A map-only patch still follows the applicable pre-change risk gates. Apply rejects unresolved/malformed proposals, modified source/config/input snapshots, unsafe paths, repeated targets and changed modes before mutation. Reapplying gives a stale-input error. Only the reviewed paths change, with insert-only JSON patches preserving unrelated config/policy bytes and existing file modes. Apply executes no proposed commands.

The result is `configured`, with behavioral proof unevaluated and acceptance false. Run the existing local checks and capability verification explicitly, capture a real Proof Contract and obtain separate required implementation review/human acceptance. Doctor/audit cannot treat adoption as executed acceptance, hosted CI observation or dependency approval.

Each application retains originals and status in the returned recovery journal under ignored `.arrs/adoption/recovery-<id>`. Ordinary failures roll back matching applied replacements and report `rolled-back` or `partial-write` with exact affected paths. If interrupted, compare every actual file to the journal's expected/replacement bytes and digests before manually restoring anything; the applied list can lag a crash. Preserve intervening changes. Originals include modes, and no automatic recovery command overwrites work. See [the recovery and trust decision](adr/0006-guided-adoption.md).
