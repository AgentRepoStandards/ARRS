# Work items and state v0.1

When a bug/refactor proof finish is retried, set `proof` to the explicit manifest path returned by the chosen successful attempt. Each finish receives a distinct attempt ID; the original session identifies its baseline, not its current outcome. A failed attempt cannot establish `ready-for-review`, while a current successful attempt can be assessed against the work item's task, risk, category, acceptance and verification targets. Retain earlier failed/interrupted attempts and never replace their logs to make a work transition pass. See [proof retries](proof-contract.md).

The conceptual work item is tracker-independent. Its JSON contains `schemaVersion`, `id`, `title`, `state`, `risk`, `category`, `featureIds`, `acceptance`, `context`, `verificationTargets`, `dependencies` and `decisions`; optional execution authorization and proof references are supplied when available. Legacy review notes remain readable. It carries enough repository references and observable criteria for independent execution.

`context` contains repository-relative paths rather than freeform instructions. Use a plan or linked document for detailed decisions. The [example work item](../templates/work-item.json) is draft report-export work: adapt its feature, context paths and verification target to the actual repository before moving it to ready.

Risk, category and verification evidence remain structured fields. Task risk must meet both its named features' baseline and context-path floors. A label is a display adapter, not the sole record of risk or proof. A link to an original conversation cannot substitute for required context.

Every verification target must be an explicitly configured own entry in `arrs.json.verifyTargets`. Inherited object names such as `toString` cannot establish readiness when absent from configuration. Deliberately configured names such as `toString` or `constructor` remain valid under the existing target-name schema. Invalid readiness transitions fail before changing the work-item file.

| State                 | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `needs-triage`        | Scope, risk and suitability need assessment.                        |
| `needs-information`   | Required context or a decision is missing.                          |
| `ready-for-agent`     | Scope, context, acceptance, dependencies and risk permit execution. |
| `in-progress`         | An agent owns the bounded implementation.                           |
| `verification-failed` | Required proof is incomplete or failing.                            |
| `ready-for-review`    | Valid proof is available for the required review.                   |
| `human-required`      | Policy or an unresolved decision requires human action.             |
| `completed`           | Proof and required review/approval are complete.                    |
| `rejected`            | A recorded decision declines the work.                              |

Validate and transition an item with:

```sh
arrs work validate .agent/work-items/export.json
arrs work transition .agent/work-items/export.json --to in-progress
```

Supply `authorization.humanApproval` before policy-controlled `ready-for-agent`/`in-progress` transitions (legacy `review.humanApproval` is the fallback). Permission to execute does not claim human approval of the completed implementation. A current technically valid selected proof permits `ready-for-review` without premature independent review. Attach actual implementation review with `arrs proof review`, then validate `proof validate --accepted`. `completed` uses the same accepted-evidence gate as audit and requires review bound to that attempt under current policy; work-item plan notes do not replace it. Attachments never rewrite the baseline or proof. R0/R1 with no required review retain technical-only acceptance.

The transition command validates readiness and completion gates and writes only the local work-item file. Review/completion proof must cover the item's category, acceptance criteria and required verification targets. R4 work cannot become `ready-for-agent`; route it through `human-required` for human-controlled decisions. Move work with failed proof to verification failure; record unresolved information or human judgement in its explicit state. The rejected state should retain the decision that explains why the work will not proceed.

Transitions are explicit rather than automatic:

| From                    | Allowed next states                                                               |
| ----------------------- | --------------------------------------------------------------------------------- |
| `needs-triage`          | needs-information, ready-for-agent, human-required, rejected                      |
| `needs-information`     | needs-triage, ready-for-agent, human-required, rejected                           |
| `ready-for-agent`       | in-progress, needs-information, human-required, rejected                          |
| `in-progress`           | verification-failed, ready-for-review, needs-information, human-required          |
| `verification-failed`   | in-progress, human-required, rejected                                             |
| `ready-for-review`      | completed, in-progress, human-required, rejected                                  |
| `human-required`        | needs-triage, ready-for-agent, in-progress, ready-for-review, completed, rejected |
| `completed`, `rejected` | Terminal; create a new work item for new work.                                    |

## GitHub label adapter

Configure a repository's names in `.agent/policies/work-labels.json` using a `states` mapping from the nine canonical states to labels. For example, `ready-for-agent` may map to `arrs:ready` and `human-required` to `arrs:human`. Different repositories may use different names without changing the state model.

Use the [example mapping](../templates/work-labels.json) to prepare labels and issue bodies. v0.1 does not create issues, change remote labels or implement a hosted backlog. A human or external tracker integration translates the local structured work item and configured labels. Preserve the work item's risk and proof references in the issue body.

Inspect [scoped readiness](readiness.md) before a transition with `arrs readiness work <file> --json`. Advice retains shared validator errors and separates agent execution, human-controlled execution, technical review readiness and completed acceptance. The command performs no transition or execution.
