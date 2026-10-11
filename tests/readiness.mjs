import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assessReadiness } from "../dist/core/readiness.js";
import { checkArchitecture } from "../dist/core/architecture.js";
import { validateWorkItem } from "../dist/core/work.js";
import { validate } from "../dist/core/schema.js";
import {
  makeFixture,
  makePolicyTransitionFixture,
  writeJson,
  readJson,
  invoke,
  cli,
} from "./helpers.mjs";
const path = ".agent/work-items/readiness.json";
function work(root, overrides = {}) {
  const value = {
    schemaVersion: "0.1",
    id: "readiness-task",
    title: "Assess a bounded greeting change",
    state: "needs-triage",
    risk: "R1",
    category: "feature",
    featureIds: ["greeting"],
    acceptance: ["Greets a trimmed name"],
    context: ["src/domain", "src/application"],
    verificationTargets: ["greet"],
    dependencies: [],
    decisions: [],
    ...overrides,
  };
  writeJson(root, path, value);
  return value;
}
const dimension = (report, id) => report.dimensions.find((entry) => entry.id === id);
const snapshot = (root) =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [file, readFileSync(file).toString("base64")];
      }),
  );
const subject = { kind: "work", path };
function capture(root, risk = "R1", task = "readiness-task") {
  const plan = readJson(root, "proof-plan.json");
  plan.task = task;
  plan.risk = risk;
  if (risk >= "R2")
    plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
  if (risk >= "R3")
    plan.authorization = {
      humanApproval:
        "Actual test fixture permission for local proof execution, separate from implementation acceptance",
    };
  writeJson(root, "proof-plan.json", plan);
  const result = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).path;
}

