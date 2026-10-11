# Add an export verification target

## Objective and acceptance

Demonstrate that the existing export command produces a valid report containing all selected records. Acceptance: three fixture records produce three report rows with stable identifiers; an empty selection produces a valid report with no data rows.

## Repository context and constraints

Read the export Feature Map and its owning module before editing. Use the existing report serializer and CLI test harness. Keep fixtures local and generated reports under `.arrs/`. Classify the change R2 because it adds executable product acceptance evidence.

## Decisions

Test at the CLI boundary so the argument parser, record selection and serializer all participate. Reuse the existing fixture format rather than adding another test framework.

## Milestones and verification

1. Locate the actual export entry point, configured verification target and current tests. Complete when the baseline command and existing ownership are recorded.
2. Implement populated and empty export scenarios. Complete when both pass and a deliberately broken serializer makes verification fail.
3. Run check, test and verification, produce a Proof Contract and obtain independent review. Complete when all required results and review are recorded.

## State and discoveries

Planned; implementation has not started. No baseline command has been executed yet. The implementing agent records discovered paths and commands here before changing source.

## Handoff and completion evidence

At each milestone record changed paths, exact command outcomes, proof artifact paths, blockers and the next action. Completion requires passing acceptance evidence and the configured risk review gates; the plan's initial state is not a verification claim.
