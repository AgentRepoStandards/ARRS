# Separate execution authorization, technical proof and implementation review

Status: accepted for issue #4 implementation; separate implementation review and policy acceptance remain required.

Proof start must capture a bug/refactor baseline before implementation. Requiring independent implementation review at this point creates an impossible ordering, and changing the frozen session afterwards destroys baseline integrity.

Keep three stages. An optional `authorization.humanApproval` in a proof plan or work item records policy-required permission to execute. Technical proof validation checks commands, outcomes, logs, scope and current policy without claiming completed review. Technically passing evidence supports `ready-for-review`. Accepted evidence additionally requires an implementation-stage review attached to the selected canonical manifest when the current risk policy requires independent review or human approval. Completed work and the audit proof-evidence control share this accepted validator.

`arrs proof review <manifest> <review-input>` accepts a versioned implementation-stage record containing the actual independent review and/or human approval required by policy. It first validates successful current canonical evidence, then exclusively writes an append-only `review-<uuid>.json` beside that manifest. The generated record binds proof ID, raw manifest SHA256, exact scope hashes and review timestamp. It never edits the session, logs or manifest. `arrs proof validate` remains technical; `--accepted` reproduces the completion/audit gate. Every retry has a new ID and requires its own binding.

Compatibility: retain v0.1 schemas and add optional authorization plus a separate v0.1 review schema. Legacy `review.humanApproval` may supply execution permission when no explicit authorization is present. Legacy `review.independent` remains readable as an ambiguous plan note, never automatically completed review. Previously generated evidence stays technically readable; evidence requiring review needs a new explicit attachment to qualify for acceptance. R0/R1 evidence with no configured review requirements continues to qualify through technical checks. No signed attestation or authenticated reviewer identity is added; records remain local, editable assertions supporting honest workflow and review.

Bundled proof, review and implementation workflows receive versioned adaptations. Installed repository variants remain preserved on conflict and require deliberate upgrade.