test("feature readiness is sourced and task suitability stays unknown; R1 work eligibility matches shared admission without writes", async () => {
  const root = makeFixture(3);
  try {
    const item = work(root);
    const before = snapshot(root);
    const feature = await assessReadiness(root, { kind: "feature", id: "greeting" });
    assert.equal(feature.eligibility.readyForAgent, null);
    assert.equal(dimension(feature, "technical-evidence").status, "not-evaluated");
    assert.ok(
      dimension(feature, "feature-contracts").sources.some(
        (entry) => entry.path.endsWith("greeting.json") && entry.sha256,
      ),
    );
    const report = await assessReadiness(root, subject);
    assert.deepEqual(validate("readiness", report), []);
    assert.equal(
      report.eligibility.readyForAgent,
      validateWorkItem(root, { ...item, state: "ready-for-agent" }).length === 0,
    );
    assert.equal(report.eligibility.autonomous, true);
    assert.equal(report.scope.inventory.assurance, "declared-only");
    assert.equal(dimension(report, "hosted-ci").status, "not-evaluated");
    assert.equal(report.repository.contextualOnly, true);
    assert.deepEqual(report, await assessReadiness(root, subject));
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown feature, missing context/commands/inherited targets and unresolved decisions retain actionable blockers", async () => {
  const root = makeFixture(3);
  try {
    assert.match(
      dimension(
        await assessReadiness(root, { kind: "feature", id: "missing" }),
        "assessment",
      ).reason,
      /Unknown.*missing/,
    );
    for (const override of [
      { context: ["missing-source.mjs"] },
      { verificationTargets: ["greet", "constructor"] },
      { dependencies: ["upstream release"] },
      { decisions: ["retention policy"] },
    ]) {
      work(root, override);
      const report = await assessReadiness(root, subject);
      assert.equal(report.eligibility.readyForAgent, false);
      assert.ok(
        report.dimensions.some(
          (entry) =>
            ["blocked", "incomplete"].includes(entry.status) &&
            /missing|constructor|upstream release|retention policy/i.test(entry.reason),
        ),
      );
    }
    const config = readJson(root, "arrs.json");
    Object.defineProperty(config.verifyTargets, "constructor", {
      value: { argv: ["sentinel", "literal ; $(none)"], timeoutSeconds: 19 },
      enumerable: true,
    });
    writeJson(root, "arrs.json", config);
    work(root, { verificationTargets: ["greet", "constructor"] });
    let report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForAgent, true);
    assert.deepEqual(
      report.requirements.commands.find((entry) => entry.target === "constructor").argv,
      ["sentinel", "literal ; $(none)"],
    );
    delete config.commands.test;
    writeJson(root, "arrs.json", config);
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(dimension(report, "verification-configuration").status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sensitive source raises effective risk, R3 retains human authorization and R4 never recommends autonomous execution", async () => {
  const root = makeFixture(3);
  try {
    const policy = readJson(root, ".agent/policies/risk.json");
    policy.sensitivePaths.push({
      path: "src/domain/greeting.mjs",
      risk: "R3",
      reason: "Sensitive data-bearing greeting fixture",
    });
    writeJson(root, ".agent/policies/risk.json", policy);
    work(root);
    let report = await assessReadiness(root, subject);
    assert.equal(report.requirements.risk, "R3");
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(dimension(report, "risk").status, "blocked");
    work(root, { risk: "R3" });
    report = await assessReadiness(root, subject);
    assert.equal(dimension(report, "execution-authorization").status, "blocked");
    work(root, {
      risk: "R3",
      authorization: {
        humanApproval:
          "Existing test fixture permission for human-controlled execution only",
      },
    });
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.humanControlledExecution, true);
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(report.eligibility.autonomous, false);
    assert.equal(report.requirements.independentReviewRequired, true);
    work(root, {
      risk: "R4",
      authorization: {
        humanApproval:
          "Existing test fixture permission for human-required R4 process only",
      },
    });
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(report.eligibility.humanControlledExecution, false);
    assert.ok(
      report.nextActions.some((entry) => entry.includes("R4 remains human-required")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only exact selected task/category/risk/criterion/target evidence permits review and current bound acceptance permits completion", async () => {
  const root = makeFixture(3);
  try {
    const unrelated = capture(root, "R1", "another-task");
    work(root, { proof: unrelated });
    let report = await assessReadiness(root, subject);
    assert.equal(report.selectedProof.technical.valid, true);
    assert.equal(report.eligibility.readyForReview, false);
    assert.match(dimension(report, "technical-evidence").reason, /mismatch/);
    const proof = capture(root, "R3");
    const item = work(root, {
      proof,
      risk: "R3",
      authorization: {
        humanApproval:
          "Fixture execution permission, never manufactured implementation acceptance",
      },
    });
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForReview, true);
    assert.equal(report.eligibility.completed, false);
    assert.equal(report.selectedProof.review.status, "ready-for-review");
    assert.deepEqual(
      report.admission.readyForReview,
      validateWorkItem(root, { ...item, state: "ready-for-review" }),
    );
    writeJson(root, ".agent/test-review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent:
        "Test fixture independent review record of this exact implementation attempt",
      humanApproval:
        "Test fixture actual bound human acceptance assertion for this exact attempt",
    });
    assert.equal(
      invoke(root, ["proof", "review", proof, ".agent/test-review.json"]).status,
      0,
    );
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.completed, true);
    assert.ok(
      dimension(report, "implementation-acceptance").sources.some(
        (entry) => entry.path.includes("review-") && entry.sha256,
      ),
    );
    const manifest = readJson(root, proof);
    const log = manifest.results[0].log;
    writeFileSync(join(root, log), "tampered log");
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForReview, false);
    assert.equal(report.eligibility.completed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source and command drift invalidate task proof while unrelated repository failure stays contextual", async () => {
  const root = makeFixture(3);
  try {
    const proof = capture(root);
    work(root, { proof });
    const map = readJson(root, "docs/features/greeting.json");
    writeJson(root, "docs/features/unrelated.json", {
      ...map,
      id: "unrelated",
      implementation: ["src/domain/greeting.mjs"],
      verification: { target: "unrelated" },
    });
    const config = readJson(root, "arrs.json");
    config.verifyTargets.unrelated = {
      argv: [process.execPath, "-e", "process.exit(7)"],
    };
    writeJson(root, "arrs.json", config);
    let report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForReview, true);
    assert.ok(!report.requirements.verificationTargets.includes("unrelated"));
    const original = readFileSync(join(root, "src/domain/greeting.mjs"));
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = value => value;\n",
    );
    report = await assessReadiness(root, subject);
    assert.equal(report.eligibility.readyForReview, false);
    writeFileSync(join(root, "src/domain/greeting.mjs"), original);
    config.verifyTargets.greet.argv.push("command-drift");
    writeJson(root, "arrs.json", config);
    assert.equal(
      (await assessReadiness(root, subject)).eligibility.readyForReview,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Git base retains rename/deletion endpoints and blocks out-of-scope sensitive changes", async () => {
  const root = makeFixture(3);
  try {
    work(root);
    writeFileSync(
      join(root, "src/domain/obsolete.mjs"),
      "export const obsolete = true;\n",
    );
    const policy = readJson(root, ".agent/policies/risk.json");
    policy.sensitivePaths.push({
      path: "src/auth",
      risk: "R3",
      reason: "Authentication source must retain human-controlled execution",
    });
    writeJson(root, ".agent/policies/risk.json", policy);
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--quiet"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "baseline",
    ]);
    const base = git(["rev-parse", "HEAD"]);
    renameSync(
      join(root, "src/domain/obsolete.mjs"),
      join(root, "src/domain/replaced.mjs"),
    );
    git(["add", "src/domain"]);
    let report = await assessReadiness(root, subject, { base });
    assert.equal(report.scope.inventory.assurance, "git-complete");
    assert.ok(
      report.scope.inventory.endpoints.some(
        (entry) =>
          entry.path === "src/domain/obsolete.mjs" && entry.before && !entry.after,
      ),
    );
    assert.ok(
      report.scope.inventory.endpoints.some(
        (entry) =>
          entry.path === "src/domain/replaced.mjs" && !entry.before && entry.after,
      ),
    );
    assert.equal(report.scope.passed, true);
    mkdirSync(join(root, "src/auth"), { recursive: true });
    writeFileSync(join(root, "src/auth/new.mjs"), "export const authorized = true;\n");
    report = await assessReadiness(root, subject, { base });
    assert.equal(report.eligibility.readyForAgent, false);
    assert.ok(report.scope.uncovered.includes("src/auth/new.mjs"));
    assert.equal(report.requirements.risk, "R3");
    assert.ok(report.requirements.requiredChecks.includes("verify"));
    assert.ok(
      report.requirements.commands.some(
        (entry) => entry.command === "verify" && entry.target === undefined,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected requirements and static/hosted CI remain separate and baseline drift blocks sourced advice without writes", async () => {
  const { root, source: baselineRoot, baseline, flags } = makePolicyTransitionFixture();
  try {
    work(root, {
      risk: "R3",
      context: ["arrs.json", "src/domain", "src/application"],
      authorization: {
        humanApproval:
          "Fixture permission for human-controlled protected transition execution",
      },
    });
    let report = await assessReadiness(root, subject, { baseline });
    assert.equal(report.requirements.risk, "R3");
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(report.eligibility.humanControlledExecution, true);
    assert.match(report.admission.readyForAgent.join("; "), /human autonomy/);
    assert.equal(dimension(report, "hosted-ci").status, "not-evaluated");
    assert.equal(
      invoke(root, ["readiness", "work", path, "--baseline", baseline.root]).status,
      1,
    );
    const before = snapshot(root);
    const invalid = await assessReadiness(root, subject, {
      baseline: { ...baseline, sha256: "0".repeat(64) },
    });
    assert.equal(invalid.eligibility.readyForAgent, false);
    assert.equal(dimension(invalid, "assessment").status, "blocked");
    assert.deepEqual(snapshot(root), before);
    assert.ok(!existsSync(join(root, "EXECUTED")));
    assert.equal(
      invoke(root, ["readiness", "work", path, ...flags, "--execute"]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(baselineRoot, { recursive: true, force: true });
  }
});

test("readiness CLI default survives configured-command, process/write/network traps and rejects action flags before effects", () => {
  const root = makeFixture(3);
  try {
    work(root);
    const config = readJson(root, "arrs.json");
    writeFileSync(
      join(root, "sentinel.mjs"),
      "throw new Error('CONFIGURED_COMMAND_EXECUTED');\n",
    );
    for (const name of Object.keys(config.commands))
      config.commands[name] = { argv: [process.execPath, "sentinel.mjs"] };
    for (const name of Object.keys(config.verifyTargets))
      config.verifyTargets[name] = { argv: [process.execPath, "sentinel.mjs"] };
    writeJson(root, "arrs.json", config);
    writeFileSync(
      join(root, "traps.mjs"),
      "import child from 'node:child_process'; import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module'; const trap=()=>{throw new Error('SIDE_EFFECT_TRAP');}; for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[name]=trap; for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync'])fs[name]=trap; http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=trap; globalThis.fetch=trap; syncBuiltinESMExports();\n",
    );
    const before = snapshot(root);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "traps.mjs")).href,
        cli,
        "readiness",
        "work",
        path,
        "--root",
        root,
        "--json",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.kind, "readiness");
    assert.equal(report.eligibility.readyForAgent, true);
    assert.ok(!JSON.stringify(report).includes("SIDE_EFFECT_TRAP"));
    assert.deepEqual(snapshot(root), before);
    for (const flags of [
      ["--execute"],
      ["--dry-run"],
      ["--to", "completed"],
      ["--output", ".arrs/written"],
      ["--no-such-flag"],
      ["--base", "HEAD", "--base", "HEAD"],
    ]) {
      assert.equal(invoke(root, ["readiness", "work", path, ...flags]).status, 1);
      assert.deepEqual(snapshot(root), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized contracts and selected proof reject before a trapped body read or contextual fallback", () => {
  const root = makeFixture(3);
  try {
    work(root);
    const config = readFileSync(join(root, "arrs.json"));
    const proof = ".arrs/evidence/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/proof.json";
    mkdirSync(join(root, ".arrs/evidence/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"), {
      recursive: true,
    });
    const traps = join(root, "read-bounds.mjs");
    for (const oversized of ["arrs.json", proof]) {
      writeFileSync(join(root, "arrs.json"), config);
      work(root, oversized === proof ? { proof } : {});
      writeFileSync(join(root, oversized), " ".repeat(1024 * 1024 + 1));
      writeFileSync(
        traps,
        `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const read=fs.readFileSync; fs.readFileSync=function(path,...args){if(String(path)===${JSON.stringify(join(root, oversized))})throw new Error('OVERSIZED_BODY_READ');return read.call(this,path,...args);}; syncBuiltinESMExports();\n`,
      );
      const before = snapshot(root);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(traps).href,
          cli,
          "readiness",
          "work",
          path,
          "--root",
          root,
          "--json",
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      const report = JSON.parse(result.stdout);
      assert.equal(report.eligibility.readyForReview, false);
      assert.match(JSON.stringify(report), /1 MiB|read limit/);
      assert.ok(!JSON.stringify(report).includes("OVERSIZED_BODY_READ"));
      assert.deepEqual(snapshot(root), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-risk explicit Git scope preserves removed historical targets for both work execution and selected proof", async () => {
  const root = makeFixture(3);
  try {
    const git = (...args) => {
      const result = spawnSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD");
    const config = readJson(root, "arrs.json");
    config.verifyTargets.newGreeting = config.verifyTargets.greet;
    writeJson(root, "arrs.json", config);
    const map = readJson(root, "docs/features/greeting.json");
    map.verification.target = "newGreeting";
    writeJson(root, "docs/features/greeting.json", map);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") + "// changed source\n",
    );
    git("add", ".");
    git("commit", "-qm", "change mapped target at same risk");
    const scope = [
      "src/domain",
      "src/application",
      "arrs.json",
      "docs/features/greeting.json",
    ];
    const plan = readJson(root, "proof-plan.json");
    Object.assign(plan, {
      task: "historical-readiness",
      risk: "R3",
      scope,
      authorization: {
        humanApproval: "Actual fixture execution permission for historical target proof",
      },
    });
    plan.steps[3].target = "newGreeting";
    plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
    const input = ".arrs/historical-plan.json",
      file = ".arrs/historical-work.json";
    const run = () => {
      writeJson(root, input, plan);
      const result = invoke(root, ["proof", "run", input, "--execute"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout).path;
    };
    const item = {
      ...work(root),
      id: plan.task,
      risk: "R3",
      context: scope,
      verificationTargets: ["newGreeting"],
      authorization: plan.authorization,
      proof: run(),
    };
    rmSync(join(root, path));
    writeJson(root, file, item);
    let report = await assessReadiness(root, { kind: "work", path: file }, { base });
    assert.deepEqual(report.requirements.verificationTargets, ["greet", "newGreeting"]);
    assert.equal(report.scope.passed, true);
    assert.equal(report.selectedProof.technical.valid, true);
    assert.deepEqual(report.admission.readyForReview, []);
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(report.eligibility.humanControlledExecution, false);
    assert.equal(report.eligibility.readyForReview, false);
    assert.match(dimension(report, "scope-verification").reason, /omits.*greet/);
    item.verificationTargets.push("greet");
    writeJson(root, file, item);
    report = await assessReadiness(root, { kind: "work", path: file }, { base });
    assert.equal(report.eligibility.readyForReview, false);
    assert.match(dimension(report, "technical-evidence").reason, /exact bound.*greet/);
    plan.steps.push({
      phase: "behavior",
      command: "verify",
      target: "greet",
      expectExitCode: 0,
    });
    item.proof = run();
    writeJson(root, file, item);
    report = await assessReadiness(root, { kind: "work", path: file }, { base });
    assert.equal(
      report.eligibility.readyForReview,
      true,
      JSON.stringify(report.dimensions),
    );
    assert.equal(report.eligibility.humanControlledExecution, true);
    assert.equal(report.eligibility.readyForAgent, false);
    assert.equal(report.eligibility.autonomous, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness retains Python adapter coverage as unobserved without invoking its configured interpreter", async (t) => {
  const root = makeFixture(3);
  const nativeSpawn = childProcess.spawnSync;
  let mocked;
  let runtimeAttempts = 0;
  try {
    work(root);
    rmSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src/domain"), { recursive: true });
    mkdirSync(join(root, "src/application"), { recursive: true });
    writeFileSync(join(root, "src/domain/__init__.py"), "");
    writeFileSync(join(root, "src/application/__init__.py"), "");
    writeFileSync(
      join(root, "src/domain/api.py"),
      "def greeting(name):\n    return name.strip()\n",
    );
    writeFileSync(
      join(root, "src/application/main.py"),
      "from domain.api import greeting\n",
    );
    const policy = {
      schemaVersion: "0.1",
      modules: [
        { id: "domain", path: "src/domain", allows: [], public: ["src/domain/api.py"] },
        {
          id: "application",
          path: "src/application",
          allows: ["domain"],
          public: ["src/application/main.py"],
        },
      ],
    };
    policy.adapter = {
      id: "python",
      version: "candidate-python-ast-0.1",
      packageRoots: ["src"],
      runtime: { argv: [join(root, "configured-parser")], timeoutSeconds: 5 },
    };
    writeJson(root, ".agent/policies/architecture.json", policy);
    const runtimeCommand = policy.adapter.runtime.argv[0];
    const response = join(root, ".arrs/configured-parser-response.mjs");
    const sentinel = join(root, "PARSER_EXECUTED");
    writeFileSync(
      response,
      `import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';assert.deepEqual(process.argv.slice(2,5),['-I','-S','-c']);assert.match(process.argv[5],/import ast, json, sys/);writeFileSync(${JSON.stringify(sentinel)},'actual native parser execution');process.exit(37);\n`,
    );
    mocked = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command === runtimeCommand) {
        // Record every attempted invocation, including unexpected runtime probes.
        runtimeAttempts++;
        assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
        assert.equal(args.length, 4);
        assert.ok(options.shell === undefined || options.shell === false);
        return nativeSpawn(process.execPath, [response, ...args], options);
      }
      return nativeSpawn(command, args, options);
    });
    syncBuiltinESMExports();
    const map = readJson(root, "docs/features/greeting.json");
    map.entryPoints = ["src/application/main.py"];
    writeJson(root, "docs/features/greeting.json", map);
    const before = snapshot(root);
    const report = await assessReadiness(root, subject);
    assert.equal(report.repository.architecture.adapter, "python");
    assert.equal(report.repository.architecture.scannedFileCount, 0);
    assert.equal(dimension(report, "architecture-coverage").status, "not-evaluated");
    assert.match(
      dimension(report, "architecture-coverage").reason,
      /external adapter runtime/,
    );
    assert.equal(runtimeAttempts, 0);
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(validate("readiness", report), []);
    // The control actually launches the configured fixture through native Node.
    assert.match(checkArchitecture(root).join("\n"), /parser failed.*exit 37/);
    assert.ok(runtimeAttempts > 0);
    assert.equal(readFileSync(sentinel, "utf8"), "actual native parser execution");
  } finally {
    mocked?.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
