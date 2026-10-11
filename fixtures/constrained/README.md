# Constrained task-preview example

This small repository previews a task, normalizes a valid title and rejects a blank title. It shows the **constrained** adoption stage of ARRS.

From the ARRS checkout root, run:

```sh
npm run build
cd fixtures/constrained
node ../../dist/cli.js init
node repo test
node repo verify task-preview
node ../../dist/cli.js audit --execute --require-level 2
```

Expected executed audit level: **2**. The domain boundary is enforced. There is no captured change proof until you generate it.

Initialization preserves the example's existing configuration and source. It creates the local scoped evidence marker needed before proof in a fresh checkout; review its summary for any preserved unsafe conventions. The commands exercise the real task-preview CLI, including blank-title rejection. This example intentionally lacks the skills, CI and work-state controls required for level 4.

See the [main README](../../README.md), [verification guide](../../docs/verification.md) and [Proof Contract](../../docs/proof-contract.md) for adoption and change evidence. To return to the ARRS root, run `cd ../..`.
