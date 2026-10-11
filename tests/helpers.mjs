import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectPolicyBaseline } from "../dist/core/policy-baseline.js";
import { initRepository } from "../dist/workflows/init.js";
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const cli = resolve(packageRoot, "dist/cli.js");
export const writeJson = (root, path, value) => {
  mkdirSync(resolve(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(value, null, 2) + "\n");
};
export const readJson = (root, path) =>
  JSON.parse(readFileSync(join(root, path), "utf8"));
export function invoke(root, args) {
  return spawnSync(process.execPath, [cli, ...args, "--root", root, "--json"], {
    encoding: "utf8",
    timeout: 120000,
  });
}
export function makeFixture(level = 3) {
  const root = mkdtempSync(join(tmpdir(), "arrs fixture "));
  initRepository(root);
  mkdirSync(join(root, "src/domain"), { recursive: true });
  mkdirSync(join(root, "src/application"), { recursive: true });
  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    "export const greeting = (name) => `Hello, ${name.trim()}!`;\n",
  );
  writeFileSync(
    join(root, "src/application/main.mjs"),
    "import {greeting} from '../domain/greeting.mjs';\nconsole.log(greeting(process.argv[2] ?? 'Ada'));\n",
  );
  writeFileSync(
    join(root, "test.mjs"),
    "import {strict as assert} from 'node:assert'; import {test} from 'node:test'; import {greeting} from './src/domain/greeting.mjs'; test('trims and greets a name',()=>assert.equal(greeting(' Ada '),'Hello, Ada!'));\n",
  );
  // A fresh native test invocation must not inherit the outer suite's recursive guard.
  // Keep this normalization in the fixture so direct API and CLI callers both run assertions.
  writeFileSync(
    join(root, "native-tests.mjs"),
    "import {spawnSync} from 'node:child_process'; import {constants} from 'node:os'; const result=spawnSync(process.execPath,['--test','test.mjs'],{stdio:'inherit',env:{...process.env,NODE_TEST_CONTEXT:undefined}}); if(result.error)throw result.error; process.exitCode=result.status??128+(constants.signals[result.signal]??1);\n",
  );
  writeFileSync(
    join(root, "verify.mjs"),
    "import {spawnSync} from 'node:child_process'; import {strict as assert} from 'node:assert'; const r=spawnSync(process.execPath,['src/application/main.mjs',' Ada '],{encoding:'utf8'}); assert.equal(r.status,0); assert.equal(r.stdout,'Hello, Ada!\\n'); console.log('CLI greeting acceptance passed');\n",
  );
  writeFileSync(
    join(root, "build.mjs"),
    "import {execFile} from 'node:child_process'; const files=['src/domain/greeting.mjs','src/application/main.mjs']; const results=await Promise.all(files.map(file=>new Promise(resolve=>{execFile(process.execPath,['--check',file],{encoding:'utf8',maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({status:error?(typeof error.code==='number'&&error.code>0?error.code:null):0,stderr}));}))); for(const result of results){if(result.status!==0){console.error(result.stderr);process.exit(result.status??1);}} console.log('JavaScript distribution syntax validated');\n",
  );
  const config = readJson(root, "arrs.json");
  config.commands = {
    setup: { argv: [process.execPath, "--version"] },
    dev: { argv: [process.execPath, "src/application/main.mjs"] },
    check: { argv: [process.execPath, cli, "gate"] },
    test: { argv: [process.execPath, "native-tests.mjs"] },
    build: { argv: [process.execPath, "build.mjs"] },
  };
  if (level >= 3) config.commands.verify = { argv: [process.execPath, "verify.mjs"] };
  config.verifyTargets = { greet: { argv: [process.execPath, "verify.mjs"] } };
  config.proof.requiredChecks = ["check", "test", "build"];
  writeJson(root, "arrs.json", config);
  writeJson(root, ".agent/policies/architecture.json", {
    schemaVersion: "0.1",
    modules: [
      {
        id: "domain",
        path: "src/domain",
        allows: [],
        public: ["src/domain/greeting.mjs"],
      },
      {
        id: "application",
        path: "src/application",
        allows: ["domain"],
        public: ["src/application/main.mjs"],
      },
    ],
  });
  writeJson(root, "docs/features/greeting.json", {
    schemaVersion: "0.1",
    id: "greeting",
    goal: "A local operator receives a greeting with surrounding whitespace removed.",
    owners: ["application"],
    entryPoints: ["src/application/main.mjs"],
    implementation: ["src/application", "src/domain"],
    boundaries: ["domain", "application"],
    dependencies: [],
    domainTerms: ["Recipient"],
    invariants: ["Names are trimmed before rendering."],
    sensitivity: "none",
    acceptance: ["Greets a trimmed name"],
    verification: { target: "greet" },
    risk: "R1",
    related: ["docs/product/README.md", "docs/architecture/README.md"],
  });
  writeFileSync(
    join(root, "docs/adr/0001-domain.md"),
    "# Separate normalization from delivery\n\nThe domain owns recipient normalization while the application owns delivery. This keeps the display policy testable without subprocess I/O and allows replacing delivery without changing the salutation rule.\n",
  );
  writeFileSync(
    join(root, "docs/product/README.md"),
    "# Greeting domain\n\nA recipient supplies a display name. The greeting removes surrounding whitespace and renders a stable salutation for the operator. The capability contains no persistent data or credentials.\n",
  );
  writeFileSync(
    join(root, "docs/architecture/README.md"),
    "# Greeting modules\n\nThe application prints a greeting using the domain public function. Domain owns string normalization and has no dependency on the application. The boundary gate rejects a reverse import.\n",
  );
  const proof = {
    schemaVersion: "0.1",
    task: "greeting-feature",
    category: "feature",
    risk: "R1",
    scope: ["src/domain", "src/application"],
    acceptance: ["Greets a trimmed name"],
    steps: [
      { phase: "check", command: "check", expectExitCode: 0 },
      { phase: "test", command: "test", expectExitCode: 0 },
      { phase: "mechanical", command: "build", expectExitCode: 0 },
      {
        phase: "behavior",
        command: "verify",
        target: "greet",
        expectExitCode: 0,
        criterion: "Greets a trimmed name",
      },
    ],
    residualRisks: [],
    deviations: [],
  };
  writeJson(root, "proof-plan.json", proof);
  if (level >= 4) {
    const risk = readJson(root, ".agent/policies/risk.json");
    risk.sensitivePaths = [
      {
        path: ".agent/policies/architecture.json",
        risk: "R3",
        reason: "Changes to enforced dependency controls require review.",
      },
    ];
    writeJson(root, ".agent/policies/risk.json", risk);
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const installed = invoke(root, ["skills", "install"]);
    if (installed.status !== 0) throw new Error(installed.stdout + installed.stderr);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      "name: fixture\non: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./repo check\n      - run: ./repo test\n      - run: ./repo verify\n      - run: arrs audit --execute --require-level 4\n",
    );
    writeJson(root, ".agent/work-items/greeting.json", {
      schemaVersion: "0.1",
      id: "greeting-followup",
      title: "Exercise independently executable greeting workflow",
      state: "ready-for-agent",
      risk: "R1",
      category: "feature",
      featureIds: ["greeting"],
      acceptance: ["Greets a trimmed name"],
      context: ["docs/features/greeting.json", "src/domain/greeting.mjs"],
      verificationTargets: ["greet"],
      dependencies: [],
      decisions: [],
    });
  }
  return root;
}

