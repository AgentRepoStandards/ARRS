---
name: arrs-domain
description: Sharpen product terms, invariants and domain boundaries in durable repository context.
---

# arrs-domain

## Inputs

Ambiguous domain language, concrete scenarios and affected Feature Maps.

## Workflow

1. Read the relevant product/domain document and Feature Maps reached through `arrs.json`, then inspect the current implementation. Identify ambiguous terms or contradictory invariants with concrete examples.
2. Resolve facts against code and acceptance behavior; reserve genuine domain decisions for the responsible owner. Record canonical product terms with meaning and boundaries, without turning the glossary into implementation notes.
3. Stress-test edge cases across the affected boundaries. Update Feature Maps when goals, domain terms or invariants change; keep verification tied to those invariants.
4. Record consequential trade-offs in an ADR with alternatives and effects. Reclassify risk if the change touches public contracts, persistent data or privacy.
5. Validate updated maps and references. A terminology-only task uses proportionate mechanical proof; changed behavior follows arrs-implement and its Proof Contract.

## Completion

Consistent product terms, invariants, validated maps and justified ADRs.
