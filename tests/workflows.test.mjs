import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import fs, {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../dist/core/audit.js";
import { doctor } from "../dist/core/doctor.js";
import {
  makeFixture,
  invoke,
  readJson,
  writeJson,
  packageRoot,
  makePolicyTransitionFixture,
} from "./helpers.mjs";
import { effectiveRisk, readRiskPolicy } from "../dist/core/config.js";
import { validatePlan } from "../dist/core/evidence.js";
import { validateWorkItem } from "../dist/core/work.js";
import { hashScope } from "../dist/core/files.js";
import "./prepare.mjs";
import "./readiness.mjs";
import "./mcp.mjs";

test("Gardener parses maintenance comments without mistaking detector literals for work", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const tsIgnore = "@ts-" + "ignore";
  const noCheck = "@ts-" + "nocheck";
  const eslintDisable = "eslint-" + "disable";
  const root = makeFixture();
  try {
    writeFileSync(
      join(root, "src/domain/detectors.mjs"),
      [
        "export const deferred = /\\b(?:TODO|FIXME)\\b/;",
        `export const suppression = /@ts-(?:ignore|nocheck)|${eslintDisable}/;`,
        `export const words = 'TODO FIXME ${tsIgnore} ${eslintDisable}';`,
        `export const template = \`TODO FIXME ${noCheck}\`;`,
        "",
      ].join("\n"),
    );
    let report = await garden(root);
    assert.equal(
      report.candidates.some((candidate) =>
        /Deferred work|Suppression growth/.test(candidate.observation),
      ),
      false,
    );
    writeFileSync(
      join(root, "src/domain/comments.tsx"),
      [
        "// TODO handle empty exports",
        "/* FIXME preserve row order */",
        `// ${tsIgnore} fixture actual directive`,
        "export const element = <div>{/* TODO accessible label */}</div>;",
        "",
      ].join("\n"),
    );
    report = await garden(root);
    const deferred = report.candidates.filter((candidate) =>
      candidate.observation.includes("Deferred work"),
    );
    assert.ok(deferred.length);
    for (const line of [1, 2, 4])
      assert.ok(
        deferred.some((candidate) =>
          candidate.evidence.some((evidence) =>
            evidence.includes(`src/domain/comments.tsx:${line}:`),
          ),
        ),
        `missing comment line ${line}`,
      );
    assert.ok(
      report.candidates.some(
        (candidate) =>
          candidate.observation.includes("Suppression growth") &&
          candidate.evidence.some((evidence) => evidence.includes("comments.tsx:3:")),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener drafts retain evidence and require current candidates without permission or overwrites", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const root = makeFixture(4);
  try {
    const source = join(root, "src/domain/greeting.mjs");
    const original = readFileSync(source, "utf8");
    writeFileSync(source, original + "// TODO handle empty names\n");
    const first = await garden(root);
    const candidate = first.candidates.find((item) => item.ruleId === "deferred-work");
    assert.ok(candidate);
    assert.deepEqual(
      (await garden(root)).candidates.find((item) => item.id === candidate.id),
      candidate,
    );
    const out = ".agent/work-items/garden-greeting.json";
    const args = ["gardener", "propose", candidate.id, "--out", out];
    let result = invoke(root, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const created = JSON.parse(result.stdout);
    assert.equal(created.created, true);
    const draft = readJson(root, out);
    assert.equal(draft.state, "needs-triage");
    assert.equal(draft.proof, undefined);
    assert.equal(draft.authorization, undefined);
    assert.equal(draft.review, undefined);
    assert.ok(draft.decisions.length);
    assert.ok(readJson(root, created.proposal).candidate.provenance.length);
    assert.equal(readJson(root, created.proofPlan).authorization, undefined);
    assert.equal(invoke(root, ["work", "validate", out]).status, 0);
    const bytes = readFileSync(join(root, out));
    result = invoke(root, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).created, false);
    assert.deepEqual(readFileSync(join(root, out)), bytes);
    const collision = ".agent/work-items/collision.json";
    writeFileSync(join(root, collision), "preserve unrelated bytes\n");
    assert.equal(invoke(root, [...args.slice(0, 3), "--out", collision]).status, 1);
    assert.equal(
      readFileSync(join(root, collision), "utf8"),
      "preserve unrelated bytes\n",
    );
    assert.equal(
      invoke(root, [...args.slice(0, 3), "--out", "../escape.json"]).status,
      1,
    );
    assert.equal(
      invoke(root, [...args.slice(0, 3), "--out", ".arrs/work.json"]).status,
      1,
    );
    assert.equal(
      invoke(root, ["work", "transition", out, "--to", "ready-for-agent"]).status,
      1,
    );
    writeFileSync(source, original);
    assert.equal(invoke(root, args).status, 1, "resolved candidate must be stale");
    assert.deepEqual(readFileSync(join(root, out)), bytes);
    const config = readJson(root, "arrs.json");
    config.work = { provider: "unsupported", path: ".agent/work-items" };
    writeJson(root, "arrs.json", config);
    assert.equal(invoke(root, args).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener reports malformed coverage and redacts excerpts while security positives remain", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const { checkSecurity } = await import("../dist/core/security.js");
  const root = makeFixture();
  try {
    writeFileSync(
      join(root, "src/domain/incomplete.ts"),
      "// TODO token = confidential-value\nexport const broken = ;\n",
    );
    writeFileSync(join(root, "src/domain/other.py"), "# TODO unsupported syntax\n");
    const report = await garden(root);
    assert.ok(report.warnings.some((warning) => warning.includes("malformed")));
    assert.ok(report.warnings.some((warning) => warning.includes("other.py")));
    assert.equal(JSON.stringify(report).includes("confidential-value"), false);
    assert.ok(
      report.candidates.some((candidate) => candidate.ruleId === "deferred-work"),
    );
    writeFileSync(
      join(root, "src/domain/suppressed.ts"),
      "// @ts-" + "ignore actual directive\nexport const value=3;\n",
    );
    assert.ok(checkSecurity(root).some((error) => /suppression/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy output-only proof cannot admit work review/completion or audit evidence", async () => {
  const root = makeFixture(4);
  try {
    const initialized = spawnSync("git", ["init", "--quiet", root], {
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    for (const directory of [".arrs", ".git", "node_modules"]) {
      mkdirSync(join(root, directory, "cache"), { recursive: true });
      writeFileSync(join(root, directory, "cache/state.json"), "{}\n");
    }
    const file = ".agent/work-items/greeting.json";
    const item = readJson(root, file);
    item.state = "in-progress";
    const plan = readJson(root, "proof-plan.json");
    plan.task = item.id;
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const { path, manifest } = JSON.parse(run.stdout);
    const original = readFileSync(join(root, path));
    item.proof = path;
    writeJson(root, file, item);
    // R1 has no review requirement: every other proof/work gate passes initially.
    for (const state of ["ready-for-review", "completed"])
      assert.deepEqual(validateWorkItem(root, { ...item, state }), []);
    const initialAudit = await audit(root);
    assert.equal(
      initialAudit.controls.find((control) => control.id === "proof-evidence").passed,
      true,
    );
    const caseAliases = [
      [".git", ".GIT"],
      [".git", ".GiT"],
      ["node_modules", "NODE_MODULES"],
      ["node_modules", "Node_Modules"],
      ["node_modules", "node_moduleſ"],
      ["node_modules", "NODE_MODULEſ"],
    ]
      .filter(([canonical, scope]) => {
        const candidate = lstatSync(join(root, scope), {
          bigint: true,
          throwIfNoEntry: false,
        });
        const reserved = lstatSync(join(root, canonical), { bigint: true });
        return candidate?.dev === reserved.dev && candidate?.ino === reserved.ino;
      })
      .map(([, scope]) => scope);
    for (const scope of ["./.arrs/", ".git/./", "node_modules//", ...caseAliases]) {
      // Reproduce legacy capture admission with only a truthful scope/hash change;
      // all passing command results and logs still come from the real capture.
      writeJson(root, path, {
        ...manifest,
        scope: [scope],
        scopeHashes: { [scope]: hashScope(root, scope) },
      });
      const legacyBytes = readFileSync(join(root, path));
      for (const [from, to] of [
        ["in-progress", "ready-for-review"],
        ["ready-for-review", "completed"],
      ]) {
        item.state = from;
        writeJson(root, file, item);
        assert.match(
          validateWorkItem(root, { ...item, state: to }).join("; "),
          /Proof scope must refer to source paths/,
          `${scope}: ${to}`,
        );
        const saved = readFileSync(join(root, file));
        const result = invoke(root, ["work", "transition", file, "--to", to]);
        assert.equal(result.status, 1, `${scope}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /Proof scope must refer to source paths/, scope);
        assert.deepEqual(readFileSync(join(root, file)), saved, scope);
        assert.deepEqual(readFileSync(join(root, path)), legacyBytes, scope);
      }
      const report = await audit(root);
      const control = report.controls.find((control) => control.id === "proof-evidence");
      assert.equal(control.passed, false, control.detail);
      assert.match(control.detail, /No current accepted proof manifest/);
      assert.ok(
        report.warnings.some((warning) =>
          warning.includes("Proof scope must refer to source paths"),
        ),
        `${scope}: ${JSON.stringify(report)}`,
      );
      assert.deepEqual(readFileSync(join(root, path)), legacyBytes, scope);
    }
    writeFileSync(join(root, path), original);
    assert.deepEqual(validateWorkItem(root, { ...item, state: "completed" }), []);
    const retainedAudit = await audit(root);
    assert.equal(
      retainedAudit.controls.find((control) => control.id === "proof-evidence").passed,
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work readiness rejects inherited missing targets and accepts explicitly owned built-in names", () => {
  for (const target of [
    "toString",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
    "not-configured",
  ]) {
    const root = makeFixture(4);
    try {
      const file = ".agent/work-items/greeting.json";
      const item = readJson(root, file);
      item.state = "needs-triage";
      item.verificationTargets = ["greet", target];
      writeJson(root, file, item);
      assert.match(
        validateWorkItem(root, item).join("; "),
        new RegExp(`Unknown verification target ${target}`),
      );
      const original = readFileSync(join(root, file));
      const rejected = invoke(root, [
        "work",
        "transition",
        file,
        "--to",
        "ready-for-agent",
      ]);
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(rejected.stdout, new RegExp(`Unknown verification target ${target}`));
      assert.deepEqual(readFileSync(join(root, file)), original);
      // Preserve the existing configured-name grammar while rejecting absent lookups.
      if (target === "__proto__") continue;
      const config = readJson(root, "arrs.json");
      Object.defineProperty(config.verifyTargets, target, {
        value: { argv: [process.execPath, "verify.mjs"] },
        enumerable: true,
      });
      writeJson(root, "arrs.json", config);
      assert.deepEqual(validateWorkItem(root, item), []);
      const accepted = invoke(root, [
        "work",
        "transition",
        file,
        "--to",
        "ready-for-agent",
      ]);
      assert.equal(accepted.status, 0, accepted.stdout);
      assert.equal(readJson(root, file).state, "ready-for-agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("ARRS policy individually covers configuration schemas and execution admission controls", () => {
  readRiskPolicy(packageRoot);
  const controls = [
    "arrs.json",
    ".agent/policies/risk.json",
    "src/cli.ts",
    ...readdirSync(join(packageRoot, "schemas"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => `schemas/${file}`),
    ...readdirSync(join(packageRoot, "src/core"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `src/core/${file}`),
    "src/workflows/proof.ts",
    "src/workflows/work.ts",
    "src/workflows/init.ts",
    "src/workflows/skills.ts",
    "assets/repo.cjs",
    ".agent/repo.cjs",
    "repo",
    "assets/repo.template",
    "scripts/controls.mjs",
    "scripts/test.mjs",
    "scripts/verify.mjs",
  ];
  assert.deepEqual(
    controls.map((path) => [path, effectiveRisk(packageRoot, [path], "R0")]),
    controls.map((path) => [path, "R3"]),
  );
  for (const path of [
    "./arrs.json",
    "schemas/./proof.schema.json",
    "src/core/./ci.ts",
    "schemas/",
    "src/core",
    "src",
    "assets",
    ".",
  ])
    assert.equal(effectiveRisk(packageRoot, [path], "R0"), "R3", path);
  for (const path of [
    "arrs.json.backup",
    "schemas-old/example.json",
    "src/core-old/ci.ts",
    "assets/repo.cjs.backup",
    ".agent/repo.cjsx",
  ])
    assert.ok(effectiveRisk(packageRoot, [path], "R0") < "R3", path);
  assert.equal(effectiveRisk(packageRoot, ["README.md", "docs/risk.md"], "R0"), "R0");
  assert.equal(effectiveRisk(packageRoot, ["README.md"], "R4"), "R4");
  assert.equal(effectiveRisk(packageRoot, ["arrs.json"], "R4"), "R4");
  for (const [path, requested, expected] of [
    ["arrs.json", "R0", "R3"],
    ["schemas/proof.schema.json", "R0", "R3"],
    ["README.md", "R4", "R4"],
  ]) {
    const result = invoke(packageRoot, ["risk", path, "--risk", requested]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).effective, expected);
  }
});

test("configured policy floors prevent understated proof and work risk without imposing consumer filenames", () => {
  const root = makeFixture(4);
  try {
    assert.equal(effectiveRisk(root, ["arrs.json"], "R0"), "R0");
    const config = readJson(root, "arrs.json");
    config.riskPolicy = "controls/custom-risk.json";
    writeJson(
      root,
      config.riskPolicy,
      readJson(packageRoot, ".agent/policies/risk.json"),
    );
    writeJson(root, "arrs.json", config);
    assert.equal(effectiveRisk(root, ["./arrs.json"], "R0"), "R3");
    const plan = readJson(root, "proof-plan.json");
    plan.scope = ["arrs.json"];
    plan.risk = "R0";
    assert.match(validatePlan(root, plan).join("; "), /risk is below/);
    writeJson(root, "understated-proof.json", plan);
    const capture = invoke(root, ["proof", "run", "understated-proof.json", "--execute"]);
    assert.equal(capture.status, 1, capture.stdout);
    assert.match(capture.stdout, /risk is below/);
    const item = readJson(root, ".agent/work-items/greeting.json");
    item.context = ["arrs.json"];
    item.risk = "R1";
    assert.match(validateWorkItem(root, item).join("; "), /risk is lower/);
    writeJson(root, ".agent/work-items/greeting.json", item);
    const work = invoke(root, ["work", "validate", ".agent/work-items/greeting.json"]);
    assert.equal(work.status, 1, work.stdout);
    assert.match(work.stdout, /risk is lower/);
    assert.equal(
      readJson(root, ".agent/work-items/greeting.json").state,
      "ready-for-agent",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareRiskAliasConsumer(floor) {
  const root = makeFixture(4);
  const canonical = "src/sensitive/value.mjs";
  mkdirSync(join(root, "src/sensitive"), { recursive: true });
  const source = "export const sensitive = true;\n";
  writeFileSync(join(root, canonical), source);
  const architecture = readJson(root, ".agent/policies/architecture.json");
  architecture.modules.push({
    id: "sensitive",
    path: "src/sensitive",
    allows: [],
    public: [canonical],
  });
  writeJson(root, ".agent/policies/architecture.json", architecture);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths =
    floor === "policy"
      ? [{ path: canonical, risk: "R3", reason: "Sensitive fixture source" }]
      : [];
  writeJson(root, ".agent/policies/risk.json", policy);
  if (floor !== "policy") {
    const map = readJson(root, "docs/features/greeting.json");
    map.id = "sensitive-source";
    map.risk = "R3";
    map.sensitivity = "sensitive";
    map.owners = ["sensitive"];
    map.boundaries = ["sensitive", "domain", "application"];
    map.implementation = floor === "implementation" ? ["src/sensitive"] : ["src/domain"];
    map.entryPoints = floor === "entryPoint" ? [canonical] : ["src/application/main.mjs"];
    writeJson(root, "docs/features/sensitive-source.json", map);
  }
  const stat = lstatSync(join(root, canonical), { bigint: true });
  const scopes = [{ scope: canonical, aliasesSource: true }];
  for (const scope of [
    "SRC/SENSITIVE/VALUE.MJS",
    "src/ſenſitive/value.mjs",
    "src/sensıtive/value.mjs",
  ]) {
    const candidate = lstatSync(join(root, scope), {
      bigint: true,
      throwIfNoEntry: false,
    });
    const aliasesSource = candidate?.dev === stat.dev && candidate?.ino === stat.ino;
    if (!aliasesSource) {
      mkdirSync(join(root, scope, ".."), { recursive: true });
      writeFileSync(join(root, scope), source);
    }
    scopes.push({ scope, aliasesSource });
  }
  // Check refusals before positive capture creates its expected evidence output.
  scopes.sort((left, right) => Number(right.aliasesSource) - Number(left.aliasesSource));
  const config = readJson(root, "arrs.json");
  const wrapper =
    "require('node:fs').writeFileSync('.arrs/RISK-COMMAND-EXECUTED','yes');" +
    "const argv=JSON.parse(process.argv[1]);" +
    "const result=require('node:child_process').spawnSync(argv[0],argv.slice(1),{stdio:'inherit'});" +
    "if(result.error)throw result.error;process.exit(result.status??1)";
  // Retain the configured gates and mark any unauthorized execution of them.
  for (const command of [config.commands.check, config.verifyTargets.greet])
    command.argv = [process.execPath, "-e", wrapper, JSON.stringify(command.argv)];
  writeJson(root, "arrs.json", config);
  return { root, scopes };
}

for (const action of ["run", "start"]) {
  test(`proof ${action} retains policy and both Feature Map floors for filesystem aliases before effects`, () => {
    for (const floor of ["policy", "implementation", "entryPoint"]) {
      const { root, scopes } = prepareRiskAliasConsumer(floor);
      try {
        const originalPlan = readJson(root, "proof-plan.json");
        for (const { scope, aliasesSource } of scopes) {
          const plan = structuredClone(originalPlan);
          plan.scope = [scope];
          if (action === "start") {
            plan.category = "refactor";
            plan.steps.unshift({
              phase: "before",
              command: "verify",
              target: "greet",
              expectExitCode: 0,
            });
            plan.steps.at(-1).phase = "after";
          }
          writeJson(root, "proof-plan.json", plan);
          const before = readdirSync(join(root, ".arrs")).sort();
          const result = invoke(root, ["proof", action, "proof-plan.json", "--execute"]);
          if (aliasesSource) {
            assert.equal(
              result.status,
              1,
              `${floor}: ${scope}: ${result.stdout}${result.stderr}`,
            );
            assert.match(result.stdout, /risk is below/, `${floor}: ${scope}`);
            assert.match(
              validatePlan(root, plan).join("; "),
              /risk is below/,
              `${floor}: ${scope}`,
            );
            assert.deepEqual(
              readdirSync(join(root, ".arrs")).sort(),
              before,
              `${floor}: ${scope}`,
            );
            assert.equal(
              existsSync(join(root, ".arrs/RISK-COMMAND-EXECUTED")),
              false,
              `${floor}: ${scope}`,
            );
            assert.equal(
              existsSync(join(root, ".arrs/evidence")),
              false,
              `${floor}: ${scope}`,
            );
          } else {
            assert.equal(
              result.status,
              0,
              `${floor}: ${scope}: ${result.stdout}${result.stderr}`,
            );
            assert.deepEqual(validatePlan(root, plan), [], `${floor}: ${scope}`);
            assert.equal(
              existsSync(join(root, ".arrs/RISK-COMMAND-EXECUTED")),
              true,
              `${floor}: ${scope}`,
            );
            assert.equal(
              existsSync(join(root, ".arrs/evidence")),
              true,
              `${floor}: ${scope}`,
            );
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test("work retains policy and both Feature Map floors for filesystem aliases without mutating understated items", () => {
  for (const floor of ["policy", "implementation", "entryPoint"]) {
    const { root, scopes } = prepareRiskAliasConsumer(floor);
    try {
      const file = ".agent/work-items/greeting.json";
      const original = readJson(root, file);
      // The selected R1 feature cannot mask the separate sensitive map's scope floor.
      assert.deepEqual(original.featureIds, ["greeting"]);
      for (const { scope, aliasesSource } of scopes) {
        const item = { ...original, context: [scope] };
        writeJson(root, file, item);
        const bytes = readFileSync(join(root, file));
        const work = invoke(root, ["work", "validate", file]);
        const transition = invoke(root, [
          "work",
          "transition",
          file,
          "--to",
          "in-progress",
        ]);
        if (aliasesSource) {
          for (const result of [work, transition]) {
            assert.equal(
              result.status,
              1,
              `${floor}: ${scope}: ${result.stdout}${result.stderr}`,
            );
            assert.match(result.stdout, /risk is lower/, `${floor}: ${scope}`);
          }
          assert.match(
            validateWorkItem(root, item).join("; "),
            /risk is lower/,
            `${floor}: ${scope}`,
          );
          assert.deepEqual(readFileSync(join(root, file)), bytes, `${floor}: ${scope}`);
        } else {
          assert.equal(
            work.status,
            0,
            `${floor}: ${scope}: ${work.stdout}${work.stderr}`,
          );
          assert.equal(
            transition.status,
            0,
            `${floor}: ${scope}: ${transition.stdout}${transition.stderr}`,
          );
          assert.deepEqual(validateWorkItem(root, item), [], `${floor}: ${scope}`);
          assert.equal(readJson(root, file).state, "in-progress");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("work selects the successful retry manifest while failed attempts remain unreviewable", () => {
  const root = makeFixture(4);
  try {
    const file = ".agent/work-items/greeting.json";
    const item = readJson(root, file);
    item.category = "bug";
    item.state = "in-progress";
    writeJson(root, file, item);
    const plan = readJson(root, "proof-plan.json");
    plan.task = item.id;
    plan.category = "bug";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 1,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    const source = join(root, "src/domain/greeting.mjs");
    writeFileSync(source, "export const greeting = (name) => `Hello, ${name}!`;\n");
    const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
    assert.equal(start.status, 0, start.stdout);
    const session = JSON.parse(start.stdout).session;
    const failed = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(failed.status, 1);
    item.proof = JSON.parse(failed.stdout).path;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      1,
    );
    assert.equal(readJson(root, file).state, "in-progress");
    writeFileSync(
      source,
      "export const greeting = (name) => `Hello, ${name.trim()}!`;\n",
    );
    const retry = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(retry.status, 0, retry.stdout);
    item.proof = JSON.parse(retry.stdout).path;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      0,
    );
    assert.equal(readJson(root, file).proof, item.proof);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured local work locations preserve structured readiness and transition gates", async () => {
  const root = makeFixture(4);
  try {
    const config = readJson(root, "arrs.json");
    config.work = { provider: "local", path: "tasks" };
    writeJson(root, "arrs.json", config);
    renameSync(join(root, ".agent/work-items"), join(root, "tasks"));
    const file = "tasks/greeting.json";
    let work = (await audit(root)).controls.find(
      (control) => control.id === "work-state",
    );
    assert.equal(work.passed, true, work.detail);
    assert.equal(invoke(root, ["work", "validate", file]).status, 0);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      1,
    );
    const item = readJson(root, file);
    item.context = ["missing-context.md"];
    writeJson(root, file, item);
    work = (await audit(root)).controls.find((control) => control.id === "work-state");
    assert.equal(work.passed, false);
    assert.match(work.detail, /Missing context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported work providers cannot qualify or mutate existing local work", async () => {
  const root = makeFixture(4);
  try {
    const config = readJson(root, "arrs.json");
    config.work = { provider: "jira", path: ".agent/work-items" };
    writeJson(root, "arrs.json", config);
    const file = ".agent/work-items/greeting.json";
    const original = readFileSync(join(root, file));
    const work = (await audit(root)).controls.find(
      (control) => control.id === "work-state",
    );
    assert.equal(work.passed, false);
    assert.match(work.detail, /Unsupported work provider jira/);
    assert.equal(invoke(root, ["work", "validate", file]).status, 1);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress"]).status,
      1,
    );
    assert.deepEqual(readFileSync(join(root, file)), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work configuration rejects escaped and generated-output locations", async () => {
  const root = makeFixture(4);
  try {
    const config = readJson(root, "arrs.json");
    for (const path of ["../outside", ".arrs/work-items", "./.arrs/work-items"]) {
      config.work = { provider: "local", path };
      writeJson(root, "arrs.json", config);
      const report = await audit(root);
      assert.equal(report.level, 0);
      assert.equal(
        report.controls.find((control) => control.id === "config").passed,
        false,
      );
      assert.equal(
        invoke(root, ["work", "validate", ".agent/work-items/greeting.json"]).status,
        1,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work location defaults remain compatible and missing or empty locations remain unproven", async () => {
  const root = makeFixture(4);
  try {
    assert.equal(readJson(root, "arrs.json").work, undefined);
    assert.equal(
      (await audit(root)).controls.find((control) => control.id === "work-state").passed,
      true,
    );
    rmSync(join(root, ".agent/work-items/greeting.json"));
    let work = (await audit(root)).controls.find(
      (control) => control.id === "work-state",
    );
    assert.equal(work.passed, false);
    assert.match(work.detail, /No schema-validated reference work item/);
    rmSync(join(root, ".agent/work-items"), { recursive: true });
    work = (await audit(root)).controls.find((control) => control.id === "work-state");
    assert.equal(work.passed, false);
    assert.match(work.detail, /Missing local work-item location/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured skill locations recognize existing packs and preserve local adaptations", async () => {
  const root = makeFixture(4);
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    renameSync(join(root, ".agent/skills"), join(root, "tools/skills"));
    const config = readJson(root, "arrs.json");
    config.skills.path = "tools/skills";
    writeJson(root, "arrs.json", config);
    assert.equal(
      (await audit(root)).controls.find((control) => control.id === "skills").passed,
      true,
    );
    assert.equal(
      (await doctor(root)).checks.find((check) => check.id === "skills").passed,
      true,
    );
    assert.equal(invoke(root, ["skills", "install"]).status, 0);
    const file = join(root, "tools/skills/arrs-debug/SKILL.md");
    const custom =
      readFileSync(file, "utf8") + "\nRepository-specific investigation note.\n";
    writeFileSync(file, custom);
    assert.equal(invoke(root, ["skills", "install"]).status, 1);
    assert.equal(readFileSync(file, "utf8"), custom);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work transitions enforce independently executable readiness and passing proof", () => {
  const root = makeFixture(4);
  try {
    const file = ".agent/work-items/greeting.json";
    let item = readJson(root, file);
    item.state = "needs-triage";
    item.decisions = ["Which greeting language?"];
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-agent"]).status,
      1,
    );
    assert.equal(readJson(root, file).state, "needs-triage");
    item.decisions = [];
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-agent"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      1,
    );
    const plan = readJson(root, "proof-plan.json");
    plan.task = item.id;
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    item = readJson(root, file);
    item.proof = JSON.parse(run.stdout).path;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "completed"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress"]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("risk classification prevents lowering sensitive feature/path floors", () => {
  const root = makeFixture();
  try {
    const policy = readJson(root, ".agent/policies/risk.json");
    policy.sensitivePaths.push({
      path: "src/domain",
      risk: "R3",
      reason: "Privacy-sensitive normalization boundary",
    });
    writeJson(root, ".agent/policies/risk.json", policy);
    const risk = invoke(root, ["risk", "src/domain/greeting.mjs", "--risk", "R0"]);
    assert.equal(risk.status, 0, risk.stdout);
    assert.equal(JSON.parse(risk.stdout).effective, "R3");
    assert.equal(
      invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("local metrics record meaningful outcome signals and Gardener separates evidence/enforcement", () => {
  const root = makeFixture();
  try {
    assert.equal(
      JSON.parse(invoke(root, ["metrics", "summary"]).stdout).firstPassVerificationRate,
      null,
    );
    const event = {
      schemaVersion: "0.1",
      id: "sample-1",
      task: "greet-1",
      category: "feature",
      risk: "R1",
      scopeSize: 2,
      workflow: { id: "local-agent" },
      outcome: {
        firstPassVerification: true,
        humanInterventions: 0,
        reviewRejected: false,
        reverted: false,
        escapedDefects: 0,
        architectureGateFailures: 1,
        verificationCompleteness: 1,
      },
      failureCategories: ["boundary-violation"],
      recordedAt: new Date().toISOString(),
    };
    writeJson(root, "event.json", event);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 0);
    event.id = "sample-2";
    event.task = "greet-2";
    event.outcome.firstPassVerification = false;
    event.outcome.humanInterventions = 1;
    writeJson(root, "event.json", event);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 0);
    const summary = JSON.parse(invoke(root, ["metrics", "summary"]).stdout);
    assert.equal(summary.firstPassVerificationRate, 0.5);
    assert.equal(summary.humanInterventionRate, 0.5);
    assert.equal(summary.architectureGateFailures, 2);
    const garden = invoke(root, ["gardener"]);
    assert.equal(garden.status, 0, garden.stdout);
    const report = JSON.parse(garden.stdout);
    assert.ok(
      report.candidates.some((candidate) =>
        candidate.observation.includes("Recurring failure"),
      ),
    );
    assert.ok(
      report.candidates.every(
        (candidate) =>
          candidate.evidence.length &&
          candidate.recommendedEnforcement &&
          candidate.proposedChange,
      ),
    );
    event.outcome.verificationCompleteness = 2;
    writeJson(root, "event.json", event);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metric categories count unique events and special property names remain ordinary data", () => {
  const root = makeFixture();
  try {
    const event = {
      schemaVersion: "0.1",
      id: "unique-event",
      task: "local",
      category: "docs",
      risk: "R0",
      scopeSize: 1,
      workflow: { id: "local" },
      outcome: {
        firstPassVerification: false,
        humanInterventions: 0,
        reviewRejected: false,
        reverted: false,
        escapedDefects: 0,
        architectureGateFailures: 0,
        verificationCompleteness: 1,
      },
      failureCategories: ["constructor", "__proto__"],
      recordedAt: new Date().toISOString(),
    };
    writeJson(root, "event.json", event);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 0);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 1);
    const summary = JSON.parse(invoke(root, ["metrics", "summary"]).stdout);
    assert.equal(summary.failureCategories.constructor, 1);
    assert.equal(summary.failureCategories.__proto__, 1);
    event.id = "duplicates";
    event.failureCategories = ["same", "same"];
    writeJson(root, "event.json", event);
    assert.equal(invoke(root, ["metrics", "record", "event.json"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature IDs impose risk floors even when context only points to documentation", () => {
  const root = makeFixture(4);
  try {
    const map = readJson(root, "docs/features/greeting.json");
    map.risk = "R3";
    map.sensitivity = "sensitive";
    writeJson(root, "docs/features/greeting.json", map);
    const item = readJson(root, ".agent/work-items/greeting.json");
    item.context = ["docs/features/greeting.json"];
    item.state = "needs-triage";
    writeJson(root, ".agent/work-items/greeting.json", item);
    assert.equal(
      invoke(root, [
        "work",
        "transition",
        ".agent/work-items/greeting.json",
        "--to",
        "ready-for-agent",
      ]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("reviewable work must prove current category, acceptance and every verification target", () => {
  const root = makeFixture(4);
  try {
    const item = readJson(root, ".agent/work-items/greeting.json"),
      plan = readJson(root, "proof-plan.json");
    plan.task = item.id;
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    item.proof = JSON.parse(run.stdout).path;
    item.state = "ready-for-review";
    item.category = "bug";
    item.acceptance = ["Every recipient receives a Spanish greeting"];
    writeJson(root, ".agent/work-items/greeting.json", item);
    const result = invoke(root, ["work", "validate", ".agent/work-items/greeting.json"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /category|acceptance/);
    assert.equal(
      invoke(root, [
        "work",
        "transition",
        ".agent/work-items/greeting.json",
        "--to",
        "completed",
      ]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("technical R2 proof enables review readiness while completion and audit require bound review", async () => {
  const root = makeFixture(4);
  try {
    const file = ".agent/work-items/greeting.json";
    const item = readJson(root, file);
    item.risk = "R2";
    item.state = "in-progress";
    const plan = readJson(root, "proof-plan.json");
    plan.risk = item.risk;
    plan.task = item.id;
    plan.review = {
      independent:
        "Fixture old ambiguous plan note must not qualify as implementation review",
    };
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    item.proof = JSON.parse(run.stdout).path;
    item.review = plan.review;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review"]).status,
      0,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "completed"]).status,
      1,
    );
    assert.equal(readJson(root, file).state, "ready-for-review");
    let control = (await audit(root)).controls.find(
      (control) => control.id === "proof-evidence",
    );
    assert.equal(control.passed, false, control.detail);
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture reviewer examined the completed greeting diff and proof",
    });
    assert.equal(invoke(root, ["proof", "review", item.proof, "review.json"]).status, 0);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "completed"]).status,
      0,
    );
    control = (await audit(root)).controls.find(
      (control) => control.id === "proof-evidence",
    );
    assert.equal(control.passed, true, control.detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blank explicit work authorization blocks execution and cannot inherit legacy permission", () => {
  const root = makeFixture(4);
  try {
    const path = ".agent/work-items/greeting.json";
    const item = readJson(root, path);
    item.risk = "R3";
    item.review = {
      independent: "Fixture note about planned work",
      humanApproval: "Fixture human authorized bounded work execution",
    };
    item.authorization = { humanApproval: " ".repeat(12) };
    writeJson(root, path, item);
    assert.equal(
      invoke(root, ["work", "transition", path, "--to", "in-progress"]).status,
      1,
    );
    assert.equal(readJson(root, path).state, "ready-for-agent");
    delete item.authorization;
    writeJson(root, path, item);
    assert.equal(
      invoke(root, ["work", "transition", path, "--to", "in-progress"]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected work retains baseline gates and rejects underdeclared transitions without mutation", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture();
  try {
    const file = ".agent/work-items/transition.json";
    const item = {
      schemaVersion: "0.1",
      id: plan.task,
      title: "Review the policy pointer transition",
      state: "needs-triage",
      risk: "R0",
      category: "feature",
      featureIds: ["greeting"],
      acceptance: plan.acceptance,
      context: ["arrs.json"],
      verificationTargets: ["greet"],
      dependencies: [],
      decisions: [],
    };
    writeJson(root, file, item);
    const original = readFileSync(join(root, file));
    const before = existsSync(join(root, ".arrs/evidence"))
      ? readdirSync(join(root, ".arrs/evidence")).sort()
      : [];
    const underdeclared = invoke(root, [
      "work",
      "transition",
      file,
      "--to",
      "ready-for-agent",
      ...flags,
    ]);
    assert.equal(underdeclared.status, 1, underdeclared.stdout);
    assert.match(JSON.parse(underdeclared.stdout).error, /risk is lower|below/);
    assert.deepEqual(readFileSync(join(root, file)), original);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(
      existsSync(join(root, ".arrs/evidence"))
        ? readdirSync(join(root, ".arrs/evidence")).sort()
        : [],
      before,
    );
    item.risk = "R3";
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-agent", ...flags])
        .status,
      1,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "human-required", ...flags])
        .status,
      0,
    );
    assert.deepEqual(readJson(root, file).policyBaseline, baseline);
    const bound = readFileSync(join(root, file));
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress"]).status,
      1,
    );
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress", ...flags]).status,
      1,
    );
    assert.deepEqual(readFileSync(join(root, file)), bound);
    item.state = "human-required";
    item.authorization = {
      humanApproval:
        "Fixture assertion authorizes execution; no real human acceptance is claimed",
    };
    item.policyBaseline = baseline;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "in-progress", ...flags]).status,
      0,
    );
    plan.risk = "R3";
    plan.authorization = item.authorization;
    writeJson(root, "proof-plan.json", plan);
    const proof = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(proof.status, 0, proof.stdout);
    item.state = "in-progress";
    item.proof = JSON.parse(proof.stdout).path;
    writeJson(root, file, item);
    assert.equal(
      invoke(root, ["work", "transition", file, "--to", "ready-for-review", ...flags])
        .status,
      0,
    );
    const reviewReady = readFileSync(join(root, file));
    const complete = invoke(root, [
      "work",
      "transition",
      file,
      "--to",
      "completed",
      ...flags,
    ]);
    assert.equal(complete.status, 1, complete.stdout);
    assert.match(JSON.parse(complete.stdout).error, /No valid implementation review/);
    assert.deepEqual(readFileSync(join(root, file)), reviewReady);
    assert.equal(invoke(root, ["work", "validate", file]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

// Issue 37 exercises the public CLI and the shared immutable observation interface.
const outcomes = await import("../dist/core/outcomes.js");
const outcomeSha = (value) => outcomes.outcomeDigest(value);
function lifecycleFixture(task, extra = {}) {
  return {
    schemaVersion: "0.2",
    id: outcomeSha(`allocated:${task}`),
    task,
    category: "feature",
    risk: "R1",
    featureIds: ["greeting"],
    workflow: { id: "pilot", model: "model-a" },
    controls: { arrsVersion: "0.1.0", sha256: outcomeSha("controls-a") },
    recordedAt: "2026-10-01T00:00:00.000Z",
    source: { kind: "arrs-proof", ref: outcomeSha(task) },
    failureCategories: [],
    kind: "lifecycle",
    event: { kind: "proof-allocated", attemptId: task },
    ...extra,
  };
}
function observationFixture(task, values, extra = {}) {
  return {
    ...lifecycleFixture(task),
    id: outcomeSha(`observed:${task}`),
    kind: "observation",
    event: undefined,
    recordedAt: "2026-10-08T00:00:00.000Z",
    source: { kind: "maintainer", ref: outcomeSha(`followup:${task}`) },
    window: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
    values,
    ...extra,
  };
}

function outcomePublicationFault(t, platform, operation, code) {
  const root = makeFixture(3);
  const record = lifecycleFixture(`publication-${platform}-${operation}-${code}`);
  const parent = join(root, ".arrs/metrics/outcomes");
  const final = join(parent, `${record.id}.json`);
  const native = {
    open: fs.openSync,
    close: fs.closeSync,
    sync: fs.fsyncSync,
    link: fs.linkSync,
  };
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const injected = Object.assign(new Error(`fixture ${operation} ${code}`), { code });
  const descriptors = new Map();
  const events = [];
  const pendingPayloads = [];
  const mocks = [];
  let fileFlushed = false;
  t.after(() => {
    try {
      assert.equal(descriptors.size, 0, "publication must close every opened handle");
    } finally {
      for (const descriptor of descriptors.keys()) native.close(descriptor);
      for (const mock of mocks.reverse()) mock.mock.restore();
      Object.defineProperty(process, "platform", platformDescriptor);
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
  mocks.push(
    t.mock.method(fs, "openSync", (path, flags, ...args) => {
      const kind =
        path === parent
          ? "parent"
          : flags === "wx" && String(path).startsWith(join(parent, ".pending-"))
            ? "file"
            : undefined;
      if (!kind) return native.open(path, flags, ...args);
      if (kind === "parent" && operation === "parent-open") throw injected;
      const descriptor = native.open(path, flags, ...args);
      descriptors.set(descriptor, kind);
      if (kind === "file") fileFlushed = false;
      events.push(`open:${kind}`);
      return descriptor;
    }),
    t.mock.method(fs, "fsyncSync", (descriptor) => {
      const kind = descriptors.get(descriptor);
      assert.ok(kind, "only publication-owned descriptors may be injected");
      events.push(`sync:${kind}`);
      if (operation === `${kind}-sync`) throw injected;
      native.sync(descriptor);
      if (kind === "file") fileFlushed = true;
    }),
    t.mock.method(fs, "linkSync", (temporary, target) => {
      assert.equal(fileFlushed, true, "file bytes must be flushed before publication");
      assert.equal(target, final);
      const bytes = readFileSync(temporary);
      assert.equal(JSON.parse(bytes).id, record.id);
      pendingPayloads.push(bytes);
      events.push("link");
      if (operation === "link") throw injected;
      return native.link(temporary, target);
    }),
    t.mock.method(fs, "closeSync", (descriptor) => {
      const kind = descriptors.get(descriptor);
      if (kind) events.push(`close:${kind}`);
      native.close(descriptor);
      descriptors.delete(descriptor);
    }),
  );
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  syncBuiltinESMExports();
  return { root, record, parent, final, events, pendingPayloads, injected };
}

test("outcome publication flushes file bytes and tolerates only Windows parent-fsync EPERM", (t) => {
  const fixture = outcomePublicationFault(t, "win32", "parent-sync", "EPERM");
  const result = outcomes.appendOutcome(fixture.root, fixture.record);
  assert.equal(result.recorded, true);
  assert.deepEqual(fixture.events, [
    "open:file",
    "sync:file",
    "close:file",
    "link",
    "open:parent",
    "sync:parent",
    "close:parent",
  ]);
  const original = readFileSync(fixture.final);
  assert.deepEqual(original, fixture.pendingPayloads[0]);
  assert.deepEqual(outcomes.readOutcomeRecords(fixture.root), [fixture.record]);
  assert.equal(outcomes.appendOutcome(fixture.root, fixture.record).recorded, false);
  assert.throws(
    () =>
      outcomes.appendOutcome(fixture.root, {
        ...fixture.record,
        failureCategories: ["verification-failed"],
      }),
    /Conflicting outcome idempotency key/,
  );
  assert.deepEqual(readFileSync(fixture.final), original);
  assert.deepEqual(readdirSync(fixture.parent), [`${fixture.record.id}.json`]);
});

for (const [platform, operation, code, committed] of [
  ["win32", "file-sync", "EPERM", false],
  ["win32", "parent-sync", "EIO", true],
  ["linux", "parent-sync", "EPERM", true],
  ["win32", "parent-open", "EPERM", true],
  ["win32", "link", "EPERM", false],
]) {
  test(`outcome publication rejects ${platform} ${operation} ${code} without masking failure`, (t) => {
    const fixture = outcomePublicationFault(t, platform, operation, code);
    assert.throws(
      () => outcomes.appendOutcome(fixture.root, fixture.record),
      (error) => error === fixture.injected,
    );
    assert.equal(existsSync(fixture.final), committed);
    if (committed) {
      assert.deepEqual(readFileSync(fixture.final), fixture.pendingPayloads[0]);
      assert.deepEqual(outcomes.readOutcomeRecords(fixture.root), [fixture.record]);
    }
    if (operation === "file-sync") assert.equal(fixture.events.includes("link"), false);
    assert.deepEqual(
      readdirSync(fixture.parent),
      committed ? [`${fixture.record.id}.json`] : [],
    );
  });
}

test("lifecycle CLI retains a failed first attempt and passing retry without summary/validation duplicates", () => {
  const root = makeFixture(3);
  try {
    const source = join(root, "src/domain/greeting.mjs");
    const good = readFileSync(source);
    writeFileSync(source, "export const greeting = () => 'broken';\n");
    const failed = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(failed.status, 1, failed.stdout);
    writeFileSync(source, good);
    const passed = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(passed.status, 0, passed.stdout);
    const proof = JSON.parse(passed.stdout).path;
    const before = outcomes.readOutcomeRecords(root);
    assert.equal(before.length, 4);
    for (let i = 0; i < 2; i++) {
      assert.equal(invoke(root, ["proof", "validate", proof]).status, 0);
      const summary = JSON.parse(invoke(root, ["metrics", "summary"]).stdout).lifecycle;
      assert.equal(summary.tasks, 1);
      assert.equal(summary.attempts, 2);
      assert.equal(summary.passedAttempts, 1);
      assert.equal(summary.completedTasks, 0);
      assert.deepEqual(summary.metrics.firstPassVerification, {
        known: 1,
        unknown: 0,
        positive: 0,
        total: 0,
        rate: 0,
        average: 0,
      });
      assert.equal(summary.metrics.reverted.unknown, 1);
      assert.equal(invoke(root, ["metrics", "export", "--preview"]).status, 0);
    }
    assert.deepEqual(outcomes.readOutcomeRecords(root), before);
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture reviewer examined actual implementation",
    });
    for (let i = 0; i < 2; i++)
      assert.equal(invoke(root, ["proof", "review", proof, "review.json"]).status, 0);
    assert.equal(
      outcomes
        .readOutcomeRecords(root)
        .filter((record) => record.event?.kind === "review-attached").length,
      1,
    );
    assert.equal(outcomes.readOutcomeRecords(root).length, 5);
    const outcomeDirectory = join(root, ".arrs/metrics/outcomes");
    if (process.platform === "win32") {
      // Node mode bits do not establish owner-only Windows ACL privacy.
      const probePath = join(outcomeDirectory, ".windows-access-probe");
      try {
        writeFileSync(probePath, "fixture read/write access", { flag: "wx" });
        assert.equal(readFileSync(probePath, "utf8"), "fixture read/write access");
        assert.deepEqual(
          readJson(root, `.arrs/metrics/outcomes/${before[0].id}.json`),
          before[0],
        );
      } finally {
        rmSync(probePath, { force: true });
      }
    } else {
      assert.equal(
        lstatSync(join(outcomeDirectory, `${before[0].id}.json`)).mode & 0o777,
        0o600,
      );
      assert.equal(lstatSync(outcomeDirectory).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "actual interrupted allocation stays incomplete and cannot improve first pass or completion",
  { timeout: 15000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { cli } = await import("./helpers.mjs");
    const root = makeFixture(3);
    let child, exited;
    const waitForExit = async () => {
      let timer;
      try {
        const result = await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), 5000);
          }),
        ]);
        assert.ok(
          !result.timedOut,
          "Interrupted proof process must exit within five seconds",
        );
        assert.ifError(result.error);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const config = readJson(root, "arrs.json");
      config.commands.check = {
        argv: [process.execPath, "-e", "setTimeout(()=>{},500)"],
      };
      writeJson(root, "arrs.json", config);
      child = spawn(
        process.execPath,
        [cli, "proof", "run", "proof-plan.json", "--execute", "--json", "--root", root],
        { stdio: "ignore" },
      );
      exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => resolve({ error }));
      });
      for (
        let index = 0;
        index < 200 && outcomes.readOutcomeRecords(root).length === 0;
        index++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(outcomes.readOutcomeRecords(root).length, 1);
      child.kill("SIGKILL");
      await waitForExit();
      const summary = JSON.parse(invoke(root, ["metrics", "summary"]).stdout).lifecycle;
      assert.equal(summary.attempts, 1);
      assert.equal(summary.incompleteAttempts, 1);
      assert.equal(summary.passedAttempts, 0);
      assert.equal(summary.completedTasks, 0);
      assert.equal(summary.metrics.firstPassVerification.known, 0);
      assert.equal(summary.metrics.firstPassVerification.unknown, 1);
    } finally {
      try {
        if (child) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await waitForExit();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test("observations preserve late history, unknown denominators, exact windows and comparable cohorts", () => {
  const root = makeFixture(3);
  try {
    for (let i = 0; i < 5; i++)
      outcomes.appendOutcome(root, lifecycleFixture(`task-${i}`));
    for (const [index, reverted] of [
      [0, true],
      [1, false],
    ]) {
      writeJson(
        root,
        "observation.json",
        observationFixture(`task-${index}`, {
          reverted,
          escapedDefects: 0,
          humanInterventions: 0,
        }),
      );
      assert.equal(invoke(root, ["metrics", "observe", "observation.json"]).status, 0);
      assert.equal(
        JSON.parse(invoke(root, ["metrics", "observe", "observation.json"]).stdout)
          .recorded,
        false,
      );
    }
    let summary = JSON.parse(
      invoke(root, [
        "metrics",
        "summary",
        "--workflow",
        "pilot",
        "--model",
        "model-a",
        "--category",
        "feature",
        "--risk",
        "R1",
        "--feature",
        "greeting",
        "--controls",
        outcomeSha("controls-a"),
        "--window",
        "7d",
      ]).stdout,
    ).lifecycle;
    assert.equal(summary.tasks, 5);
    assert.equal(summary.metrics.reverted.known, 2);
    assert.equal(summary.metrics.reverted.unknown, 3);
    assert.equal(summary.metrics.reverted.rate, 0.5);
    assert.equal(summary.metrics.escapedDefects.rate, 0);
    assert.equal(summary.metrics.humanInterventions.rate, 0);
    assert.deepEqual(summary.windowCoverage, { known: 2, unknown: 3 });
    summary = JSON.parse(
      invoke(root, ["metrics", "summary", "--window", "14d"]).stdout,
    ).lifecycle;
    assert.equal(summary.metrics.reverted.known, 0);
    assert.equal(summary.metrics.reverted.rate, null);
    assert.equal(summary.excluded.incompatibleWindow, 2);
    const prior = observationFixture("task-0", { reverted: true });
    const late = observationFixture(
      "task-0",
      { reverted: true, escapedDefects: 1, reviewRejected: true },
      {
        id: outcomeSha("late-task0"),
        recordedAt: "2026-10-09T00:00:00.000Z",
        supersedes: [prior.id],
      },
    );
    writeJson(root, "observation.json", late);
    assert.equal(invoke(root, ["metrics", "observe", "observation.json"]).status, 0);
    assert.equal(outcomes.readOutcomeRecords(root).length, 8);
    summary = JSON.parse(
      invoke(root, ["metrics", "summary", "--window", "7d"]).stdout,
    ).lifecycle;
    assert.equal(summary.excluded.superseded, 1);
    assert.equal(summary.metrics.escapedDefects.total, 1);
    assert.equal(summary.metrics.reviewRejected.known, 1);
    assert.equal(summary.metrics.reviewRejected.unknown, 4);
    assert.equal(summary.metrics.reviewRejected.rate, 1);
    const unknown = observationFixture("task-2", {
      reverted: null,
      durationSeconds: null,
      cost: null,
    });
    writeJson(root, "observation.json", unknown);
    assert.equal(invoke(root, ["metrics", "observe", "observation.json"]).status, 0);
    outcomes.appendOutcome(
      root,
      lifecycleFixture("different-cohort", {
        risk: "R3",
        workflow: { id: "other" },
        controls: { arrsVersion: "0.1.0", sha256: outcomeSha("controls-b") },
      }),
    );
    summary = JSON.parse(
      invoke(root, ["metrics", "summary", "--workflow", "pilot", "--risk", "R1"]).stdout,
    ).lifecycle;
    assert.equal(summary.tasks, 5);
    assert.equal(summary.excluded.cohort, 1);
    summary = JSON.parse(
      invoke(root, ["metrics", "summary", "--risk", "R4"]).stdout,
    ).lifecycle;
    assert.equal(summary.tasks, 0);
    assert.equal(summary.metrics.reverted.rate, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome conflicts, malformed versions, corrupt persistence and unsupported flags fail before observation writes", () => {
  const root = makeFixture(3);
  try {
    const first = observationFixture("task", { reverted: false });
    delete first.event;
    writeJson(root, "observation.json", first);
    assert.equal(invoke(root, ["metrics", "observe", "observation.json"]).status, 0);
    const inventory = readdirSync(join(root, ".arrs/metrics/outcomes"));
    for (const malformed of [
      { ...first, values: { reverted: true } },
      { ...first, schemaVersion: "9" },
      { ...first, values: { escapedDefects: -1 } },
      { ...first, recordedAt: "2026-02-30T00:00:00Z" },
      {
        ...first,
        window: { start: "2026-10-08T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
      },
      {
        ...first,
        id: outcomeSha("missing-supersedes"),
        supersedes: [outcomeSha("missing")],
      },
      { ...first, id: outcomeSha("unlinked-update") },
    ]) {
      writeJson(root, "observation.json", malformed);
      const result = invoke(root, ["metrics", "observe", "observation.json"]);
      assert.equal(result.status, 1, result.stdout);
      assert.ok(JSON.parse(result.stdout).error);
      assert.deepEqual(readdirSync(join(root, ".arrs/metrics/outcomes")), inventory);
    }
    for (const args of [
      ["metrics", "summary", "--execute"],
      ["metrics", "observe", "observation.json", "--window", "7d"],
      ["metrics", "export"],
      ["metrics", "summary", "--window", "0d"],
      ["metrics", "summary", "--start", "2026-10-01T00:00:00Z"],
    ]) {
      const result = invoke(root, args);
      assert.equal(result.status, 1, result.stdout);
      assert.ok(JSON.parse(result.stdout).error);
    }
    writeFileSync(join(root, ".arrs/metrics/outcomes", inventory[0]), "{corrupt");
    assert.equal(invoke(root, ["metrics", "summary"]).status, 1);
    assert.equal(invoke(root, ["metrics", "export", "--preview"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent duplicate outcome publication and partial temporary files retain one committed observation", async () => {
  const { spawn } = await import("node:child_process");
  const { cli } = await import("./helpers.mjs");
  const root = makeFixture(3);
  try {
    writeJson(
      root,
      "observation.json",
      observationFixture("concurrent", { reverted: false }),
    );
    const launch = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, "metrics", "observe", "observation.json", "--root", root, "--json"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, output }));
      });
    const results = await Promise.all([launch(), launch()]);
    assert.ok(
      results.every((result) => result.code === 0),
      JSON.stringify(results),
    );
    assert.equal(
      results.filter((result) => JSON.parse(result.output).recorded).length,
      1,
    );
    assert.equal(outcomes.readOutcomeRecords(root).length, 1);
    writeFileSync(
      join(root, ".arrs/metrics/outcomes/.pending-00000000-0000-0000-0000-000000000000"),
      "partial{",
    );
    const summary = JSON.parse(invoke(root, ["metrics", "summary"]).stdout).lifecycle;
    assert.equal(summary.tasks, 1);
    assert.equal(summary.uncommittedTemporaryFiles, 1);
    assert.equal(summary.metrics.reverted.known, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector write failure and unsafe storage leave canonical proof/work admission unchanged", () => {
  const root = makeFixture(4);
  const outside = mkdtempSync(join(tmpdir(), "arrs-outcomes-outside-"));
  try {
    mkdirSync(join(root, ".arrs/metrics"), { recursive: true });
    writeFileSync(
      join(root, ".arrs/metrics/outcomes"),
      "injected non-directory writer failure",
    );
    const item = readJson(root, ".agent/work-items/greeting.json");
    const plan = readJson(root, "proof-plan.json");
    plan.task = item.id;
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.manifest.status, "passed");
    assert.ok(result.outcomeWarnings.length >= 1);
    const proofBytes = readFileSync(join(root, result.path));
    assert.equal(invoke(root, ["proof", "validate", result.path]).status, 0);
    item.state = "in-progress";
    item.proof = result.path;
    writeJson(root, ".agent/work-items/greeting.json", item);
    const moved = invoke(root, [
      "work",
      "transition",
      ".agent/work-items/greeting.json",
      "--to",
      "ready-for-review",
    ]);
    assert.equal(moved.status, 0, moved.stdout);
    assert.ok(JSON.parse(moved.stdout).outcomeWarnings.length >= 1);
    assert.equal(
      readJson(root, ".agent/work-items/greeting.json").state,
      "ready-for-review",
    );
    assert.deepEqual(readFileSync(join(root, result.path)), proofBytes);
    assert.equal(invoke(root, ["metrics", "summary"]).status, 1);
    rmSync(join(root, ".arrs/metrics/outcomes"));
    symlinkSync(outside, join(root, ".arrs/metrics/outcomes"), "dir");
    assert.equal(invoke(root, ["metrics", "summary"]).status, 1);
    writeJson(
      root,
      "observation.json",
      observationFixture("unsafe", { reverted: false }),
    );
    assert.equal(invoke(root, ["metrics", "observe", "observation.json"]).status, 1);
    assert.equal(invoke(root, ["metrics", "observe", "../observation.json"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Gardener preserves parser-recognized multiline directives and redacts every known credential family", async () => {
  const { maintenanceComments, maintenanceExcerpt } =
    await import("../dist/core/maintenance.js");
  const marker = "@ts-" + "ignore";
  const input = `/*\n * ${marker} */\nconst value:number='bad';\n// ordinary explanation ${marker}\n`;
  const result = maintenanceComments("test.ts", input);
  assert.equal(
    result.comments.filter((comment) => comment.rule === "suppression").length,
    1,
  );
  assert.equal(result.comments[0].line, 2);
  assert.equal(
    maintenanceComments(
      "test.ts",
      `const value = '${marker}';\n// explanation ${marker}\n`,
    ).comments.length,
    0,
  );
  const credentials = [
    "AK" + "IA" + "A".repeat(16),
    "AS" + "IA" + "A".repeat(16),
    "gh" + "p_" + "A".repeat(32),
    "sk" + "-proj-" + "A".repeat(30),
  ];
  for (const credential of credentials) {
    assert.equal(
      maintenanceExcerpt(`TODO remove ${credential}`),
      "[credential-bearing excerpt redacted]",
    );
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, "src/domain/credential.mjs"),
        `// TODO remove ${credential}\nexport const value=1;\n`,
      );
      const report = JSON.parse(invoke(root, ["gardener"]).stdout);
      assert.equal(JSON.stringify(report).includes(credential), false);
      assert.ok(
        report.candidates.some((candidate) => candidate.ruleId === "deferred-work"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Gardener reports effective compiler nocheck line directives and excludes unsupported block near-matches", () => {
  const root = makeFixture();
  const marker = "@ts-" + "nocheck";
  const cases = [
    ["valid", `// ${marker}\n`, true],
    ["block", `/* ${marker} */\n`, false],
    ["docblock", `/** ${marker} */\n`, false],
    ["overridden", `// ${marker}\n// @ts-check\n`, false],
    ["late", `export const before=1;\n// ${marker}\n`, false],
  ];
  try {
    for (const [name, comment] of cases)
      writeFileSync(
        join(root, `src/domain/${name}.ts`),
        `${comment}export const value:number='bad';\n`,
      );
    const result = invoke(root, ["gardener"]);
    assert.equal(result.status, 0, result.stderr);
    const candidates = JSON.parse(result.stdout).candidates.filter(
      (candidate) => candidate.ruleId === "suppression",
    );
    for (const [name, , recognized] of cases) {
      const found = candidates.filter((candidate) =>
        candidate.locations.some((location) => location.path === `src/domain/${name}.ts`),
      );
      assert.equal(found.length, recognized ? 1 : 0, name);
      if (recognized) assert.equal(found[0].locations[0].line, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener plain proposal output and publication retain guarded drafts and reject provider-companion aliases", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const { cli } = await import("./helpers.mjs");
  const root = makeFixture(4);
  try {
    const source = join(root, "src/domain/greeting.mjs");
    writeFileSync(source, readFileSync(source, "utf8") + "// TODO handle empty names\n");
    const sourceBytes = readFileSync(source);
    const config = readJson(root, "arrs.json");
    writeFileSync(
      join(root, "sentinel.mjs"),
      "import {writeFileSync} from 'node:fs';writeFileSync('EXECUTED','unexpected command');\n",
    );
    config.commands.check = { argv: [process.execPath, "sentinel.mjs"] };
    writeJson(root, "arrs.json", config);
    let candidate = (await garden(root)).candidates.find(
      (item) => item.ruleId === "deferred-work",
    );
    const out = ".agent/work-items/plain-proposal.json";
    const plain = spawnSync(
      process.execPath,
      [cli, "gardener", "propose", candidate.id, "--out", out, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(plain.status, 0, plain.stderr + plain.stdout);
    assert.equal(JSON.parse(plain.stdout).created, true);
    assert.equal(readJson(root, out).state, "needs-triage");
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(readFileSync(source), sourceBytes);
    config.work = { provider: "local", path: ".agent/plans" };
    writeJson(root, "arrs.json", config);
    candidate = (await garden(root)).candidates.find(
      (item) => item.ruleId === "deferred-work",
    );
    const paths = readdirSync(join(root, ".agent/plans")).sort();
    for (const destination of [
      `.agent/plans/gardener-${candidate.id}.proof-plan.json`,
      `.agent/plans/ordinary.json`,
    ]) {
      const result = invoke(root, [
        "gardener",
        "propose",
        candidate.id,
        "--out",
        destination,
      ]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stdout,
        /destinations must be distinct|overlap the configured work-item inventory/,
      );
      assert.deepEqual(readdirSync(join(root, ".agent/plans")).sort(), paths);
    }
    assert.deepEqual(readFileSync(source), sourceBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener concurrent conflicting proposals cannot claim success with another output's companion bytes", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const { spawn } = await import("node:child_process");
  const { cli } = await import("./helpers.mjs");
  const root = makeFixture(4);
  try {
    const source = join(root, "src/domain/greeting.mjs");
    writeFileSync(source, readFileSync(source, "utf8") + "// TODO reject empty names\n");
    const sourceBytes = readFileSync(source);
    const candidate = (await garden(root)).candidates.find(
      (item) => item.ruleId === "deferred-work",
    );
    const launch = (out) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            cli,
            "gardener",
            "propose",
            candidate.id,
            "--out",
            out,
            "--root",
            root,
            "--json",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let stdout = "";
        child.stdout.on("data", (value) => {
          stdout += value;
        });
        child.on("error", reject);
        child.on("exit", (status) =>
          resolve({ out, status, result: JSON.parse(stdout) }),
        );
      });
    const results = await Promise.all([
      launch(".agent/work-items/race-a.json"),
      launch(".agent/work-items/race-b.json"),
    ]);
    const successes = results.filter((result) => result.status === 0);
    assert.equal(successes.length, 1, JSON.stringify(results));
    const success = successes[0];
    const failure = results.find((result) => result.status !== 0);
    assert.equal(readJson(root, success.result.proposal).workDraft, success.out);
    assert.equal(existsSync(join(root, failure.out)), false);
    assert.equal(readJson(root, success.out).proof, undefined);
    assert.deepEqual(readFileSync(source), sourceBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener recurrence counts distinct comparable tasks with retained event identities and supersession", async () => {
  const { garden } = await import("../dist/workflows/gardener.js");
  const root = makeFixture();
  try {
    const event = (task, id, extra = {}) =>
      lifecycleFixture(task, {
        id: outcomeSha(id),
        source: { kind: "arrs-proof", ref: outcomeSha(id) },
        event: { kind: "proof-completed", attemptId: id, status: "failed" },
        failureCategories: ["forbidden-import"],
        ...extra,
      });
    const first = event("task-a", "attempt-a");
    outcomes.appendOutcome(root, first);
    outcomes.appendOutcome(root, first);
    outcomes.appendOutcome(root, event("task-a", "retry-a"));
    outcomes.appendOutcome(
      root,
      event("different-model", "model-b", {
        workflow: { id: "pilot", model: "model-b" },
      }),
    );
    outcomes.appendOutcome(
      root,
      event("different-controls", "controls-b", {
        controls: { arrsVersion: "0.1.0", sha256: outcomeSha("other-controls") },
      }),
    );
    outcomes.appendOutcome(root, event("different-risk", "risk-b", { risk: "R3" }));
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await garden(root)).candidates.filter(
          (candidate) => candidate.ruleId === "recurrence",
        ).length,
        0,
      );
    const second = event("task-b", "attempt-b", {
      recordedAt: "2026-10-02T00:00:00.000Z",
    });
    outcomes.appendOutcome(root, second);
    const report = await garden(root);
    const candidate = report.candidates.find((item) => item.ruleId === "recurrence");
    assert.ok(candidate);
    assert.equal(candidate.recurrence.distinctTasks, 2);
    assert.equal(candidate.recurrence.uniqueEvents, 3);
    assert.equal(candidate.recurrence.controlIdentity, "known");
    assert.deepEqual(
      candidate.recurrence.supportingEventIds,
      [first.id, outcomeSha("retry-a"), second.id].sort(),
    );
    assert.equal(candidate.recurrence.start, first.recordedAt);
    assert.equal(candidate.recurrence.end, second.recordedAt);
    assert.equal(
      candidate.provenance.filter((item) => item.kind === "observation").length,
      3,
    );
    assert.equal(
      (await garden(root)).candidates.find((item) => item.ruleId === "recurrence").id,
      candidate.id,
    );
    const proposal = invoke(root, [
      "gardener",
      "propose",
      candidate.id,
      "--out",
      ".agent/work-items/recurrence.json",
    ]);
    assert.equal(proposal.status, 1, proposal.stdout);
    assert.match(proposal.stdout, /unresolved scope/);
    const before = observationFixture(
      "observed-a",
      { reviewRejected: true },
      { failureCategories: ["review-rejection"] },
    );
    const other = observationFixture(
      "observed-b",
      { reviewRejected: true },
      { failureCategories: ["review-rejection"] },
    );
    outcomes.observeOutcome(root, JSON.parse(JSON.stringify(before)));
    outcomes.observeOutcome(root, JSON.parse(JSON.stringify(other)));
    assert.ok(
      (await garden(root)).candidates.some((item) =>
        item.observation.includes("review-rejection"),
      ),
    );
    const replacement = {
      ...before,
      id: outcomeSha("replacement-a"),
      recordedAt: "2026-10-09T00:00:00.000Z",
      values: { reviewRejected: false },
      failureCategories: [],
      supersedes: [before.id],
    };
    outcomes.observeOutcome(root, JSON.parse(JSON.stringify(replacement)));
    assert.equal(
      (await garden(root)).candidates.some((item) =>
        item.observation.includes("review-rejection"),
      ),
      false,
    );
    writeFileSync(join(root, ".arrs/metrics/outcomes", `${second.id}.json`), "{invalid");
    assert.equal(invoke(root, ["gardener"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot protocol preserves unknown denominators, exclusions and deterministic local replay", () => {
  const script = join(packageRoot, "scripts/pilot-protocol.mjs");
  const fixture = "docs/qualification/pilots/missing-observations.json";
  const run = (...options) =>
    spawnSync(process.execPath, [script, fixture, "--root", packageRoot, ...options], {
      encoding: "utf8",
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.kind, "control-fixture");
  assert.equal(report.authorizedPilotCount, 0);
  assert.equal(report.outstandingContexts.length, 3);
  assert.equal(report.includedTaskCount, 3);
  assert.equal(report.excludedTaskCount, 1);
  assert.deepEqual(report.observations.reviewActiveSeconds, {
    observed: 1,
    missing: 2,
    total: 90,
    mean: 90,
  });
  assert.deepEqual(report.observations.escapedDefects, {
    observed: 1,
    missing: 2,
    total: 0,
    mean: 0,
  });
  assert.equal(report.incompleteFollowUp.length, 2);
  assert.equal(report.comparisons[0].status, "excluded");
  assert.ok(report.comparisons[0].reasons.includes("window-mismatch"));
  assert.ok(report.comparisons[1].reasons.includes("category-mismatch"));
  assert.ok(report.comparisons[1].reasons.includes("risk-mismatch"));
  assert.equal(run().stdout, first.stdout);
  const exported = run("--export");
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).exportRequested, true);
  assert.ok(!exported.stdout.includes("src/domain"));
  assert.ok(!exported.stdout.includes("fixture-tool"));
});

test("pilot protocol rejects malformed or unsafe ledgers without modifying observations", () => {
  const root = makeFixture(3);
  const script = join(packageRoot, "scripts/pilot-protocol.mjs");
  const original = JSON.parse(
    readFileSync(
      join(packageRoot, "docs/qualification/pilots/missing-observations.json"),
      "utf8",
    ),
  );
  const run = (path = ".arrs/pilots/ledger.json", ...args) =>
    spawnSync(process.execPath, [script, path, "--root", root, ...args], {
      encoding: "utf8",
    });
  const cases = [
    (x) => {
      x.protocolVersion = "future";
    },
    (x) => {
      x.reviewTranscript = "excluded-content";
    },
    (x) => {
      x.tasks.push(structuredClone(x.tasks[0]));
    },
    (x) => {
      x.kind = "application-study";
    },
    (x) => {
      x.tasks[1].observations.escapedDefects = 0;
    },
    (x) => {
      x.tasks[1].scope = ["../outside"];
    },
    (x) => {
      x.tasks[1].selectedAttempt = ".arrs/evidence/missing/proof.json";
    },
    (x) => {
      x.tasks[1].observations.reviewActiveSeconds = -1;
    },
    (x) => {
      x.tasks[0].observationWindow.completedDays = 15;
    },
  ];
  for (const mutate of cases) {
    const ledger = structuredClone(original);
    mutate(ledger);
    writeJson(root, ".arrs/pilots/ledger.json", ledger);
    const before = readFileSync(join(root, ".arrs/pilots/ledger.json"));
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(join(root, ".arrs/pilots/ledger.json")), before);
  }
  writeJson(root, ".arrs/pilots/ledger.json", original);
  assert.equal(run("../outside.json").status, 1);
  assert.equal(run(".arrs/pilots/ledger.json", "--execute").status, 1);
  symlinkSync(join(root, ".arrs/pilots/ledger.json"), join(root, "ledger-link.json"));
  assert.equal(run("ledger-link.json").status, 1);
  writeFileSync(join(root, ".arrs/pilots/large.json"), " ".repeat(1024 * 1024 + 1));
  assert.equal(run(".arrs/pilots/large.json").status, 1);
  const paired = structuredClone(original);
  paired.tasks[1].observationWindow = structuredClone(paired.tasks[0].observationWindow);
  paired.tasks[1].observations.reverted = null;
  writeJson(root, ".arrs/pilots/ledger.json", paired);
  const comparable = run();
  assert.equal(comparable.status, 0, comparable.stderr);
  assert.equal(JSON.parse(comparable.stdout).comparisons[0].status, "comparable");
});

test("pilot protocol links failed and selected actual proof attempts without claiming pending review", async () => {
  const root = makeFixture(3);
  const script = join(packageRoot, "scripts/pilot-protocol.mjs");
  const ledger = JSON.parse(
    readFileSync(
      join(packageRoot, "docs/qualification/pilots/missing-observations.json"),
      "utf8",
    ),
  );
  const task = ledger.tasks[1];
  task.id = "pilot-proof-task";
  task.risk = "R2";
  task.scope = ["src/domain", "src/application"];
  ledger.tasks = [task];
  ledger.comparisons = [];
  const plan = readJson(root, "proof-plan.json");
  plan.task = task.id;
  plan.risk = task.risk;
  writeJson(root, "proof-plan.json", plan);
  const config = readJson(root, "arrs.json");
  const nativeTest = config.commands.test;
  config.commands.test = { argv: [process.execPath, "-e", "process.exit(37)"] };
  writeJson(root, "arrs.json", config);
  const failure = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  const failedPath = JSON.parse(failure.stdout).path;
  config.commands.test = nativeTest;
  writeJson(root, "arrs.json", config);
  const passing = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  const passedPath = JSON.parse(passing.stdout).path;
  task.attempts = [failedPath, passedPath];
  task.selectedAttempt = passedPath;
  writeJson(root, ".arrs/pilots/ledger.json", ledger);
  const run = () =>
    spawnSync(process.execPath, [script, ".arrs/pilots/ledger.json", "--root", root], {
      encoding: "utf8",
    });
  const pending = run();
  assert.equal(pending.status, 0, pending.stderr);
  const report = JSON.parse(pending.stdout);
  assert.equal(report.evidence.length, 2);
  assert.equal(report.evidence[0].capturedStatus, "failed");
  assert.equal(report.evidence[0].technical, "invalid");
  assert.equal(report.evidence[0].selected, false);
  assert.equal(report.evidence[1].technical, "valid");
  assert.equal(report.evidence[1].acceptance, "pending-or-invalid");
  assert.equal(report.evidence[1].selected, true);
  assert.ok(report.evidence[0].commands.some((command) => command.exitCode === 37));
  const review = {
    schemaVersion: "0.1",
    stage: "implementation",
    independent:
      "Synthetic test reviewer examined the selected fixture implementation and actual passing attempt; no application participation is claimed.",
  };
  writeJson(root, "test-review.json", review);
  const attached = invoke(root, ["proof", "review", passedPath, "test-review.json"]);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  assert.equal(JSON.parse(run().stdout).evidence[1].acceptance, "accepted");
  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    "export const greeting = () => 'changed';\n",
  );
  assert.equal(JSON.parse(run().stdout).evidence[1].technical, "invalid");
  task.selectedAttempt = failedPath;
  writeJson(root, ".arrs/pilots/ledger.json", ledger);
  const failedSelected = JSON.parse(run().stdout).evidence.find(
    (entry) => entry.selected,
  );
  assert.equal(failedSelected.acceptance, "pending-or-invalid");
  task.id = "different-task";
  writeJson(root, ".arrs/pilots/ledger.json", ledger);
  assert.equal(run().status, 1);
});

test("outcome inventory rejects duplicate lifecycle identities and conflicting attempt facts across cohorts", () => {
  const root = makeFixture();
  try {
    const first = lifecycleFixture("task-one", {
      event: { kind: "proof-completed", attemptId: "attempt-one", status: "passed" },
    });
    outcomes.appendOutcome(root, first);
    assert.equal(
      JSON.parse(invoke(root, ["metrics", "summary"]).stdout).lifecycle.passedAttempts,
      1,
    );
    const path = `.arrs/metrics/outcomes/${outcomeSha("corrupt-duplicate")}.json`;
    for (const corrupt of [
      { ...first, id: outcomeSha("corrupt-duplicate") },
      {
        ...first,
        id: outcomeSha("corrupt-duplicate"),
        source: { kind: "arrs-proof", ref: outcomeSha("other-source") },
        event: { ...first.event, status: "failed" },
      },
      {
        ...first,
        id: outcomeSha("corrupt-duplicate"),
        source: { kind: "arrs-proof", ref: outcomeSha("other-source") },
        workflow: { id: "different-workflow" },
        controls: { arrsVersion: "0.1.0", sha256: outcomeSha("different-controls") },
      },
    ]) {
      writeJson(root, path, corrupt);
      const result = invoke(root, ["metrics", "summary"]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(JSON.parse(result.stdout).error, /Duplicate or conflicting lifecycle/);
      assert.equal(invoke(root, ["metrics", "export", "--preview"]).status, 1);
      rmSync(join(root, path));
    }
    assert.equal(
      JSON.parse(invoke(root, ["metrics", "summary"]).stdout).lifecycle.passedAttempts,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome record ordering uses actual timestamp chronology with fractional seconds", () => {
  const root = makeFixture();
  try {
    outcomes.appendOutcome(
      root,
      lifecycleFixture("later", { recordedAt: "2026-10-01T00:00:00.11Z" }),
    );
    outcomes.appendOutcome(
      root,
      lifecycleFixture("earlier", { recordedAt: "2026-10-01T00:00:00.1Z" }),
    );
    assert.deepEqual(
      outcomes.readOutcomeRecords(root).map((record) => record.task),
      ["earlier", "later"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gardener CLI scans .mts and .cts comments and preserves chronological recurrence bounds", () => {
  const root = makeFixture();
  try {
    for (const extension of ["mts", "cts"])
      writeFileSync(
        join(root, `src/domain/comments.${extension}`),
        "export const literal = 'TODO';\n// TODO preserve this actual comment\n",
      );
    let report = JSON.parse(invoke(root, ["gardener"]).stdout);
    for (const extension of ["mts", "cts"])
      assert.ok(
        report.candidates.some(
          (candidate) =>
            candidate.ruleId === "deferred-work" &&
            candidate.locations.some(
              (location) =>
                location.path === `src/domain/comments.${extension}` &&
                location.line === 2,
            ),
        ),
      );
    for (const [task, recordedAt] of [
      ["earlier", "2026-10-01T00:00:00.1Z"],
      ["later", "2026-10-01T00:00:00.11Z"],
    ])
      outcomes.appendOutcome(
        root,
        lifecycleFixture(task, {
          id: outcomeSha(`chronology-${task}`),
          source: { kind: "arrs-proof", ref: outcomeSha(`chronology-${task}`) },
          recordedAt,
          failureCategories: ["chronology-case"],
          event: { kind: "proof-completed", attemptId: task, status: "failed" },
        }),
      );
    report = JSON.parse(invoke(root, ["gardener"]).stdout);
    const recurrence = report.candidates.find(
      (candidate) => candidate.ruleId === "recurrence",
    );
    assert.equal(recurrence.recurrence.start, "2026-10-01T00:00:00.1Z");
    assert.equal(recurrence.recurrence.end, "2026-10-01T00:00:00.11Z");
    assert.ok(
      Date.parse(recurrence.recurrence.start) < Date.parse(recurrence.recurrence.end),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
