---
name: arrs-design
description: Design a module interface or strengthen mechanically enforced architectural boundaries.
---

# arrs-design

## Inputs

Architectural friction or design requirement with affected modules and behavior.

## Workflow

1. Locate the affected Feature Maps, architecture policy and ADRs. Establish risk and the observable behavior to preserve. Inspect callers before creating a new abstraction.
2. Compare interface choices by how much behavior they hide, where knowledge concentrates and how callers verify them. Prefer the simplest interface justified by real variation. Keep domain language aligned with product context.
3. Express dependency direction, public interfaces and generated-code boundaries in the repository's mechanical policy or stack adapter. ARRS's TypeScript/JavaScript adapter is one supported adapter; other stacks require their own executable gate.
4. Demonstrate a clean pass, an intentional forbidden import failing, and a restored pass. Retain the actual gate output. A prose boundary alone does not prove enforcement.
5. Make a bounded change with before/after behavior evidence, required checks and review. Update maps and consequential ADRs. Validate the refactor proof before completion; route broader improvement candidates through arrs-gardener.

## Completion

Small interface decision, executable boundary gate and behavior-preserving proof.
