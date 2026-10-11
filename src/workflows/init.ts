import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative, parse, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCIWorkflow } from "../core/ci.js";
import { evidenceIgnoreProtection } from "../core/evidence-ignore.js";
import { readConfig } from "../core/config.js";
import type { ArrsConfig, Command, CommandName } from "../core/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export interface InitReport {
  root: string;
  dryRun: boolean;
  detected: string[];
  created: string[];
  preserved: string[];
  requirements: string[];
  changes: { path: string; content: string }[];
}
const defaultRisk = {
  schemaVersion: "0.1",
  classes: {
    R0: {
      autonomy: "unattended",
      requiredChecks: ["check"],
      independentReview: false,
      humanApproval: false,
    },
    R1: {
      autonomy: "unattended",
      requiredChecks: ["check", "test"],
      independentReview: false,
      humanApproval: false,
    },
    R2: {
      autonomy: "review",
      requiredChecks: ["check", "test", "verify", "build"],
      independentReview: true,
      humanApproval: false,
    },
    R3: {
      autonomy: "human",
      requiredChecks: ["check", "test", "verify", "build"],
      independentReview: true,
      humanApproval: true,
    },
    R4: {
      autonomy: "human",
      requiredChecks: ["check", "test", "verify", "build"],
      independentReview: true,
      humanApproval: true,
    },
  },
  sensitivePaths: [],
};
function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
function inferCommands(
  root: string,
  detected: string[],
): Partial<Record<CommandName, Command>> {
  const commands: Partial<Record<CommandName, Command>> = {};
  if (existsSync(join(root, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const manager = existsSync(join(root, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(root, "yarn.lock"))
        ? "yarn"
        : "npm";
    detected.push(`${manager} package.json`);
    commands.setup = {
      argv:
        manager === "npm"
          ? ["npm", existsSync(join(root, "package-lock.json")) ? "ci" : "install"]
          : [manager, "install"],
    };
    for (const name of ["dev", "check", "test", "verify", "build"] as const) {
      if (typeof pkg.scripts?.[name] === "string")
        commands[name] = { argv: [manager, "run", name] };
    }
  } else if (existsSync(join(root, "Cargo.toml"))) {
    detected.push("Rust Cargo");
    commands.setup = { argv: ["cargo", "fetch"] };
    commands.check = { argv: ["cargo", "check"] };
    commands.test = { argv: ["cargo", "test"] };
    commands.build = { argv: ["cargo", "build"] };
  } else if (existsSync(join(root, "go.mod"))) {
    detected.push("Go modules");
    commands.setup = { argv: ["go", "mod", "download"] };
    commands.check = { argv: ["go", "vet", "./..."] };
    commands.test = { argv: ["go", "test", "./..."] };
    commands.build = { argv: ["go", "build", "./..."] };
  } else if (existsSync(join(root, "pyproject.toml"))) {
    detected.push("Python pyproject.toml (commands require explicit configuration)");
  }
  return commands;
}
function ensureSafe(root: string, relative: string): void {
  let cursor = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error(`Refusing initialization through symlink: ${relative}`);
    if (
      existsSync(cursor) &&
      index < parts.length - 1 &&
      !lstatSync(cursor).isDirectory()
    )
      throw new Error(`Initialization parent is not a directory: ${relative}`);
  }
}
export function initRepository(directory: string, dryRun = false): InitReport {
  const requestedRoot = resolve(directory);
  if (requestedRoot === parse(requestedRoot).root)
    throw new Error(
      "Refusing to initialize the filesystem root; choose a repository directory.",
    );
  // Validate all planned paths before making any writes, including existing parent symlinks.
  let ancestor = requestedRoot;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const root = existsSync(requestedRoot)
    ? realpathSync(requestedRoot)
    : resolve(realpathSync(ancestor), relative(ancestor, requestedRoot));
  if (root === parse(root).root)
    throw new Error(
      "Refusing to initialize the canonical filesystem root; choose a repository directory.",
    );
  if (existsSync(root) && !lstatSync(root).isDirectory())
    throw new Error("Initialization target must be a directory.");
  const report: InitReport = {
    root,
    dryRun,
    detected: [],
    created: [],
    preserved: [],
    requirements: [],
    changes: [],
  };
  const commands = inferCommands(root, report.detected);
  const existingConfig = existsSync(join(root, "arrs.json"));
  const ci = existingConfig
    ? { workflow: ".github/workflows/ci.yml", warnings: [] }
    : discoverCIWorkflow(root);
  if (!existingConfig) ensureSafe(root, ci.workflow);
  report.requirements.push(...ci.warnings);
  if (!existingConfig && existsSync(join(root, ci.workflow)))
    report.detected.push(`GitHub Actions workflow: ${ci.workflow}`);
  for (const name of [
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
  ])
    if (existsSync(join(root, name)))
      report.detected.push(`Existing instructions: ${name}`);
  for (const name of ["src", "app", "lib", "packages", "tests", "docs"])
    if (existsSync(join(root, name))) report.detected.push(`Existing area: ${name}/`);
  const config: ArrsConfig = {
    schemaVersion: "0.1",
    project: { name: basename(root), runtimes: { node: ">=22" } },
    commands,
    verifyTargets: {},
    knowledge: {
      architecture: "docs/architecture",
      product: "docs/product",
      features: "docs/features",
      decisions: "docs/adr",
    },
    architecture: { policy: ".agent/policies/architecture.json" },
    riskPolicy: ".agent/policies/risk.json",
    proof: {
      requiredChecks: ["check", "test", "build"],
      behavioralRequiredFrom: "R1",
      evidenceDir: ".arrs/evidence",
    },
    skills: { path: ".agent/skills" },
    ci: { workflow: ci.workflow },
    security: { exceptions: ".agent/policies/exceptions.json" },
  };
  const map =
    "# ARRS repository map\n\nUse the smallest correct change. Inspect the existing paved road before adding abstractions. Respect boundaries and fix root causes. Keep tests, compiler, static analysis and CI controls effective; preserve failures until corrected. Protect secrets; justify dependencies.\n\n- Commands: `./repo --help` and `./repo check`; configure missing commands in `arrs.json`.\n- Locate a feature: `docs/features/`; follow its paths, invariants and verification target.\n- Architecture changes: `docs/architecture/` and `.agent/policies/architecture.json`; decisions in `docs/adr/`.\n- Domain questions: `docs/product/`.\n- Establish risk using `.agent/policies/risk.json`. Complete the Proof Contract through ARRS proof commands; record necessary independent review/human approval.\n- Substantial work: `.agent/plans/`; handoff with current state and evidence.\n- Workflows: `.agent/skills/` (install with `arrs skills install`).\n\nRead deeper context only for the task at hand. Do not weaken controls to pass a failing implementation or bypass verification.\n";
  const files: Record<string, string> = {
    "arrs.json": json(config),
    repo: readFileSync(join(packageRoot, "assets/repo.template"), "utf8"),
    ".agent/repo.cjs": readFileSync(join(packageRoot, "assets/repo.cjs"), "utf8"),
    "AGENTS.md": map,
    "docs/agents/README.md":
      "# Agent workflow\n\nFind the relevant Feature Map, establish risk, inspect implementation and gates, change the smallest scope, then execute the configured checks and real acceptance scenario. ARRS CLI `proof --help` describes evidence capture. Require approval according to the risk policy.\n",
    "docs/architecture/README.md":
      "# Architecture\n\nDescribe existing modules, public interfaces and dependency directions here. Declare JavaScript/TypeScript boundaries in `.agent/policies/architecture.json`. For another stack, map its established gate to `commands.check` and record that the bundled architecture adapter does not cover it. The generated empty modules collection is valid unconfigured setup; it cannot satisfy the architecture scan or mutation guard. Configure real boundaries before claiming mechanical enforcement.\n",
    "docs/product/README.md":
      "# Product and domain\n\nConfiguration requirement: document the product goal, user journeys and domain terms that an agent needs for your repository. Infer these from the implementation and domain owner; initialization does not invent them.\n",
    "docs/features/README.md":
      "# Feature Maps\n\nCreate one `.json` Feature Map per meaningful user/system capability. Follow ARRS schema `feature.schema.json` v0.1. Include real implementation paths, ownership, invariants, acceptance criteria, sensitivity, risk and a configured verification target. `arrs doctor` reports missing/invalid maps.\n",
    "docs/adr/README.md":
      "# Decisions\n\nRecord consequential architecture decisions with their context, chosen tradeoff and consequences. Use sequential `0001-slug.md` names.\n",
    ".agent/plans/README.md":
      "# Execution plans\n\nUse a persistent plan for substantial work spanning milestones or handoffs. Record objective, context pointers, constraints, decisions, milestones, verification, current state, discoveries and completion evidence. Trivial R0/R1 edits need no plan.\n",
    ".agent/playbooks/README.md":
      "# Playbooks\n\nUse ARRS skills for repeatable bootstrap, implementation, debugging, proof, risk, review, Gardener and handoff workflows. Local playbooks should cover repository-specific operations with preconditions, commands, expected outcomes and recovery.\n",
    ".agent/policies/architecture.json": json({ schemaVersion: "0.1", modules: [] }),
    ".agent/policies/risk.json": json(defaultRisk),
    ".agent/policies/exceptions.json": json({
      schemaVersion: "0.1",
      exceptions: [],
      dependencies: [],
    }),
  };
  const ignore = ".arrs/\n";
  // Existing ignore conventions remain untouched; always establish a missing scoped ignored-output marker.
  if (!existsSync(join(root, ".gitignore"))) files[".gitignore"] = ignore;
  files[".arrs/.gitignore"] = "*\n!.gitignore\n";
  for (const [relative, content] of Object.entries(files)) {
    ensureSafe(root, relative);
    if (existsSync(join(root, relative))) report.preserved.push(relative);
    else {
      report.created.push(relative);
      report.changes.push({ path: relative, content });
    }
  }
  if (!existingConfig) {
    for (const name of ["check", "test", "verify", "build"] as const)
      if (!commands[name])
        report.requirements.push(
          `Set commands.${name}.argv in arrs.json to your actual ${name} command.`,
        );
  } else
    report.requirements.push(
      "Existing arrs.json preserved; run arrs doctor to validate it.",
    );
  if (report.created.includes(".agent/policies/architecture.json"))
    report.requirements.push(
      "Configure .agent/policies/architecture.json with real modules, public interfaces and dependency directions; its empty modules collection is valid unconfigured setup and provides no mechanical constraint.",
    );
  report.requirements.push(
    "Map actual features and verification targets; complete domain knowledge and architecture boundaries; install skills with arrs skills install.",
  );
  if (!dryRun)
    for (const change of report.changes) {
      mkdirSync(dirname(join(root, change.path)), { recursive: true });
      writeFileSync(join(root, change.path), change.content, {
        flag: "wx",
        mode: change.path === "repo" ? 0o755 : 0o644,
      });
    }
  // Don't silently reconfigure existing conventions even if safe detection found alternatives.
  if (existsSync(join(root, "repo")) && !report.created.includes("repo"))
    report.requirements.push(
      "Existing repo runner preserved; confirm it supports the configured ARRS command interface.",
    );
  if (
    report.detected.length === 0 &&
    (!existsSync(root) || readdirSync(root).length === 0)
  )
    report.detected.push("Empty repository");
  if (!dryRun) {
    try {
      const protection = evidenceIgnoreProtection(
        root,
        readConfig(root).proof.evidenceDir,
      );
      report.detected.push(
        `Evidence ignore protection (${protection.method}): ${protection.detail}`,
      );
    } catch (error) {
      report.requirements.push(
        `Establish ignored evidence before proof: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}
