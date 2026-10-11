import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  makeFixture,
  makePolicyTransitionFixture,
  invoke,
  readJson,
  writeJson,
  cli,
} from "./helpers.mjs";
import { prepareTask, comparePreparedTask } from "../dist/core/prepare.js";
import { validate } from "../dist/core/schema.js";
import { validatePlan } from "../dist/core/evidence.js";
import { validateWorkItem } from "../dist/core/work.js";

const workFile = ".agent/work-items/prepare.json";
function task(root, overrides = {}) {
  const item = {
    schemaVersion: "0.1",
    id: "greeting-change",
    title: "Extend the bounded greeting capability",
    state: "needs-triage",
    risk: "R1",
    category: "feature",
    featureIds: ["greeting"],
    acceptance: ["Greets a trimmed name"],
    context: ["src/domain/greeting.mjs"],
    verificationTargets: ["greet"],
    dependencies: [],
    decisions: [],
    ...overrides,
  };
  writeJson(root, workFile, item);
  return item;
}
const snapshot = (root) =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path).toString("base64")];
      }),
  );

test("preparation selects relevant maps, dependency closure, instructions and ADRs, produces stable valid drafts without side effects", () => {
  const root = makeFixture(3);
  try {
    task(root);
    mkdirSync(join(root, "src/domain"), { recursive: true });
    writeFileSync(
      join(root, "src/domain/AGENTS.md"),
      "Preserve the greeting domain invariant and inspect its executable scenario.\n",
    );
    mkdirSync(join(root, "src/domain/vendor"), { recursive: true });
    writeFileSync(
      join(root, "src/domain/vendor/AGENTS.md"),
      "Preserve constraints for the actual nested vendor-named source; never suppress its verification.\n",
    );
    writeFileSync(
      join(root, "src/domain/vendor/parser.mjs"),
      "export const parse = value => value.trim();\n",
    );
    writeFileSync(
      join(root, "docs/adr/greeting.md"),
      "# Greeting decision\n\nTrim surrounding whitespace before producing the greeting.\n",
    );
    const map = readJson(root, "docs/features/greeting.json");
    map.related = ["docs/adr/greeting.md"];
    map.dependencies = ["formatting"];
    map.implementation = [...new Set([...map.implementation, "src/domain"])];
    writeJson(root, "docs/features/greeting.json", map);
    writeJson(root, "docs/features/formatting.json", {
      ...map,
      id: "formatting",
      dependencies: [],
      related: [],
    });
    writeJson(root, "docs/features/unrelated.json", {
      ...map,
      id: "unrelated",
      dependencies: [],
      related: ["docs/unrelated.md"],
    });
    writeFileSync(join(root, "docs/unrelated.md"), "Unrelated capability context.\n");
    const before = snapshot(root);
    const first = prepareTask(root, workFile);
    assert.deepEqual(first, prepareTask(root, workFile));
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(
      first.features.map((entry) => entry.id),
      ["formatting", "greeting"],
    );
    for (const path of [
      "docs/adr/greeting.md",
      "src/domain/AGENTS.md",
      "src/domain/vendor/AGENTS.md",
      "src/domain/greeting.mjs",
      "AGENTS.md",
    ])
      assert.ok(
        first.inventory.some(
          (entry) =>
            entry.path === path && entry.reasons.length && entry.provenance.length,
        ),
        path,
      );
    assert.ok(!first.inventory.some((entry) => /unrelated/.test(entry.path)));
    assert.ok(
      first.documents.some(
        (entry) =>
          entry.path === "src/domain/vendor/AGENTS.md" &&
          entry.text.includes("actual nested vendor-named source"),
      ),
    );
    assert.deepEqual(first.blockers, []);
    assert.equal(first.status, "draft");
    assert.equal(first.drafts.work.state, "needs-information");
    assert.deepEqual(validate("prepared-task", first), []);
    assert.deepEqual(validatePlan(root, first.drafts.proof), []);
    assert.deepEqual(validateWorkItem(root, first.drafts.work), []);
    assert.ok(
      first.drafts.proof.steps.some(
        (step) => step.criterion === "Greets a trimmed name" && step.phase === "behavior",
      ),
    );
    assert.match(first.requirements.limitation, /candidate-only|cannot/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packet detects referenced source/config drift and comparison rejects unsupported versions", () => {
  const root = makeFixture(3);
  try {
    task(root);
    const before = prepareTask(root, workFile);
    writeFileSync(join(root, "unrelated.txt"), "outside task scope");
    assert.equal(prepareTask(root, workFile).id, before.id);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => 'Hello, ' + name + '!';\n",
    );
    const current = prepareTask(root, workFile);
    const comparison = comparePreparedTask(before, current);
    assert.equal(comparison.stale, true);
    assert.ok(comparison.changedPaths.includes("src/domain/greeting.mjs"));
    assert.throws(
      () => comparePreparedTask({ ...before, schemaVersion: "0.2" }, current),
      /Invalid prepared-task/,
    );
    const config = readJson(root, "arrs.json");
    config.verifyTargets.greet.timeoutSeconds = 12;
    writeJson(root, "arrs.json", config);
    assert.notEqual(prepareTask(root, workFile).id, current.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing facts, cycles, unknown features and navigation limits never produce executable proof drafts", () => {
  const root = makeFixture(3);
  try {
    task(root, {
      dependencies: ["pending upstream decision"],
      decisions: ["data retention"],
    });
    let packet = prepareTask(root, workFile);
    assert.ok(packet.blockers.some((entry) => entry.includes("Unresolved")));
    assert.equal(packet.drafts.proof, undefined);
    task(root, { featureIds: ["unknown"] });
    packet = prepareTask(root, workFile);
    assert.ok(
      packet.blockers.some((entry) =>
        entry.includes("Unknown candidate feature unknown"),
      ),
    );
    task(root);
    const map = readJson(root, "docs/features/greeting.json");
    map.dependencies = ["greeting"];
    writeJson(root, "docs/features/greeting.json", map);
    packet = prepareTask(root, workFile);
    assert.ok(packet.blockers.some((entry) => entry.includes("greeting -> greeting")));
    map.dependencies = [];
    map.related = ["docs/huge.md"];
    writeFileSync(join(root, "docs/huge.md"), "x".repeat(65_000));
    writeJson(root, "docs/features/greeting.json", map);
    packet = prepareTask(root, workFile);
    assert.ok(packet.omitted.some((entry) => entry.path === "docs/huge.md"));
    assert.ok(packet.requirements.requiredChecks.includes("check"));
    assert.ok(
      packet.inventory.some((entry) => entry.path === ".agent/policies/risk.json"),
    );
    assert.equal(packet.drafts.proof, undefined);
    map.related = ["docs/missing.md"];
    writeJson(root, "docs/features/greeting.json", map);
    assert.throws(() => prepareTask(root, workFile), /Referenced path does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bug/refactor scenarios retain explicitly supplied identities/exits and never invent baseline success or failure", () => {
  const root = makeFixture(3);
  try {
    task(root, { category: "bug" });
    const missing = prepareTask(root, workFile);
    assert.ok(
      missing.blockers.some((entry) => entry.includes("Missing explicit before/after")),
    );
    assert.ok(
      !missing.drafts.proofProposal.steps.some((step) => step.phase === "before"),
    );
    writeJson(root, "scenarios.json", {
      schemaVersion: "0.1",
      scenarios: [
        {
          id: "whitespace-reproduction",
          target: "greet",
          criterion: "Greets a trimmed name",
          beforeExitCode: 7,
          afterExitCode: 0,
        },
      ],
    });
    let packet = prepareTask(root, workFile, { scenariosPath: "scenarios.json" });
    assert.deepEqual(validatePlan(root, packet.drafts.proof), []);
    assert.equal(packet.drafts.proof.steps[0].expectExitCode, 7);
    assert.equal(packet.scenarios[0].id, "whitespace-reproduction");
    assert.ok(packet.inventory.some((entry) => entry.path === "scenarios.json"));
    task(root, { category: "refactor" });
    packet = prepareTask(root, workFile, { scenariosPath: "scenarios.json" });
    assert.equal(packet.drafts.proof, undefined);
    writeJson(root, "scenarios.json", {
      schemaVersion: "0.1",
      scenarios: [
        {
          id: "equivalent-greeting",
          target: "greet",
          criterion: "Greets a trimmed name",
          beforeExitCode: 0,
          afterExitCode: 0,
        },
      ],
    });
    assert.deepEqual(
      validatePlan(
        root,
        prepareTask(root, workFile, { scenariosPath: "scenarios.json" }).drafts.proof,
      ),
      [],
    );
    task(root, { category: "docs", risk: "R0" });
    packet = prepareTask(root, workFile);
    // The selected R1 runtime scope still requires behavior: preparation exposes that policy conflict.
    assert.equal(packet.drafts.proof, undefined);
    assert.ok(packet.blockers.some((entry) => entry.includes("runtime behavioral")));
    const map = readJson(root, "docs/features/greeting.json");
    map.risk = "R0";
    map.implementation = ["docs/adr/README.md"];
    map.entryPoints = ["docs/adr/README.md"];
    map.boundaries.push("knowledge");
    // A docs task can use its own explicitly mapped context and mechanical steps.
    const architecture = readJson(root, ".agent/policies/architecture.json");
    architecture.modules.push({
      id: "knowledge",
      path: "docs",
      allows: [],
      public: ["docs"],
    });
    writeJson(root, ".agent/policies/architecture.json", architecture);
    writeJson(root, "docs/features/greeting.json", map);
    task(root, { category: "docs", risk: "R0", context: ["docs/adr/README.md"] });
    packet = prepareTask(root, workFile);
    assert.deepEqual(packet.blockers, []);
    assert.ok(
      packet.drafts.proof.steps.some(
        (step) => step.phase === "mechanical" && step.criterion,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("risk floors and literal owned unusual targets survive preparation; inherited targets and missing commands block", () => {
  const root = makeFixture(3);
  try {
    task(root);
    const config = readJson(root, "arrs.json");
    config.verifyTargets["__proto__"] = undefined;
    Object.defineProperty(config.verifyTargets, "constructor", {
      value: { argv: ["sentinel-command", "literal ; $(no-shell)"], timeoutSeconds: 17 },
      enumerable: true,
      configurable: true,
    });
    writeJson(root, "arrs.json", config);
    task(root, { verificationTargets: ["greet", "constructor"] });
    let packet = prepareTask(root, workFile);
    assert.deepEqual(
      packet.requirements.commands.find((entry) => entry.target === "constructor"),
      {
        command: "verify",
        target: "constructor",
        argv: ["sentinel-command", "literal ; $(no-shell)"],
        timeoutSeconds: 17,
      },
    );
    const policy = readJson(root, ".agent/policies/risk.json");
    policy.sensitivePaths.push({
      path: "src/domain/greeting.mjs",
      risk: "R3",
      reason: "Sensitive fixture domain",
    });
    writeJson(root, ".agent/policies/risk.json", policy);
    linkSync(join(root, "src/domain/greeting.mjs"), join(root, "src/domain/alias.mjs"));
    task(root, { context: ["src/domain/alias.mjs"], risk: "R0" });
    packet = prepareTask(root, workFile);
    assert.equal(packet.requirements.risk, "R3");
    assert.equal(packet.requirements.independentReviewRequired, true);
    assert.equal(packet.drafts.work.state, "human-required");
    task(root, { risk: "R4" });
    assert.ok(prepareTask(root, workFile).blockers.some((entry) => entry.includes("R4")));
    delete config.verifyTargets.constructor;
    delete config.commands.test;
    writeJson(root, "arrs.json", config);
    task(root, { verificationTargets: ["greet", "constructor"] });
    packet = prepareTask(root, workFile);
    assert.ok(packet.blockers.some((entry) => /constructor/.test(entry)));
    assert.ok(packet.blockers.some((entry) => /test/.test(entry)));
    assert.equal(packet.drafts.proof, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI default is read-only with one JSON value; safe output preserves history and rejected flags/paths have no effects", () => {
  const root = makeFixture(3);
  try {
    task(root);
    const before = snapshot(root);
    const result = invoke(root, ["prepare", workFile]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).kind, "prepared-task");
    assert.deepEqual(snapshot(root), before);
    for (const flags of [
      ["--execute"],
      ["--dry-run"],
      ["--accepted"],
      ["--no-such-option"],
      ["--output", "../escape"],
      ["--output", ".arrs/../escape"],
      ["--output", "src/draft"],
    ]) {
      assert.equal(invoke(root, ["prepare", workFile, ...flags]).status, 1);
      assert.deepEqual(snapshot(root), before);
    }
    mkdirSync(join(root, ".arrs"), { recursive: true });
    symlinkSync(join(root, "src"), join(root, ".arrs/symlink"));
    assert.equal(
      invoke(root, ["prepare", workFile, "--output", ".arrs/symlink/draft"]).status,
      1,
    );
    rmSync(join(root, ".arrs/symlink"));
    writeFileSync(join(root, ".arrs/.gitignore"), "x".repeat(65537));
    const oversizedMarkerState = snapshot(root);
    const oversized = invoke(root, [
      "prepare",
      workFile,
      "--output",
      ".arrs/prepared/oversized",
    ]);
    assert.equal(oversized.status, 1);
    assert.match(JSON.parse(oversized.stdout).error, /at most 64 KiB/);
    assert.deepEqual(snapshot(root), oversizedMarkerState);
    assert.ok(!existsSync(join(root, ".arrs/prepared/oversized")));
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!.gitignore\n");
    const saved = invoke(root, [
      "prepare",
      workFile,
      "--output",
      ".arrs/prepared/greeting",
    ]);
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    for (const file of ["packet.json", "packet.md", "work.json", "proof-plan.json"])
      assert.ok(existsSync(join(root, ".arrs/prepared/greeting", file)));
    assert.equal(
      invoke(root, ["prepare", workFile, "--output", ".arrs/prepared/greeting"]).status,
      1,
    );
    assert.equal(
      invoke(root, [
        "prepare",
        workFile,
        "--compare",
        ".arrs/prepared/greeting/packet.json",
      ]).status,
      0,
    );
    task(root, { state: "ready-for-agent" });
    assert.match(
      JSON.parse(invoke(root, ["prepare", workFile]).stdout).error,
      /non-executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected preparation retains stronger baseline gates and refuses trust/command drift before output", () => {
  const { root, source, baseline, flags } = makePolicyTransitionFixture();
  try {
    task(root, {
      context: ["arrs.json"],
      authorization: {
        humanApproval:
          "Actual fixture permission for execution of governing control transition",
      },
    });
    const packet = prepareTask(root, workFile, { baseline });
    assert.equal(packet.requirements.risk, "R3");
    assert.equal(packet.requirements.autonomy, "human");
    assert.deepEqual(packet.requirements.policyBaseline, baseline);
    assert.equal(packet.status, "human-required");
    assert.ok(packet.drafts.proof);
    assert.deepEqual(validatePlan(root, packet.drafts.proof, baseline), []);
    assert.ok(!existsSync(join(root, "EXECUTED")));
    const before = snapshot(root);
    for (const supplied of [
      ["--baseline", baseline.root],
      [...flags, "--baseline", baseline.root],
      ["--baseline", baseline.root, "--baseline-sha256", "0".repeat(64)],
    ]) {
      assert.equal(
        invoke(root, [
          "prepare",
          workFile,
          ...supplied,
          "--output",
          ".arrs/prepared/rejected",
        ]).status,
        1,
      );
      assert.deepEqual(snapshot(root), before);
    }
    const config = readJson(root, "arrs.json");
    config.commands.check.argv.push("drift");
    writeJson(root, "arrs.json", config);
    assert.throws(
      () => prepareTask(root, workFile, { baseline }),
      /changes command binding/,
    );
    assert.equal(
      invoke(root, ["prepare", workFile, ...flags, "--output", ".arrs/prepared/rejected"])
        .status,
      1,
    );
    assert.ok(!existsSync(join(root, ".arrs/prepared/rejected")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("default CLI succeeds with process, filesystem-write and network traps active; sentinel commands remain untouched", () => {
  const root = makeFixture(3);
  try {
    task(root);
    const config = readJson(root, "arrs.json");
    writeFileSync(
      join(root, "sentinel.mjs"),
      "import {writeFileSync} from 'node:fs'; writeFileSync('EXECUTED','a configured command ran'); throw new Error('unexpected execution');\n",
    );
    for (const name of Object.keys(config.commands))
      config.commands[name] = { argv: [process.execPath, "sentinel.mjs"] };
    for (const name of Object.keys(config.verifyTargets))
      config.verifyTargets[name] = { argv: [process.execPath, "sentinel.mjs"] };
    writeJson(root, "arrs.json", config);
    writeFileSync(
      join(root, "traps.mjs"),
      "import child from 'node:child_process'; import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import {syncBuiltinESMExports} from 'node:module'; const trap=()=>{throw new Error('SIDE_EFFECT_TRAP');}; for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[name]=trap; for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync'])fs[name]=trap; http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=dns.lookup=trap; globalThis.fetch=trap; syncBuiltinESMExports();\n",
    );
    const before = snapshot(root);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "traps.mjs")).href,
        cli,
        "prepare",
        workFile,
        "--root",
        root,
        "--json",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).kind, "prepared-task");
    assert.deepEqual(snapshot(root), before);
    assert.ok(!existsSync(join(root, "EXECUTED")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency depth and count limits are deterministic blockers and cannot suppress mandatory gates", () => {
  for (const shape of ["deep", "wide"]) {
    const root = makeFixture(3);
    try {
      task(root);
      const base = readJson(root, "docs/features/greeting.json");
      const count = shape === "deep" ? 11 : 35;
      for (let i = 0; i < count; i++)
        writeJson(root, `docs/features/dep-${i}.json`, {
          ...base,
          id: `dep-${i}`,
          dependencies: shape === "deep" && i + 1 < count ? [`dep-${i + 1}`] : [],
        });
      base.dependencies =
        shape === "deep"
          ? ["dep-0"]
          : Array.from({ length: count }, (_, i) => `dep-${i}`);
      writeJson(root, "docs/features/greeting.json", base);
      const first = prepareTask(root, workFile);
      assert.deepEqual(first.blockers, prepareTask(root, workFile).blockers);
      assert.ok(
        first.blockers.some((entry) =>
          entry.includes(shape === "deep" ? "depth exceeds" : "count exceeds"),
        ),
      );
      assert.ok(first.requirements.requiredChecks.includes("check"));
      assert.equal(first.drafts.proof, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
