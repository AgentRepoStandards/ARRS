---
name: arrs-handoff
description: Prepare another minimal-context agent to resume work from durable repository artifacts.
---

# arrs-handoff

## Inputs

Current work item, execution plan, repository revision and evidence.

## Workflow

1. Read the current execution plan/work item and verify repository state. State the objective, current revision, changed scope and Feature Maps without relying on remembered chat.
2. Capture decisions and constraints by pointer, with the risk class and required review or approval. Include exact commands already run, exit codes, evidence paths and unresolved verification.
3. Record blockers, failed hypotheses and known residual risks. Name the next independently executable action and its completion criterion.
4. Save the handoff beside the persistent execution plan or local work item so another harness can find it. Use repository-relative pointers for portability and verify each pointer resolves; omit secrets and unnecessary personal data.
5. Read the handoff as a fresh agent: can it locate context, establish risk, understand state, execute verification and decide what comes next? If any answer depends on the original conversation, add the missing durable context.

## Completion

Portable handoff with objective, state, next action and verified context pointers.
