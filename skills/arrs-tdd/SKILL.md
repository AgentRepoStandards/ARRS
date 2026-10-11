---
name: arrs-tdd
description: Build or fix observable behavior with a red–green cycle and a complete Proof Contract.
---

# arrs-tdd

## Inputs

Acceptance criteria, risk and an existing or justified public interface.

## Workflow

1. Read acceptance, Feature Maps, risk policy and the existing public interface. Choose a vertical behavior slice, with real system boundaries or justified test stand-ins.
2. Write one test that fails on the intended behavior. Execute it and retain red evidence. Distinguish an assertion failure from a broken harness.
3. Implement the smallest change that makes that test green. Execute it. Repeat one behavior at a time; expected values come from independently stated acceptance, not a copy of the implementation.
4. Refactor only with established behavior protected and within the authorized scope. Preserve regression coverage while improving the interface; record the before/after scenario for a refactor proof.
5. Run configured static checks and full relevant tests, then real behavior verification. A unit-test green result covers only its tested interface. Validate the task-category proof and required risk review before declaring done.

## Completion

Executed red/green evidence, stable tests and a validated task proof.
