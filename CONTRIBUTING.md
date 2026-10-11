# Contributing

ARRS changes should improve observable repository behaviour and preserve existing failure detection. Start with the relevant Feature Map and the [architecture](docs/architecture/README.md); use [AGENTS.md](AGENTS.md) for contextual routing.

Use Node.js 22 or later, npm 10 or later, Git 2.52.x and a `python3` executable for the candidate-adapter tests. The Git changeset adapter deliberately rejects other Git versions; hosted CI provisions the verified installations described in the [toolchain guide](docs/ci-toolchain.md). Install dependencies with `npm ci`. Run `npm run check`, `npm test` and `npm run verify` before review. Run `npm run audit` for the complete self-assessment; this runs configured commands and therefore needs the same environment as local verification. Formatting fixes use `npm run format`.

For a fresh checkout, initialize the local evidence convention and establish current self-workflow proof before the complete audit:

```sh
npm run build
node dist/cli.js init
node dist/cli.js skills install
node dist/cli.js proof run .agent/proof-plan.json --execute
npm run audit
```

Initialization preserves existing source/configuration and creates missing scoped evidence protection. Proof capture runs the configured checks; the executed audit also runs commands and Feature Map targets. A fresh checkout has no captured proof, so missing evidence is an adoption prerequisite rather than evidence that the application failed. The self-workflow plan demonstrates repository operation and scopes the README; implementation changes still need their own risk-classified change proof and actual review. On Windows, `node repo check`, `node repo test` and `node repo verify` use the same command mappings.

For a bug, retain a failing reproduction and prove the same scenario passes after the fix. For new behaviour, make acceptance criteria executable. For a refactor, compare equivalent behaviour before and after. For documentation, check links, command examples and schema compatibility proportionately. Follow [Proof Contracts](docs/proof-contract.md) and [risk policy](docs/risk.md).

Changes to schemas or policy must include valid and invalid examples. CLI changes need a user-visible success and failure scenario. Initialization and skills updates must preserve user-owned files. Keep generated evidence under `.arrs/`; use a small committed fixture when reviewers need durable evidence.

Explain the concrete problem, resulting behaviour, risk, checks and remaining limitations in a review request. Record consequential decisions as short [ADRs](docs/adr/0001-versioned-json-and-argv.md). Justify dependency additions and control exceptions. Preserve upstream attribution; use the deliberate skills reconciliation process for upstream changes.

Do not commit credentials, personal work data, generated logs or the build output. ARRS is MIT-licensed; third-party source retains its own license and provenance in `NOTICE` and `upstream/`.

The workflow pins third-party Actions to immutable commits. To update one, verify the commit in the official action repository, retain the major-version comment, and review the workflow diff under the risk policy. Raw `.arrs/` evidence stays local; inspect and sanitize any material before deliberately sharing it. Before the first reviewed source push, repository administrators must enable Actions in the destination settings and verify that the authorized launch can run the workflow. All four Node 22/24 jobs on Ubuntu and Windows must pass for launch; their actual hosted results remain pending. Release preparation has not verified or changed the setting, and the workflow file alone does not establish a passing hosted matrix or qualify hosted receipts.
