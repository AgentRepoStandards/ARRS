---
name: arrs-debug
description: Diagnose a bug or regression using an executed reproduction and root-cause proof.
---

# arrs-debug

## Inputs

Bug report and repository context, reproduction inputs or explicit missing access.

## Workflow

1. Locate the affected Feature Map and establish risk. Build and execute one reproduction that drives the reported symptom. Capture before evidence with a failing verdict and exact input; minimize while preserving the failure.
2. If access prevents reproduction, record attempts and the missing access or input as needs-information. Proceed only with diagnostic work supported by evidence; do not report a proven fix without the original reproduction.
3. Rank falsifiable hypotheses and change one variable per probe. Explain the root cause using observed behavior, not a coincidental green test. For performance, capture a repeatable baseline and threshold.
4. Protect the reproduced behavior at the correct public interface with a regression test where practical. Fix the root cause; rerun the original scenario unchanged and capture passing after evidence.
5. Remove temporary instrumentation and secret-bearing artifacts. Run required static checks, tests and behavior verification. Validate the bug proof linking the same scenario before and after. Record an absent regression seam as residual risk and a Gardener candidate.

## Completion

Root-cause explanation, regression protection and validated failing/passing proof.
