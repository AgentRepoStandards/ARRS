---
name: arrs-proof
description: Plan, capture or validate the evidence required to finish an ARRS task.
---

# arrs-proof

## Inputs

Task contract, category, acceptance criteria, risk and configured commands.

## Workflow

1. Read the work contract, affected Feature Maps and risk policy. Record actual required human execution permission in `authorization.humanApproval` before capture; do not claim review of an unwritten implementation. Choose category bug, feature, refactor or docs. Plan the configured checks and the behavior scenario covering every acceptance criterion.
2. For a bug, capture a failing before run and a passing after run of the same scenario. For a refactor, capture successful before/after runs of the preserved scenario. For a feature, execute real behavior against acceptance. Docs/mechanical work uses proportionate mechanical checks.
3. Use `arrs proof run <plan.json> --execute` for feature/docs tasks. For bugs/refactors, run `arrs proof start <plan.json> --execute` before editing, then `arrs proof finish <session.json> --execute` after the correction/refactor. A failed/interrupted finish can retry from the original session; each immutable attempt returns its own chosen manifest path. Execute configured commands with retained exit codes. Store logs and generated evidence at the configured ignored evidence location. Record scope, risk, residual risks and justified deviations in the machine-readable proof manifest.
4. Run `arrs proof validate <proof.json>`. Validate manifest semantics, command outcomes, log hashes and current scope hashes using the proof CLI. Required failed checks keep the proof failed regardless of other successful steps.
5. Request actual independent implementation review and human acceptance where policy requires them after technical verification. Attach their implementation-stage records with `arrs proof review <chosen-proof.json> <review-input.json>`; run `arrs proof validate <chosen-proof.json> --accepted`. Completion/audit require review bound to this attempt, manifest bytes and scope. Retry never inherits another attempt review; legacy plan notes do not replace completed review. Report completion only when all required evidence and gates pass. Local proof supports reproducibility and review; it is not a signature proving an untrusted author executed a command.

## Completion

Validated proof manifest, log artifacts, scope integrity and explicit result.
