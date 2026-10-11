---
name: arrs-review
description: Review a change against acceptance, architecture, risk and its executable proof.
---

# arrs-review

## Inputs

Fixed comparison baseline, work contract, diff and proof package.

## Workflow

1. Pin the comparison baseline and reviewed revision or working tree. Read the specification/work item, affected Feature Maps, risk policy, boundary policy and relevant repository standards.
2. Review correctness and scope against acceptance, invariants and error behavior. Independently review architecture, security implications and dependency changes. Use separate reviewers when required and available; serial explicit axes work when parallel agents are unavailable.
3. Inspect tests and real behavior evidence. Run proof validation and relevant configured gates. Check that logs and scope match the reviewed change. Technical proof permits review readiness; permission to execute or review of a proposed plan does not constitute review of the completed change.
4. Examine changes to controls: removed tests, skipped checks, compiler/lint suppressions, weakened thresholds, CI shortcuts and undocumented exceptions. Treat a green result obtained by weakening a control as a finding.
5. Report actionable findings with file pointers, impact and evidence. Keep missing proof, wrong risk and unresolved acceptance visible. Review completion requires all blocking findings resolved and gates rerun after fixes.
6. After resolving findings, attach actual implementation-stage independent review and policy-required human acceptance to the selected canonical proof with `arrs proof review <manifest> <review-input>`. Verify `arrs proof validate <manifest> --accepted`. Binding covers attempt ID, manifest bytes and scope; rerun/review after changes and never inherit another retry's approval. Local text is not authenticated identity.
7. When writing a PR body, state the concrete behavior change, executed evidence, residual risk and required review. Link the proof package. Publication follows repository authorization.

## Completion

Independent findings or reasoned review outcome; concise evidence-backed PR description when requested.
