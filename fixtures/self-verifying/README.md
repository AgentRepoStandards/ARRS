# Self-verifying task-preview example

This small repository previews a task, normalizes a valid title and rejects a blank title. It shows the **self-verifying** adoption stage of ARRS.

From the ARRS checkout root, run:

```sh
npm run build
cd fixtures/self-verifying
node ../../dist/cli.js init
node repo test
node repo verify task-preview
node ../../dist/cli.js proof run proof-plan.json --execute
node ../../dist/cli.js audit --execute --require-level 3
```

Expected executed audit level: **3**. Current behavioral proof establishes the task-preview acceptance scenario.

Initialization preserves the example's existing configuration and source. It creates the local scoped evidence marker needed before proof in a fresh checkout; review its summary for any preserved unsafe conventions. The commands exercise the real task-preview CLI, including blank-title rejection. This example intentionally lacks the skills, CI and work-state controls required for level 4.

See the [main README](../../README.md), [verification guide](../../docs/verification.md) and [Proof Contract](../../docs/proof-contract.md) for adoption and change evidence. To return to the ARRS root, run `cd ../..`.
