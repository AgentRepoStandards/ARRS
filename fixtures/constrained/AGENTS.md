# ARRS repository map

Use the smallest correct change. Inspect the existing paved road before adding abstractions. Respect boundaries and fix root causes. Keep tests, compiler, static analysis and CI controls effective; preserve failures until corrected. Protect secrets; justify dependencies.

- Commands: `./repo --help` and `./repo check`; configure missing commands in `arrs.json`.
- Locate a feature: `docs/features/`; follow its paths, invariants and verification target.
- Architecture changes: `docs/architecture/` and `.agent/policies/architecture.json`; decisions in `docs/adr/`.
- Domain questions: `docs/product/`.
- Establish risk using `.agent/policies/risk.json`. Complete the Proof Contract through ARRS proof commands; record necessary independent review/human approval.
- Substantial work: `.agent/plans/`; handoff with current state and evidence.
- Workflows: `.agent/skills/` (install with `arrs skills install`).

Read deeper context only for the task at hand. Do not weaken controls to pass a failing implementation or bypass verification.
