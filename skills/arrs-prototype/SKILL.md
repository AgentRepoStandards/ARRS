---
name: arrs-prototype
description: Build a bounded experiment to answer a behavior or interface design question.
---

# arrs-prototype

## Inputs

Concrete design question, scratch inputs and bounded risk.

## Workflow

1. Name the question, acceptance observation and scope. Establish risk; use scratch inputs and local resources appropriate to the policy.
2. Choose the simplest runnable artifact for the question: a behavior harness, interface sketch or UI variant. Keep it clearly marked as an experiment and isolate its generated outputs from production source.
3. Execute the experiment and capture observable behavior. Record inputs, command, result, uncertainty and what the evidence can establish.
4. Save the decision and evidence pointers in the work item or ADR. Keep experiment code only where the repository deliberately stores experiments; clean up temporary resources.
5. Implement any accepted production change through the ordinary gates and Proof Contract. A prototype's successful run is decision evidence, not full production verification.

## Completion

Executed experiment and a recorded decision with evidence and limits.
