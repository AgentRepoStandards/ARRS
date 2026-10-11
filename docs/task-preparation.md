# Bounded task preparation

Prepare a task from a local [work item](work-items.md) in `needs-triage`, `needs-information` or `human-required`. Selected features, objective and acceptance criteria remain authoritative. Preparation reads local repository files, assembles a packet and drafts contracts; it runs no repository command, performs no network operation, allocates no proof and changes no work state.

```sh
arrs prepare .agent/work-items/report-export.json --json
arrs prepare .agent/work-items/report-export.json --output .arrs/prepared/report-export
arrs prepare .agent/work-items/control-change.json --json \
  --baseline /absolute/path/to/retained-known-good --baseline-sha256 <retained-digest>
```

The [example work item](../templates/work-item.json) is a draft for an explicitly mapped report-export capability. Its referenced feature, implementation and verification target must actually exist in the consumer repository; preparation does not guess natural-language scope or fabricate product knowledge.

The version `0.1` packet contains selected Feature Maps and declared dependency closure; exact invariants and implementation/entry-point paths; root and ancestor-scoped `AGENTS.md`; related decisions and bounded local document links; an ordered source inventory with SHA-256 digests, selection reasons and provenance; supplied unresolved decisions/dependencies; effective risk, autonomy and authorization/review gates; literal configured argv and effective timeouts; and draft work/proof documents or an incomplete proof proposal. Unrelated maps and source remain outside the inventory. Directory navigation references do not imply recursive coverage: indexes are followed within the navigation limit, while an explicit context or implementation directory inventories its bounded source subtree.

Packet identity is SHA-256 over its ordered content with the identity field empty. Identical input/repository/selected-baseline state reproduces the inventory and draft content. `--compare <packet.json>` reports stale identity and changed inventory paths; unsupported packet versions and damaged identity reject. Unrelated unreferenced source edits do not claim whole-repository coverage or invalidate the packet. Referenced source, configuration, policy or map changes do change identity. An inventory is task context, not a complete Git changeset.

Limits are explicit: work/scenario input 64000 bytes; 32 selected/dependency features and depth 8; 32 documents, navigation depth 2 and 64000 content bytes; 1024 inventoried files, 8 MiB per file and 64 MiB total source bytes. Omitted optional context is listed; exceeded document/source limits block a complete draft. Mandatory policy gates and commands remain visible even when document content exceeds its budget. Broken references, unknown features, cycles, unowned verification names, missing command mappings and unresolved decisions/dependencies block executable contracts. Own unusual verification names retain literal argv and timeout.

Exit 0 means preparation produced a complete technically valid draft. Exit 1 means input rejection, explicit blockers or stale comparison. Neither result grants execution readiness, proves product semantics, supplies approval or represents completed work. The draft work state stays `needs-information` or `human-required`. R4 remains human-controlled; existing actual execution authorization can be retained, and implementation acceptance must occur separately after passing proof and independent review. Candidate-only packets explicitly cannot authorize a governing-control transition; protected selection retains the stronger baseline/current floors, gates and command bindings and rejects missing/mismatched/drifting trust without fallback.

Feature tasks propose behavioral criterion links; docs tasks propose mechanical links. Required policy runtime verification can still block a docs-only mechanical proposal when scope carries runtime risk. Criterion links name exact supplied criteria and configured commands; a maintainer must assess whether those scenarios actually prove the behavior. Preparation never invents a baseline failure, expected success or review record.

For bug/refactor preparation, supply real before/after scenario identities and expected exits with `--scenarios <file>`. The [scenario schema](../schemas/prepare-scenarios.schema.json) requires version `0.1` and entries such as:

```json
{
  "schemaVersion": "0.1",
  "scenarios": [
    {
      "id": "report-export-empty-selection-reproduction",
      "target": "report-export-empty-selection",
      "criterion": "An empty selection produces a valid report with no data rows",
      "beforeExitCode": 1,
      "afterExitCode": 0
    }
  ]
}
```

The identity and target refer to the same scenario before and after. Bug scenarios need a supplied nonzero before exit and zero after exit; refactors need supplied zero exits for both. Missing or inconsistent information produces a proposal with explicit blockers. No baseline has been captured merely because preparation can draft its contract. Use the existing [proof lifecycle](proof-contract.md) to capture actual evidence.

Optional output creates a new directory strictly under repository-root `.arrs/` containing `packet.json`, a human-readable `packet.md`, `work.json`, and either `proof-plan.json` or `proof-proposal.json`. It requires an existing canonical scoped `.arrs/.gitignore` containing `*` (or `/*`) and optionally `!.gitignore`, with no other patterns. This intentionally bounded local convention avoids process probes and leaves existing ignore files untouched. Existing destinations, traversal, source destinations, symlinks and unsupported flags reject before writes; output never overwrites a prior packet. A blocked packet may be saved for review; a trust/input rejection saves nothing. Promoting drafts into source is a reviewed repository change.

Fresh agents can start with `packet.md`, locate implementation via the inventory, follow scoped instructions and inspect exact required commands and gates. Unresolved product decisions remain in the packet; generic advice does not replace them. The packet and schemas ship in the offline CLI package. The reusable core exports `prepareTask`, `comparePreparedTask` and `renderPreparedTask` for later read-only adapters.
