# ARRS workflow pack and upstream integration

ARRS ships ordinary Markdown workflows that any coding agent can read. The CLI installs them at `skills.path` in `arrs.json` (default `.agent/skills`). This source directory must sit outside the reserved `.arrs` output/cache tree. There is no mandatory vendor Skill tool, subagent API, issue tracker or network call in an invocation. Each workflow declares a trigger, inputs, steps and observable completion. Optional parallel work has a serial fallback. Required risk, architecture, check/test/behavior and proof gates come from the repository configuration.

Qualification pack `0.1.2` adds proof/review/implementation lifecycle guidance: authorize execution, capture technical evidence, then attach actual implementation review to the selected immutable attempt and validate accepted evidence. These three adaptations are versioned `0.1.1`; pack hashes and provenance preserve upstream pins. Older installed variants remain preserved on conflict and need deliberate upgrade. The preceding pack `0.1.1` updated `arrs-adopt` and `arrs-gardener` adaptation guidance for incomplete setup, prerequisite diagnostics, dependency inventory review and supported configured locations. Their adaptation versions and document hashes are recorded in pack provenance. The pinned Matt Pocock revision, source-bundle hashes and attribution remain unchanged; existing installed adaptations continue to be preserved during installation.

## Choose a workflow

| Task                                                          | Workflow         |
| ------------------------------------------------------------- | ---------------- |
| Bootstrap or assess adoption                                  | `arrs-adopt`     |
| Specify a change or resolve large-work decisions              | `arrs-spec`      |
| Decompose into agent-ready vertical slices                    | `arrs-slice`     |
| Implement one item or a ready ticket graph                    | `arrs-implement` |
| Debug a reproduced defect                                     | `arrs-debug`     |
| Work test-first                                               | `arrs-tdd`       |
| Design interfaces and prove boundary enforcement              | `arrs-design`    |
| Improve repository health and mechanical prevention           | `arrs-gardener`  |
| Resolve product/domain language                               | `arrs-domain`    |
| Review correctness, risk, controls and proof; write a PR body | `arrs-review`    |
| Assess incoming-work readiness                                | `arrs-triage`    |
| Resume work with fresh context                                | `arrs-handoff`   |
| Capture/validate task evidence                                | `arrs-proof`     |
| Maintain a Feature Map or classify scope risk                 | `arrs-feature`   |
| Investigate a decision against primary sources                | `arrs-research`  |
| Run a bounded design experiment                               | `arrs-prototype` |
| Author or adapt an ARRS workflow                              | `arrs-author`    |

Read only the workflow and context pointers needed for the task. A specification records goal, acceptance, Feature Maps, invariants, boundaries, verification, risk and unresolved decisions. Executable slices carry those facts independently. The implementation sequence is locate context → establish risk → inspect the paved road → smallest correct change → static checks → tests → behavior verification → proof/review. A fresh agent starts with a saved work item or plan rather than the originating conversation.

## Examined upstream

