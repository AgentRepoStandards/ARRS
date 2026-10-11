# ARRS — Agent-Ready Repository Standard

ARRS helps maintainers make their repositories easier for coding agents to understand, change and verify. It gives an agent a clear route from a task to the relevant code, architecture rules, tests and review requirements—even when it starts with a fresh conversation.

It is a local TypeScript CLI and an open repository standard. You keep the contract and evidence in your repository, and use your existing coding agent, build tools and test suite. Ordinary operation needs no model API or hosted ARRS service.

## What you get

- **A map of the code:** `AGENTS.md` routes agents to Feature Maps describing where a capability lives, who owns it and what must remain true.
- **One command interface:** `./repo check`, `test`, `verify` and `build` run your existing commands through `arrs.json`.
- **Checks an agent can run:** schema validation and a JavaScript/TypeScript import checker catch invalid configuration and forbidden module dependencies.
- **Evidence for a change:** Proof Contracts retain command results, behavioral verification and source hashes so reviewers can inspect what ran and detect stale evidence.
- **Explicit review rules:** risk classes decide which changes require independent review or human approval. Audit reports which capabilities your repository has actually demonstrated.
- **Reusable workflows:** a pinned skill pack supports investigation, implementation, verification and handoff, with recorded upstream provenance.

ARRS is useful when agents repeatedly lose project context, miss existing verification commands or leave changes with unclear evidence. Start by mapping one important feature in your existing repository; the [adoption guide](docs/adoption.md) covers greenfield, structured and legacy projects.

## Try it locally

**Status:** v0.1 is an experimental implementation; see the [release notes](CHANGELOG.md). Install from a source checkout; these instructions do not assume a published npm package. Use Node.js 22 or later and npm 10 or later.

```sh
git clone https://github.com/AgentRepoStandards/arrs.git
cd arrs
npm ci
npm run build
npm link
arrs --help
```

For an isolated installation, run `npm pack`, then `npm install --global /absolute/path/to/arrs-cli-0.1.0.tgz`. The package includes the CLI, schemas, bootstrap assets and pinned skill pack.

In the repository you want to adopt:

```sh
arrs init --dry-run
arrs init
arrs doctor
arrs audit --json
```

Initialization preserves existing files and reports conflicts and missing configuration. A new repository will have incomplete diagnostics until you connect its real commands, documentation and module boundaries. Review the summary, edit `arrs.json`, and fill in one Feature Map under `docs/features/`.

For example, an existing `npm test` command becomes `"test": { "argv": ["npm", "test"] }` under `commands`. Add a real user-visible verification scenario to `verifyTargets`, then name that target in your Feature Map.

When the mappings are ready, run your repository's checks:

```sh
./repo check
./repo test
./repo verify
arrs audit --execute --json
```

On Windows, run `node repo check`, `node repo test` and `node repo verify` for the same interface.

`audit` is read-only by default. `--execute` authorizes the commands configured in the repository; review those commands before running them because they have the privileges of your local account.

## See a complete example

The [mapped](fixtures/minimal/README.md), [constrained](fixtures/constrained/README.md) and [self-verifying](fixtures/self-verifying/README.md) example repositories demonstrate adoption stages with a small executable task-preview application. The [verification guide](docs/verification.md) explains command execution and the evidence contract.

For a real change, use a [Proof Contract](docs/proof-contract.md): feature and documentation work uses `proof run`; bugs and refactors capture a baseline with `proof start` before editing and finish with `proof finish`. Keep generated evidence in ignored `.arrs/`. Passing technical evidence makes the change ready for review. When risk policy requires review, attach the actual completed review with `proof review` and check `proof validate --accepted` before completion. A retry has its own evidence and review. A proof is local engineering evidence; reviewers still assess acceptance criteria and the quality of the tests.

Use [scoped readiness](docs/readiness.md) to inspect one mapped feature or concrete local work item. `arrs readiness work .agent/work-items/export.json --json` reports effective risk, exact verification bindings, selected evidence and unresolved prerequisites without executing commands or transitioning work. A feature-only query leaves task suitability unknown.

Inspect evidence with `arrs proof explain`, `arrs proof history` or `arrs proof report`. A [local MCP client](docs/mcp.md) can access preparation and proof inspection through bounded read-only tools. The [offline receipt contract](docs/receipts.md) checks modeled external execution and review inputs while keeping local proof and hosted qualification distinct.

## Understand your audit

Levels are cumulative. A missing lower-level control prevents a higher level.

| Level | Name           | What it establishes                                                            |
| ----- | -------------- | ------------------------------------------------------------------------------ |
| 0     | Unmanaged      | The ARRS mapping contract is incomplete.                                       |
| 1     | Mapped         | Commands, knowledge, ownership and feature locations are discoverable.         |
| 2     | Constrained    | Executed checks can reject invalid changes.                                    |
| 3     | Self-Verifying | Required commands and current accepted behavioral proof pass.                  |
| 4     | Delegatable    | Risk, review, skills, CI invocation and work items support bounded delegation. |

The [v0.1 specification](docs/spec/0.1.md) defines the checked contract. An audit level describes observed repository capability; it grants no general permission for autonomous work.

## Current limits

The default import checker covers supported JavaScript/TypeScript syntax. An opt-in [Python adapter](docs/architecture/adapter-conformance.md) provides provisional bounded conformance; real application pilots and pilot-based language qualification remain pending. Other languages can use command mapping, context, risk and proof workflows, but need their own boundary checks. Security scanning and GitHub Actions inspection have documented heuristic limits. ARRS does not sandbox repository commands, certify security, authenticate local reviewer records or deploy production systems.

See [security](docs/security.md), [architecture](docs/architecture/README.md) and [risk](docs/risk.md) for those boundaries. Installed skills work offline; upstream update discovery requires explicit network access.

## Help test and contribute

Try the examples, then adopt one capability in a disposable checkout of your project. Report bugs in [GitHub issues](https://github.com/AgentRepoStandards/arrs/issues) with your Node/npm versions, operating system, command, expected result and a small reproduction. Remove credentials and private project data from examples and logs. Share where initialization or diagnostics made adoption unclear.

Use the [security reporting policy](SECURITY.md) for suspected vulnerabilities.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification requirements. ARRS is MIT-licensed; [NOTICE](NOTICE) and `upstream/` preserve third-party attribution.

More detail: [Feature Maps](docs/feature-maps.md), [task preparation](docs/task-preparation.md), [scoped readiness](docs/readiness.md), [agent operating model](docs/agents/operating-model.md), [skills](docs/skills.md), [work items](docs/work-items.md), [Gardener](docs/gardener.md), [metrics](docs/metrics.md) and the [glossary](GLOSSARY.md).

Read maintained capability relationships with `arrs impact <source-path> --json`, `arrs impact --base <local-commit> --json`, `arrs context feature <id>` and `arrs context drift --base <local-commit>`. The [local capability graph](docs/capability-graph.md) retains explicit provenance, scoped selected evidence and analysis gaps without project execution or writes.
