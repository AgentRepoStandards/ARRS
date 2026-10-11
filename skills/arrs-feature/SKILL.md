---
name: arrs-feature
description: Maintain a Feature Map or classify the risk of a bounded repository change.
---

# arrs-feature

## Inputs

New or changed behavior, affected paths and repository risk policy.

## Workflow

1. Locate the relevant Feature Map through `arrs.json`. Read its goal, entry points, implementation, boundaries, dependencies, domain terms, invariants, sensitivity, acceptance and verification target.
2. For new meaningful behavior, create a schema-valid map. Update existing maps when contracts, paths or verification change. Internal helpers need no separate feature unless they represent a meaningful capability.
3. Classify risk using the highest relevant policy class and sensitive paths. Document why the change qualifies, its required checks, independent review and human approval. Resolve uncertainty conservatively and record the assumption.
4. Confirm mapped paths and related pointers exist, the configured verification target is runnable and acceptance describes observable outcomes. Run `arrs validate feature <map.json>` to validate the schema and run the audit's stale-reference checks.
5. Preserve evidence for the maintenance change with proportionate proof; changes to acceptance or invariants that affect behavior follow arrs-implement.

## Completion

Schema-valid current Feature Map and justified risk/gate classification.
