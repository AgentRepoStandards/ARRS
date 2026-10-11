---
name: arrs-adopt
description: Bootstrap ARRS, install its workflow pack or assess repository compliance.
---

# arrs-adopt

## Inputs

New or existing repository and actual standard commands.

## Workflow

1. Inspect existing operating docs, configured commands, architecture and verification. Preserve existing work. Select a bounded adoption step appropriate to the repository's current maturity.
2. Run `arrs init` for the deterministic non-destructive scaffold. Review conflicts and reconcile them deliberately. Configure real argv commands for setup, dev, check, test, verify and build in `arrs.json`; unconfigured commands fail explicitly.
3. Establish product/architecture pointers, Feature Maps, boundary policy and risk policy for meaningful behavior. Empty architecture modules are unconfigured setup, not a constraint. Select the supported CI workflow explicitly when discovery is ambiguous. Review manifest dependency inventory and record rationale; presence grants no approval. Select stack-specific controls that actually execute.
4. Run `arrs skills install`, then `arrs skills test` to validate the pack. Review preserved conflicts instead of overwriting adaptations. The pack remains usable offline and uses ordinary Markdown workflows.
5. Run `arrs doctor` and `arrs audit`; distinguish incomplete, blocked, unsupported and unevaluated controls from actual failures. Doctor's instruction/CI presence checks have narrower claims than audit. Use `arrs audit --execute` after reviewing trusted configuration to execute configured gates before claiming an execution-based level. Save the actual report and verification evidence. Follow supported configured knowledge, skills and local work paths; a control file alone is not proof that its control works.

## Completion

Preserved existing files, usable config/pack, honest compliance report and adoption evidence.