The current [Matt Pocock skills repository](https://github.com/mattpocock/skills/tree/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d) was read directly on **2026-10-05**, at full commit **`4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d`**, package version **1.3.1**. Its license is MIT, Copyright (c) 2026 Matt Pocock. The full copyright and permission notice is in [NOTICE](../NOTICE) and the pristine [upstream license](../upstream/mattpocock/source/LICENSE); installation retains it in `UPSTREAM-LICENSE`. The upstream `pr` credit for Dex Horthy/Humanlayer is preserved in the reference snapshot; ARRS review/report instructions use independently written prose and proof links.

ARRS inspected all 38 discovered skill entry points: 20 active engineering skills and all relevant misc, draft and productivity workflows, including handoff and authoring. Every entry receives an explicit ADOPT, ADAPT, WRAP, REPLACE or EXCLUDE disposition. The [compatibility assessment](../upstream/mattpocock/README.md) summarizes the decisions; [compatibility.json](../upstream/mattpocock/compatibility.json) records purpose, invocation, inputs/outputs, dependencies, assumptions, tracker behavior, minimal-context fit and risk/proof/architecture-gate compatibility for each. No active engineering workflow was omitted because its name differed from an older list.

The [pristine snapshot](../upstream/mattpocock/source) remains separate from [ARRS workflows](../skills). Its [manifest](../upstream/mattpocock/manifest.json) inventories every upstream tracked file, not only known skills. Supporting references, scripts and invocation metadata retain their hashes. They are reference evidence and are never executed by ARRS. Symlink blobs are preserved as inert regular text files containing their original target bytes; the manifest retains git modes. npm omits certain source filenames from published tarballs. The small [packaging blob manifest](../upstream/mattpocock/packaging-blobs.json) declares exact base64 bytes and SHA256 for those paths. The reader uses a fallback only when the physical file is absent, validates it against the original pinned inventory, and checks physical files independently. Staging materializes the original bytes in the local cache without writing into the installed package. [Pack provenance](../skills/provenance.json) records per-workflow adaptation versions, full source-bundle hashes and major behavior changes outside the invocation body. Native ARRS proof and Feature Map/risk workflows carry explicit native provenance.

## Install and inspect offline

```sh
arrs skills install
arrs skills test
arrs skills status
arrs skills diff
```

Installation creates missing files, reports byte-identical files and preserves conflicts. A conflicting local adaptation or metadata file is never overwritten. Resolve conflicts deliberately and rerun tests. `status` reports installed revision, local document modifications, integrity errors, staged revision and changed/new/deleted sources. `diff` includes changed source before/after text and the affected ARRS variants (source excerpts are bounded at 12,000 characters). Source text from an older revision remains available after reconciliation at `.arrs/skills/base`; losing that ignored cache limits text diff while inventories and installed workflows remain usable.

Installed packs and reconciliation candidates share one authoritative semantic validator in `src/core/skills-check.ts`. `skills test`, doctor and audit enforce the same strict metadata, workflow, source-provenance and exact pinned MIT attribution contract, including prohibited vendor-specific invocation and nonempty required terms. Valid reconciled packs are checked against their own installed pins; the bundled revision is not imposed. Workflow staging separately verifies the full source inventory and byte hashes before use, and keeps fetching and writes outside core.

Normal status, diff, test and invocation require no GitHub access. Static pack tests check frontmatter, required workflow concepts, concise input/workflow/completion contracts, document hashes, pinned source-bundle provenance and attribution. These tests do not establish that a model will follow the prompt. Use executed task Proof Contracts, independent review and local outcome metrics to assess workflow/model combinations.

## Stage, review and reconcile an upstream update

Fetching is an explicit network opt-in and stages source only:

```sh
arrs skills sync --fetch
# Reproducible fetch of a particular full commit:
arrs skills sync --fetch --revision <40-character-commit-sha>
arrs skills diff
```

`status --fetch` and `diff --fetch` use the same staging path. Fetching uses git object reads with checkout disabled; ARRS does not install packages, run hooks or execute remote scripts. A changed license requires manual license review and an explicit `--license-reviewed` reconciliation flag; the complete reviewed notice is then preserved. Snapshot inventories and hashes are validated before use. A different outstanding candidate is preserved until reconciled or explicitly removed from `.arrs/skills/staged`.

For an offline update, supply a directory containing `manifest.json` and `source/`. The manifest must use schemaVersion `0.1`, the upstream repository URL, a full revision, MIT license metadata, date, `files` path-to-SHA256 inventory and every discovered `skillSources` entry. Copying the checked-in `upstream/mattpocock` directory illustrates that shape:

```sh
arrs skills sync --source /path/to/snapshot
arrs skills diff
```

Read changed upstream material and the affected variants. Decide whether each existing affected workflow can remain unchanged or needs deliberate edits. Each affected workflow requires an explicit keep or new adaptation version; local edits always require a new version:

```sh
# After inspecting a changed TDD reference, retain ARRS's existing discipline:
arrs skills reconcile --rationale 'ARRS already covers the revised interface-testing guidance.' --keep arrs-tdd

# Or deliberately edit .agent/skills/arrs-tdd/SKILL.md, then:
arrs skills reconcile --rationale 'Carry the revised reproduction guidance into the ARRS proof loop.' --adaptation arrs-tdd=0.1.1
```

Repeat `--keep`/`--adaptation` for all affected workflows. Reconciliation validates the edited pack before writing metadata. A broken contract leaves the old provenance intact and the candidate staged. A successful reconciliation updates hashes, source-bundle pins and versioned rationale history, and retains the edited document bytes. It never replaces adaptations with upstream files.

New source skills are discovered from the full inventory. Each new entry requires a deliberate disposition. For example:

```sh
arrs skills reconcile --rationale 'This new workflow is outside our supported repository scope.' --disposition skills/engineering/new-flow/SKILL.md=EXCLUDE
```

To select a new source, author or choose an ARRS pack entry first, then use `--disposition <source>=ADAPT --map-source <source>=<arrs-id>` and `--adaptation <arrs-id>=<new-version>` (or `--keep <arrs-id>` after checking the existing contract). Deleted selected sources require `--disposition <source>=EXCLUDE`; their ARRS document is preserved. Reconciliation decisions are saved in `provenance.json`. Update the human compatibility assessment when adding a new supported workflow so its assumptions and gates remain explicit.

`.arrs/skills` is an ignored source comparison cache; installed `pack.json`, `manifest.json`, `provenance.json`, license and workflows are durable repository artifacts and should be versioned. Pack provenance is locally editable evidence, not a signed attestation against a malicious repository author. Deliberate upgrades of the CLI's bundled pack remain a maintainer release operation.

## Author an ARRS-compatible workflow

Use [arrs-author](../skills/arrs-author/SKILL.md). Keep the discoverable description focused on distinct trigger branches. Declare concrete inputs, ordered steps and a checkable completion artifact. Read context on demand. Integrate the applicable risk, architecture, verification and proof gates; avoid introducing an unconditional approval or publication step beyond the repository policy. A reusable workflow earns a skill; a rule already enforced by code usually does not.

When deriving from third-party work, record pinned source entry points and supporting hashes, adaptation version and material changes in provenance. Retain the license notice. Run pack tests and exercise meaningful tasks with proof and review before treating a new workflow as suitable for unattended work.
