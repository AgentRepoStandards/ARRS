# Feature Maps v0.1

A Feature Map is a JSON document validated by `schemas/feature.schema.json`, whose identifier contains version `0.1`. Place maps in the configured `knowledge.features` directory. Map product or system capabilities that need ownership, invariants and verification; internal helpers need no separate map unless they form an important contract.

All fields are required:

| Field                           | Meaning                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `schemaVersion`, `id`, `goal`   | Version `0.1`, stable feature identity, user/system outcome.              |
| `owners`                        | Accountable module identifiers declared in the architecture policy.       |
| `entryPoints`, `implementation` | Repository-relative paths where behaviour enters and lives.               |
| `boundaries`, `dependencies`    | Declared module boundaries and other Feature Map identifiers relied upon. |
| `domainTerms`, `invariants`     | Domain language and conditions changes must preserve.                     |
| `sensitivity`                   | `none`, `internal`, `sensitive` or `critical`.                            |
| `acceptance`                    | Observable acceptance behaviour.                                          |
| `verification.target`           | A key in `arrs.json`'s `verifyTargets`.                                   |
| `risk`                          | Baseline `R0` through `R4`; task classification can raise it.             |
| `related`                       | Repository-relative documentation/ADR references.                         |

The audit validates structure, referenced paths, declared ownership/boundaries and verification linkage. `owners` and `boundaries` use declared module identifiers; `dependencies` names other mapped features. Sensitive features require at least R3, and critical features require R4. It can detect removed paths and missing targets. It cannot determine whether a still-existing implementation matches every prose invariant or whether a linked test proves the intended outcome.

On a behaviour or boundary change, update the affected map in the same change. Split a map when separate ownership and acceptance make independent execution clearer. Combine maps when they merely repeat the same contract.

See [ARRS's own maps](features) for complete examples. Empty arrays are appropriate only when the concept genuinely has no applicable entries; they must not conceal unknown ownership or missing acceptance.