/** The trusted source and digest are established before the one-field candidate edit. */
export function makePolicyTransitionFixture({
  custom = false,
  prepare,
  prepareSource,
} = {}) {
  const root = makeFixture(3);
  const config = readJson(root, "arrs.json");
  const policy = readJson(root, config.riskPolicy);
  policy.sensitivePaths = [
    { path: "arrs.json", risk: "R3", reason: "Execution configuration requires review." },
  ];
  policy.classes.R3.autonomy = "human";
  policy.classes.R3.humanApproval = true;
  config.commands.check = { argv: [process.execPath, "marker-check.mjs"] };
  writeFileSync(
    join(root, "marker-check.mjs"),
    `import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; writeFileSync('EXECUTED','actual check executed'); const r=spawnSync(process.execPath, [${JSON.stringify(cli)}, 'gate'], {stdio:'inherit'}); process.exit(r.status??1);\n`,
  );
  if (custom) {
    config.riskPolicy = "controls/governing.json";
    config.knowledge.features = "maps/custom";
    writeJson(
      root,
      "maps/custom/greeting.json",
      readJson(root, "docs/features/greeting.json"),
    );
  }
  if (prepare) prepare(config, policy, root);
  writeJson(root, config.riskPolicy, policy);
  const weak = structuredClone(policy);
  weak.sensitivePaths = [];
  weak.classes.R3.autonomy = "review";
  weak.classes.R3.humanApproval = false;
  writeJson(root, "controls/weak.json", weak);
  writeJson(root, "arrs.json", config);
  const source = mkdtempSync(join(tmpdir(), "arrs pre-change "));
  cpSync(root, source, { recursive: true });
  if (prepareSource) prepareSource(source);
  const baseline = inspectPolicyBaseline(root, source);
  const flags = ["--baseline", baseline.root, "--baseline-sha256", baseline.sha256];
  config.riskPolicy = "controls/weak.json";
  writeJson(root, "arrs.json", config);
  const plan = readJson(root, "proof-plan.json");
  plan.task = "policy-pointer-transition";
  plan.risk = "R0";
  plan.scope = ["arrs.json"];
  writeJson(root, "proof-plan.json", plan);
  return { root, source, baseline, flags, plan };
}
