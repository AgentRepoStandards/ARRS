# Repository operating contract

Make the smallest correct change that satisfies the goal. Inspect the existing implementation and paved road before adding an abstraction. Fix root causes and keep feature invariants and module boundaries intact.

Use `./repo` and `arrs.json` for commands. Complete the applicable Proof Contract. Keep required tests, compiler/static checks and verification active; never weaken a control solely to make an implementation pass. Explain dependency additions. Keep secrets out of source and evidence. Classify risk before execution using [.agent/policies/risk.json](.agent/policies/risk.json), and record required independent review and human approval.

- **Locate a feature:** read the relevant map under [docs/features](docs/features), then its code and linked decisions. Product terms live in [GLOSSARY.md](GLOSSARY.md) and [product context](docs/product/README.md).
- **Change a boundary or public interface:** read [architecture](docs/architecture/README.md) and the policy configured by `arrs.json`.
- **Implement or debug behaviour:** read [risk](docs/risk.md) and the applicable [Proof Contract](docs/proof-contract.md); run the map's verification target.
- **Continue substantial work or hand off:** maintain a self-contained [execution plan](docs/agents/operating-model.md) under `.agent/plans/`.
- **Change ARRS controls or schemas:** read the [v0.1 specification](docs/spec/0.1.md), preserve failure detection, and exercise affected fixtures.
- **Change a reusable workflow:** read [skills](docs/skills.md). **Investigate recurring mistakes:** read [Gardener](docs/gardener.md) and prefer mechanical prevention.

Load only the context needed for the task. Evidence belongs in ignored `.arrs/`; durable decisions, maps and plans belong in source control.
