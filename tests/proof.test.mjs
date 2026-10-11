import { spawnSync } from "node:child_process";
import "./proof-explanation.mjs";
import "./receipt-conformance.mjs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  makeFixture,
  invoke,
  readJson,
  writeJson,
  cli,
  makePolicyTransitionFixture,
} from "./helpers.mjs";
import { finishProof, validateProof } from "../dist/workflows/proof.js";
import {
  policyRequirements,
  inspectPolicyBaseline,
} from "../dist/core/policy-baseline.js";
import { validatePlan } from "../dist/core/evidence.js";
import { hashScope } from "../dist/core/files.js";

function startLifecycle(root, category = "bug") {
  const plan = readJson(root, "proof-plan.json");
  plan.category = category;
  plan.steps.unshift({
    phase: "before",
    command: "verify",
    target: "greet",
    expectExitCode: category === "bug" ? 1 : 0,
  });
  plan.steps.at(-1).phase = "after";
  writeJson(root, "proof-plan.json", plan);
  if (category === "bug")
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = (name) => `Hello, ${name}!`;\n",
    );
  const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
  assert.equal(start.status, 0, start.stdout + start.stderr);
  return JSON.parse(start.stdout).session;
}

function snapshotDirectory(root, path) {
  return Object.fromEntries(
    readdirSync(join(root, path)).map((file) => [
      file,
      readFileSync(join(root, path, file), "utf8"),
    ]),
  );
}

function snapshotFixtureTree(root) {
  const entries = [];
  function visit(path = "") {
    for (const name of readdirSync(join(root, path)).sort()) {
      const file = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(root, file));
      if (stat.isDirectory()) {
        entries.push(["directory", file]);
        visit(file);
      } else {
        assert.ok(stat.isFile(), `Unexpected fixture entry ${file}`);
        entries.push(["file", file, readFileSync(join(root, file))]);
      }
    }
  }
  visit();
  return entries;
}

function prepareReservedProofRoots(root) {
  const initialized = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const directory of [".arrs", ".git", "node_modules"]) {
    mkdirSync(join(root, directory, "cache"), { recursive: true });
    writeFileSync(join(root, directory, "cache/state.json"), "{}\n");
  }
}

function prepareReservedCaseScopes(root) {
  const cases = [];
  for (const [reserved, spellings] of [
    [".git", [".GIT", ".GiT", ".gıt", ".GıT"]],
    [".arrs", [".ARRS", ".ArRs", ".arrſ", ".ARRſ"]],
    ["node_modules", ["NODE_MODULES", "Node_Modules", "node_moduleſ", "NODE_MODULEſ"]],
  ]) {
    const reservedStat = lstatSync(join(root, reserved), { bigint: true });
    assert.ok(reservedStat.isDirectory(), reserved);
    for (const spelling of spellings) {
      let aliasesReserved = false;
      try {
        const candidate = lstatSync(join(root, spelling), { bigint: true });
        assert.ok(candidate.isDirectory(), spelling);
        aliasesReserved =
          candidate.dev === reservedStat.dev && candidate.ino === reservedStat.ino;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // On a case-sensitive filesystem these are separate, legitimate source roots.
      if (!aliasesReserved) {
        mkdirSync(join(root, spelling, "cache"), { recursive: true });
        writeFileSync(join(root, spelling, "cache/state.json"), '{"source":1}\n');
      }
      cases.push({
        reserved,
        spelling,
        aliasesReserved,
        scopes: [
          spelling,
          `./${spelling}//`,
          `${spelling}//cache`,
          `${spelling}/./cache/state.json`,
        ],
      });
    }
  }
  return cases;
}

function markConfiguredProofCommands(root) {
  const config = readJson(root, "arrs.json");
  const wrapper =
    "require('node:fs').writeFileSync('.arrs/COMMAND-EXECUTED','yes');" +
    "const argv=JSON.parse(process.argv[1]);" +
    "const result=require('node:child_process').spawnSync(argv[0],argv.slice(1),{stdio:'inherit'});" +
    "if(result.error)throw result.error;process.exit(result.status??1)";
  // The marker wraps the real configured gates rather than substituting a no-op.
  for (const command of [config.commands.check, config.verifyTargets.greet]) {
    command.argv = [process.execPath, "-e", wrapper, JSON.stringify(command.argv)];
  }
  writeJson(root, "arrs.json", config);
}

const prohibitedScopeAliases = [
  "./",
  "./.",
  ".//",
  "./.arrs/",
  ".arrs//cache",
  ".arrs/./cache/state.json",
  "./.git/",
  ".git//cache",
  ".git/./cache/state.json",
  "./node_modules/",
  "node_modules//cache",
  "node_modules/./cache/state.json",
];

for (const action of ["run", "start"]) {
  test(`proof ${action} rejects normalized root/output scope aliases before effects`, () => {
    const root = makeFixture();
    try {
      prepareReservedProofRoots(root);
      const caseScopes = prepareReservedCaseScopes(root);
      markConfiguredProofCommands(root);
      const plan = readJson(root, "proof-plan.json");
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
      for (const scope of [
        ...prohibitedScopeAliases,
        ...caseScopes
          .filter((entry) => entry.aliasesReserved)
          .flatMap((entry) => entry.scopes),
      ]) {
        plan.scope = [scope];
        writeJson(root, "proof-plan.json", plan);
        const before = snapshotFixtureTree(root);
        const result = invoke(root, ["proof", action, "proof-plan.json", "--execute"]);
        assert.equal(result.status, 1, `${scope}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /Proof scope must refer to source paths/, scope);
        assert.deepEqual(snapshotFixtureTree(root), before, scope);
        assert.equal(existsSync(join(root, ".arrs/COMMAND-EXECUTED")), false, scope);
        assert.equal(existsSync(join(root, ".arrs/evidence")), false, scope);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("proof finish rejects legacy alias sessions before commands or attempt allocation", () => {
  const root = makeFixture();
  try {
    prepareReservedProofRoots(root);
    const caseScopes = prepareReservedCaseScopes(root);
    markConfiguredProofCommands(root);
    const path = startLifecycle(root, "refactor");
    const original = readFileSync(join(root, path));
    const session = readJson(root, path);
    const baseline = snapshotDirectory(root, path.slice(0, path.lastIndexOf("/")));
    rmSync(join(root, ".arrs/COMMAND-EXECUTED"));
    for (const scope of [
      ...prohibitedScopeAliases,
      ...caseScopes
        .filter((entry) => entry.aliasesReserved)
        .flatMap((entry) => entry.scopes),
    ]) {
      const legacy = structuredClone(session);
      legacy.plan.scope = [scope];
      const { digest: _digest, ...content } = legacy;
      // A local digest is not authentication: an older CLI could capture this plan.
      legacy.digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      writeJson(root, path, legacy);
      const before = snapshotFixtureTree(root);
      const result = invoke(root, ["proof", "finish", path, "--execute"]);
      assert.equal(result.status, 1, `${scope}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Proof scope must refer to source paths/, scope);
      assert.deepEqual(snapshotFixtureTree(root), before, scope);
      assert.equal(existsSync(join(root, ".arrs/COMMAND-EXECUTED")), false, scope);
    }
    writeFileSync(join(root, path), original);
    const finish = invoke(root, ["proof", "finish", path, "--execute"]);
    assert.equal(finish.status, 0, finish.stdout + finish.stderr);
    assert.deepEqual(
      snapshotDirectory(root, path.slice(0, path.lastIndexOf("/"))),
      baseline,
    );
    assert.deepEqual(validateProof(root, JSON.parse(finish.stdout).manifest), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truthful legacy output-only proof fails technical, accepted and review admission", () => {
  const root = makeFixture();
  try {
    prepareReservedProofRoots(root);
    const caseScopes = prepareReservedCaseScopes(root);
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture reviewer examined actual greeting behavior and logs",
    });
    const capture = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(capture.status, 0, capture.stdout + capture.stderr);
    const { path, manifest } = JSON.parse(capture.stdout);
    const original = readFileSync(join(root, path));
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
    for (const scope of [
      "./.arrs/",
      ".git/./",
      "node_modules//",
      ...caseScopes
        .filter((entry) => entry.aliasesReserved && entry.reserved !== ".arrs")
        .flatMap((entry) => entry.scopes),
    ]) {
      const scopeHash = hashScope(root, scope);
      if (["./.arrs/", ".git/./", "node_modules//"].includes(scope))
        assert.equal(scopeHash, createHash("sha256").digest("hex"));
      // Model a historical capture: only scope and its truthful current hash change;
      // every recorded argv, command result and log retains real captured evidence.
      writeJson(root, path, {
        ...manifest,
        scope: [scope],
        scopeHashes: { [scope]: scopeHash },
      });
      const before = snapshotFixtureTree(root);
      for (const args of [
        ["proof", "validate", path],
        ["proof", "validate", path, "--accepted"],
        ["proof", "review", path, "review.json"],
      ]) {
        const result = invoke(root, args);
        assert.equal(result.status, 1, `${scope}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /Proof scope must refer to source paths/, scope);
        assert.deepEqual(snapshotFixtureTree(root), before, scope);
      }
    }
    writeFileSync(join(root, path), original);
    const retained = invoke(root, ["proof", "validate", path, "--accepted"]);
    assert.equal(retained.status, 0, retained.stdout + retained.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinct case spellings of reserved roots remain valid and freshness-bound", () => {
  const root = makeFixture();
  try {
    prepareReservedProofRoots(root);
    const cases = prepareReservedCaseScopes(root);
    const distinct = cases.filter((entry) => !entry.aliasesReserved);
    const plan = readJson(root, "proof-plan.json");
    plan.scope.push(...distinct.flatMap((entry) => entry.scopes));
    writeJson(root, "proof-plan.json", plan);
    const capture = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(capture.status, 0, capture.stdout + capture.stderr);
    const { path, manifest } = JSON.parse(capture.stdout);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
    for (const { spelling } of distinct) {
      const source = join(root, spelling, "cache/state.json");
      const original = readFileSync(source);
      writeFileSync(source, '{"source":2}\n');
      assert.match(validateProof(root, manifest).join(";"), /scope changed/, spelling);
      writeFileSync(source, original);
      assert.deepEqual(validateProof(root, manifest), [], spelling);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalized source aliases and nested reserved names remain valid and hashed", () => {
  const root = makeFixture();
  try {
    const directories = [
      "src/domain/.arrs",
      "src/domain/.git",
      "src/domain/node_modules",
      ".arrs-cache",
      ".git-cache",
      "node_modules-backup",
    ];
    for (const directory of directories) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, "source.mjs"), "export const value = 1;\n");
    }
    const plan = readJson(root, "proof-plan.json");
    plan.scope = [
      "./src/domain/",
      "src/./application",
      "src/domain/./.arrs/",
      "src/domain//.git",
      "./src/domain/node_modules",
      "./.arrs-cache/",
      ".git-cache/.",
      "node_modules-backup//",
    ];
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const { path, manifest } = JSON.parse(run.stdout);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
    for (const directory of directories) {
      const file = join(root, directory, "source.mjs");
      writeFileSync(file, "export const value = 2;\n");
      assert.match(validateProof(root, manifest).join(";"), /scope changed/, directory);
      writeFileSync(file, "export const value = 1;\n");
      assert.deepEqual(validateProof(root, manifest), [], directory);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const category of ["bug", "refactor"]) {
  test(`${category} retries preserve original baseline and immutable failed attempts`, () => {
    const root = makeFixture();
    try {
      const session = startLifecycle(root, category);
      const original = readFileSync(join(root, session), "utf8");
      const saved = readJson(root, session);
      const baseline = readFileSync(join(root, saved.results[0].log));
      if (category === "refactor")
        writeFileSync(
          join(root, "src/domain/greeting.mjs"),
          "export const greeting = () => 'WRONG';\n",
        );
      const failed = invoke(root, ["proof", "finish", session, "--execute"]);
      assert.equal(failed.status, 1);
      const first = JSON.parse(failed.stdout);
      assert.equal(first.manifest.status, "failed");
      const firstDirectory = first.path.slice(0, first.path.lastIndexOf("/"));
      const failedBytes = snapshotDirectory(root, firstDirectory);
      writeFileSync(
        join(root, "src/domain/greeting.mjs"),
        "export const greeting = (name) => `Hello, ${name.trim()}!`;\n",
      );
      const retry = invoke(root, ["proof", "finish", session, "--execute"]);
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      const second = JSON.parse(retry.stdout);
      assert.notEqual(second.manifest.id, first.manifest.id);
      assert.notEqual(second.manifest.id, saved.id);
      assert.deepEqual(validateProof(root, second.manifest), []);
      assert.equal(second.manifest.results[0].sha256, saved.results[0].sha256);
      assert.deepEqual(
        readFileSync(join(root, second.manifest.results[0].log)),
        baseline,
      );
      const attempt = readJson(root, `.arrs/evidence/${second.manifest.id}/attempt.json`);
      assert.equal(attempt.session, session);
      assert.equal(attempt.sessionDigest, saved.digest);
      assert.equal(attempt.createdAt, second.manifest.createdAt);
      assert.ok(Date.parse(second.manifest.createdAt) >= Date.parse(saved.createdAt));
      assert.equal(attempt.baseline[0].source, saved.results[0].log);
      assert.equal(attempt.baseline[0].copy, second.manifest.results[0].log);
      const repeated = invoke(root, ["proof", "finish", session, "--execute"]);
      assert.equal(repeated.status, 0, repeated.stdout);
      assert.notEqual(JSON.parse(repeated.stdout).path, second.path);
      assert.equal(readFileSync(join(root, session), "utf8"), original);
      assert.deepEqual(readFileSync(join(root, saved.results[0].log)), baseline);
      assert.deepEqual(snapshotDirectory(root, firstDirectory), failedBytes);
      writeFileSync(join(root, second.manifest.results[0].log), "{}");
      assert.match(validateProof(root, second.manifest).join(";"), /hash|substantiate/);
      writeFileSync(join(root, saved.results[0].log), "{}");
      assert.equal(invoke(root, ["proof", "finish", session, "--execute"]).status, 1);
      assert.deepEqual(validateProof(root, JSON.parse(repeated.stdout).manifest), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("finish reserves unique attempt before commands and refuses a collision without side effects", async (t) => {
  const crypto = (await import("node:crypto")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.check = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    const session = startLifecycle(root);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = (name) => `Hello, ${name.trim()}!`;\n",
    );
    const id = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(root, `.arrs/evidence/${id}`));
    writeFileSync(join(root, `.arrs/evidence/${id}/sentinel`), "retained");
    t.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();
    await assert.rejects(finishProof(root, session, true), /EEXIST/);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.equal(
      readFileSync(join(root, `.arrs/evidence/${id}/sentinel`), "utf8"),
      "retained",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed baseline argv is rejected before retry commands execute", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.check = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    const session = startLifecycle(root);
    config.verifyTargets.greet = {
      argv: [process.execPath, "-e", "console.log('changed scenario')"],
    };
    writeJson(root, "arrs.json", config);
    const finish = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(finish.status, 1);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.match(finish.stdout, /argv|scenario|configured command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "interrupted finish retains its allocated attempt and a retry uses another directory",
  { skip: process.platform === "win32" },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { cli } = await import("./helpers.mjs");
    const root = makeFixture();
    let running;
    try {
      const config = readJson(root, "arrs.json");
      config.commands.check = {
        argv: [
          process.execPath,
          "-e",
          "const fs=require('node:fs');fs.writeFileSync('CHECK-RAN',String(process.pid));const deadline=setTimeout(()=>process.exit(71),5000);const timer=setInterval(()=>{if(fs.existsSync('.arrs/allow-check')){clearInterval(timer);clearTimeout(deadline)}},20)",
        ],
      };
      writeJson(root, "arrs.json", config);
      const session = startLifecycle(root, "refactor");
      running = spawn(
        process.execPath,
        [cli, "proof", "finish", session, "--execute", "--root", root],
        { stdio: "ignore" },
      );
      const exited = once(running, "exit", { signal: AbortSignal.timeout(10000) });
      for (let n = 0; n < 400 && !existsSync(join(root, "CHECK-RAN")); n++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(existsSync(join(root, "CHECK-RAN")), true);
      const attempts = readdirSync(join(root, ".arrs/evidence")).filter((id) =>
        existsSync(join(root, `.arrs/evidence/${id}/attempt.json`)),
      );
      assert.equal(attempts.length, 1);
      running.kill("SIGTERM");
      assert.equal((await exited)[0], 143);
      const interruptedPath = `.arrs/evidence/${attempts[0]}`;
      const retained = snapshotDirectory(root, interruptedPath);
      assert.equal(existsSync(join(root, `${interruptedPath}/proof.json`)), false);
      writeFileSync(join(root, ".arrs/allow-check"), "yes");
      const retry = invoke(root, ["proof", "finish", session, "--execute"]);
      assert.equal(retry.status, 0, retry.stdout);
      assert.notEqual(JSON.parse(retry.stdout).manifest.id, attempts[0]);
      assert.deepEqual(snapshotDirectory(root, interruptedPath), retained);
    } finally {
      running?.kill("SIGKILL");
      if (existsSync(join(root, "CHECK-RAN"))) {
        const pid = Number(readFileSync(join(root, "CHECK-RAN"), "utf8"));
        if (pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("passed proofs become stale when declared reserved-name or generated source changes", () => {
  const root = makeFixture();
  try {
    const directories = [
      "build",
      "vendor",
      "dist",
      ".git",
      ".arrs",
      "node_modules",
      "generated",
    ];
    for (const name of directories) {
      mkdirSync(join(root, `src/domain/${name}`));
      writeFileSync(
        join(root, `src/domain/${name}/source.mjs`),
        "export const value = 1;\n",
      );
    }
    const policy = readJson(root, ".agent/policies/architecture.json");
    policy.modules.push({
      id: "generated",
      path: "src/domain/generated",
      allows: [],
      public: ["src/domain/generated/source.mjs"],
      generated: true,
    });
    writeJson(root, ".agent/policies/architecture.json", policy);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(validateProof(root, result.manifest), []);
    for (const name of directories) {
      const file = join(root, `src/domain/${name}/source.mjs`);
      writeFileSync(file, "export const value = 2;\n");
      assert.match(validateProof(root, result.manifest).join(";"), /scope changed/, name);
      writeFileSync(file, "export const value = 1;\n");
      assert.deepEqual(validateProof(root, result.manifest), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excluded root dependency symlinks preserve retained proof and allow recapture", () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.scope = ["src/domain"];
    writeJson(root, "proof-plan.json", plan);
    const capture = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(capture.status, 0, capture.stdout + capture.stderr);
    const original = JSON.parse(capture.stdout);
    const initial = invoke(root, ["proof", "validate", original.path]);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    assert.equal(JSON.parse(initial.stdout).valid, true);
    const dependencies = join(root, "shared-dependencies");
    mkdirSync(dependencies);
    writeFileSync(join(dependencies, "dependency.mjs"), "export const value = 1;\n");
    const link = join(root, "node_modules");
    symlinkSync(dependencies, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    const retained = invoke(root, ["proof", "validate", original.path]);
    const recapture = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.deepEqual(
      { validation: retained.status, recapture: recapture.status },
      { validation: 0, recapture: 0 },
      retained.stdout + retained.stderr + recapture.stdout + recapture.stderr,
    );
    assert.equal(JSON.parse(retained.stdout).valid, true);
    const current = JSON.parse(recapture.stdout);
    assert.deepEqual(current.manifest.scopeHashes, original.manifest.scopeHashes);
    const currentValidation = invoke(root, ["proof", "validate", current.path]);
    assert.equal(
      currentValidation.status,
      0,
      currentValidation.stdout + currentValidation.stderr,
    );
    assert.equal(JSON.parse(currentValidation.stdout).valid, true);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") + "// changed\n",
    );
    const stale = invoke(root, ["proof", "validate", original.path]);
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /scope changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature end-to-end produces verifiable behavior logs and invalidates changed scope", () => {
  const root = makeFixture();
  try {
    assert.equal(invoke(root, ["proof", "run", "proof-plan.json"]).status, 1);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.manifest.status, "passed");
    assert.deepEqual(validateProof(root, result.manifest), []);
    const validate = invoke(root, ["proof", "validate", result.path]);
    assert.equal(validate.status, 0);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = () => 'WRONG';\n",
    );
    assert.match(validateProof(root, result.manifest).join(";"), /scope changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("failing checks cannot become successful by changing expected status or recorded exit code", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.test = { argv: [process.execPath, "-e", "process.exit(31)"] };
    writeJson(root, "arrs.json", config);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.manifest.status, "failed");
    result.manifest.status = "passed";
    result.manifest.results.find((result) => result.command === "test").exitCode = 0;
    assert.match(validateProof(root, result.manifest).join(";"), /substantiate/);
    const plan = readJson(root, "proof-plan.json");
    plan.steps.find((step) => step.command === "test").expectExitCode = 31;
    writeJson(root, "proof-plan.json", plan);
    assert.equal(
      invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("bug start captures failing scenario; same scenario after root-cause fix passes", () => {
  const root = makeFixture();
  try {
    const source = join(root, "src/domain/greeting.mjs");
    writeFileSync(source, "export const greeting = (name) => `Hello, ${name}!`;\n");
    const plan = readJson(root, "proof-plan.json");
    plan.category = "bug";
    plan.task = "trim-defect";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 1,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
    assert.equal(start.status, 0, start.stdout + start.stderr);
    const session = JSON.parse(start.stdout).session;
    assert.equal(JSON.parse(start.stdout).results[0].exitCode, 1);
    writeFileSync(
      source,
      "export const greeting = (name) => `Hello, ${name.trim()}!`;\n",
    );
    const finish = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(finish.status, 0, finish.stdout + finish.stderr);
    const manifest = JSON.parse(finish.stdout).manifest;
    assert.equal(manifest.results[0].exitCode, 1);
    assert.equal(manifest.results.at(-1).exitCode, 0);
    assert.deepEqual(validateProof(root, manifest), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("refactor before/after proves behavior preserved, and edited session/logs are rejected", () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.category = "refactor";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 0,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
    assert.equal(start.status, 0, start.stdout);
    const session = JSON.parse(start.stdout).session;
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export function greeting(name) { const normalized = name.trim(); return `Hello, ${normalized}!`; }\n",
    );
    const finish = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(finish.status, 0, finish.stdout);
    const saved = readJson(root, session);
    saved.plan.acceptance = ["fabricated"];
    writeJson(root, session, saved);
    assert.equal(invoke(root, ["proof", "finish", session, "--execute"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("incomplete acceptance and missing human approval reject before executing any command", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.check = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R3";
    writeJson(root, "proof-plan.json", plan);
    const result = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /approval|review/);
    assert.throws(() => readFileSync(join(root, "EXECUTED")), /ENOENT/);
    plan.risk = "R1";
    plan.acceptance.push("Uncovered criterion");
    writeJson(root, "proof-plan.json", plan);
    assert.equal(
      invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
      1,
    );
    assert.throws(() => readFileSync(join(root, "EXECUTED")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("modified artifact hashes, missing results and changed command binding invalidate proof", () => {
  const root = makeFixture();
  try {
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const manifest = JSON.parse(run.stdout).manifest;
    writeFileSync(join(root, manifest.results[0].log), "{}");
    assert.match(validateProof(root, manifest).join(";"), /hash|substantiate/);
    manifest.results.pop();
    assert.match(validateProof(root, manifest).join(";"), /one-to-one/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification commands that change covered source cannot claim success for unverified scope", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.verifyTargets.greet = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync('src/domain/greeting.mjs','\\n// changed after verification\\n')",
      ],
    };
    writeJson(root, "arrs.json", config);
    const result = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).manifest.status, "failed");
    assert.match(result.stdout, /scope changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 bug evidence becomes reviewable before binding completed implementation review", () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R2";
    plan.category = "bug";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 1,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => `Hello, ${name}!`;\n",
    );
    const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
    assert.equal(start.status, 0, start.stdout);
    const session = JSON.parse(start.stdout).session;
    const baseline = readFileSync(join(root, session));
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => `Hello, ${name.trim()}!`;\n",
    );
    const finish = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(finish.status, 0, finish.stdout);
    const path = JSON.parse(finish.stdout).path;
    const bytes = readFileSync(join(root, path));
    assert.equal(invoke(root, ["proof", "validate", path]).status, 0);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent:
        "Fixture reviewer examined actual corrected source and passing evidence",
    });
    const attached = invoke(root, ["proof", "review", path, "review.json"]);
    assert.equal(attached.status, 0, attached.stdout);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
    assert.deepEqual(readFileSync(join(root, session)), baseline);
    assert.deepEqual(readFileSync(join(root, path)), bytes);
    const retry = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(retry.status, 0, retry.stdout);
    const retryPath = JSON.parse(retry.stdout).path;
    assert.equal(invoke(root, ["proof", "validate", retryPath, "--accepted"]).status, 1);
    const reviewPath = JSON.parse(attached.stdout).path;
    copyFileSync(
      join(root, reviewPath),
      join(root, retryPath, "..", reviewPath.split("/").at(-1)),
    );
    assert.equal(invoke(root, ["proof", "validate", retryPath, "--accepted"]).status, 1);
    writeFileSync(join(root, path), Buffer.concat([bytes, Buffer.from("\n")]));
    assert.equal(invoke(root, ["proof", "validate", path]).status, 0);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution authorization remains required independently of completed review", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.check = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    for (const risk of ["R3", "R4"]) {
      const plan = readJson(root, "proof-plan.json");
      delete plan.authorization;
      plan.risk = risk;
      writeJson(root, "proof-plan.json", plan);
      assert.equal(
        invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
        1,
      );
      assert.equal(existsSync(join(root, "EXECUTED")), false);
      plan.authorization = { humanApproval: " ".repeat(12) };
      writeJson(root, "proof-plan.json", plan);
      assert.equal(
        invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
        1,
      );
      assert.equal(existsSync(join(root, "EXECUTED")), false);
      plan.authorization = {
        humanApproval:
          "Fixture human authorized bounded execution before evidence capture",
      };
      writeJson(root, "proof-plan.json", plan);
      const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
      assert.equal(run.status, 0, run.stdout);
      const path = JSON.parse(run.stdout).path;
      writeJson(root, "review.json", {
        schemaVersion: "0.1",
        stage: "implementation",
        independent: "Fixture reviewer examined this completed implementation",
      });
      assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 1);
      const review = readJson(root, "review.json");
      review.humanApproval =
        "Fixture human approved the reviewed implementation for acceptance";
      writeJson(root, "review.json", review);
      assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 0);
      assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
      rmSync(join(root, "EXECUTED"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy plan review notes remain readable but cannot replace implementation review", () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R2";
    plan.review = {
      independent: "Fixture note reviewing proposed work before any implementation",
    };
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const path = JSON.parse(run.stdout).path;
    assert.equal(invoke(root, ["proof", "validate", path]).status, 0);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
    for (const review of [
      null,
      {
        schemaVersion: "0.1",
        stage: "plan",
        independent: "Fixture review of the planned implementation only",
      },
      { schemaVersion: "0.1", stage: "implementation", independent: "short" },
    ]) {
      writeJson(root, "review.json", review);
      assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 1);
    }
    assert.equal(
      readdirSync(join(root, path, "..")).some((file) => file.startsWith("review-")),
      false,
    );
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture actual implementation reviewed after successful evidence",
    });
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => 'changed';\n",
    );
    assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 1);
    assert.equal(
      readdirSync(join(root, path, "..")).some((file) => file.startsWith("review-")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review acceptance follows current custom policy and rejects altered bindings", () => {
  const root = makeFixture();
  try {
    const policy = readJson(root, ".agent/policies/risk.json");
    policy.classes.R2.independentReview = false;
    policy.classes.R2.humanApproval = true;
    writeJson(root, ".agent/policies/risk.json", policy);
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R2";
    plan.authorization = {
      humanApproval: "Fixture human authorized execution under custom review policy",
    };
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const path = JSON.parse(run.stdout).path;
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      humanApproval:
        "Fixture human accepted completed implementation under custom policy",
    });
    const attached = invoke(root, ["proof", "review", path, "review.json"]);
    assert.equal(attached.status, 0, attached.stdout);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 0);
    policy.classes.R2.independentReview = true;
    writeJson(root, ".agent/policies/risk.json", policy);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
    policy.classes.R2.independentReview = false;
    writeJson(root, ".agent/policies/risk.json", policy);
    const reviewPath = JSON.parse(attached.stdout).path;
    const review = readJson(root, reviewPath);
    const original = structuredClone(review);
    review.scopeHashes[plan.scope[0]] = "0".repeat(64);
    writeJson(root, reviewPath, review);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
    writeJson(root, reviewPath, { ...original, createdAt: "2026-99-99T00:00:00Z" });
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
    writeJson(root, reviewPath, original);
    const config = readJson(root, "arrs.json");
    config.verifyTargets.greet.argv.push("changed");
    writeJson(root, "arrs.json", config);
    assert.equal(invoke(root, ["proof", "validate", path, "--accepted"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3/R4 baseline and finish enforce authorization while legacy permission stays readable", () => {
  const root = makeFixture();
  try {
    for (const risk of ["R3", "R4"]) {
      const plan = readJson(root, "proof-plan.json");
      plan.risk = risk;
      plan.category = "refactor";
      plan.steps = plan.steps.filter((step) => step.phase !== "before");
      plan.steps.unshift({
        phase: "before",
        command: "verify",
        target: "greet",
        expectExitCode: 0,
      });
      plan.steps.at(-1).phase = "after";
      delete plan.review;
      delete plan.authorization;
      writeJson(root, "proof-plan.json", plan);
      assert.equal(
        invoke(root, ["proof", "start", "proof-plan.json", "--execute"]).status,
        1,
      );
      plan.review = {
        independent: "Fixture legacy note about the proposed refactor",
        humanApproval: "Fixture human authorized controlled refactor execution",
      };
      plan.authorization = { humanApproval: " ".repeat(12) };
      writeJson(root, "proof-plan.json", plan);
      assert.equal(
        invoke(root, ["proof", "start", "proof-plan.json", "--execute"]).status,
        1,
      );
      delete plan.authorization;
      writeJson(root, "proof-plan.json", plan);
      const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
      assert.equal(start.status, 0, start.stdout);
      const session = JSON.parse(start.stdout).session;
      const policy = readJson(root, ".agent/policies/risk.json");
      policy.classes.R2.humanApproval = false;
      writeJson(root, ".agent/policies/risk.json", policy);
      const finish = invoke(root, ["proof", "finish", session, "--execute"]);
      assert.equal(finish.status, 0, finish.stdout);
      assert.equal(
        invoke(root, ["proof", "validate", JSON.parse(finish.stdout).path, "--accepted"])
          .status,
        1,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("implementation review rejects failed and noncanonical attempts before writing", () => {
  const root = makeFixture();
  try {
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture reviewer assessed the actual passing implementation",
    });
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const path = JSON.parse(run.stdout).path;
    copyFileSync(join(root, path), join(root, "noncanonical.json"));
    assert.equal(
      invoke(root, ["proof", "review", "noncanonical.json", "review.json"]).status,
      1,
    );
    const manifest = readJson(root, path);
    manifest.status = "failed";
    writeJson(root, path, manifest);
    assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 1);
    assert.equal(
      readdirSync(join(root, path, "..")).some((file) => file.startsWith("review-")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof writes and review attachments require effective ignored evidence before side effects", () => {
  const root = makeFixture();
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    writeFileSync(join(root, ".gitignore"), ".arrs/\n!.arrs/\n");
    mkdirSync(join(root, ".arrs"), { recursive: true });
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!evidence/\n");
    const config = readJson(root, "arrs.json");
    config.commands.check = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    assert.equal(
      invoke(root, ["proof", "run", "proof-plan.json", "--execute"]).status,
      1,
    );
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.equal(existsSync(join(root, ".arrs/evidence")), false);
    const plan = readJson(root, "proof-plan.json");
    plan.category = "refactor";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 0,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    assert.equal(
      invoke(root, ["proof", "start", "proof-plan.json", "--execute"]).status,
      1,
    );
    assert.equal(existsSync(join(root, ".arrs/evidence")), false);
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!.gitignore\n");
    const start = invoke(root, ["proof", "start", "proof-plan.json", "--execute"]);
    assert.equal(start.status, 0, start.stdout);
    const session = JSON.parse(start.stdout).session;
    const history = readdirSync(join(root, ".arrs/evidence")).sort();
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!evidence/\n");
    assert.equal(invoke(root, ["proof", "finish", session, "--execute"]).status, 1);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(readdirSync(join(root, ".arrs/evidence")).sort(), history);
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!.gitignore\n");
    const finish = invoke(root, ["proof", "finish", session, "--execute"]);
    assert.equal(finish.status, 0, finish.stdout);
    const path = JSON.parse(finish.stdout).path;
    writeJson(root, "review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture reviewer examined completed source and technical proof",
    });
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!evidence/\n");
    assert.equal(invoke(root, ["proof", "review", path, "review.json"]).status, 1);
    assert.equal(
      readdirSync(join(root, path, "..")).some((file) => file.startsWith("review-")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical scoped marker supports explicit bounded fallback without Git and custom evidence directories", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.proof.evidenceDir = ".arrs/custom/evidence/";
    writeJson(root, "arrs.json", config);
    mkdirSync(join(root, ".arrs"), { recursive: true });
    writeFileSync(
      join(root, ".arrs/.gitignore"),
      "# Local evidence convention\r\n*\r\n!.gitignore",
    );
    const args = [
      cli,
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      "--root",
      root,
      "--json",
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: join(root, "no-tools") },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).ignoreProtection.method, "scoped-marker");
    writeFileSync(join(root, ".arrs/.gitignore"), " *\n!.gitignore\n");
    const rejected = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: join(root, "no-tools") },
    });
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).error, /ignor|protection/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected pre-change pointer/rule floors reject proof run and start before commands or evidence effects", () => {
  for (const custom of [false, true]) {
    const { root, source, baseline, flags, plan } = makePolicyTransitionFixture({
      custom,
    });
    try {
      assert.equal(policyRequirements(root, ["arrs.json"], "R0", baseline).risk, "R3");
      assert.equal(policyRequirements(root, ["./arrs.json"], "R0", baseline).risk, "R3");
      if (
        existsSync(join(root, "ARRS.JSON")) &&
        lstatSync(join(root, "ARRS.JSON")).ino === lstatSync(join(root, "arrs.json")).ino
      )
        assert.equal(policyRequirements(root, ["ARRS.JSON"], "R0", baseline).risk, "R3");
      assert.equal(policyRequirements(root, ["arrs.json"], "R4", baseline).risk, "R4");
      const candidate = invoke(root, ["risk", "arrs.json", "--risk", "R0"]);
      assert.equal(JSON.parse(candidate.stdout).effective, "R0");
      assert.equal(JSON.parse(candidate.stdout).policyMode, "candidate-only");
      assert.match(
        JSON.parse(candidate.stdout).policyTransitionLimitation,
        /does not establish/,
      );
      const classified = invoke(root, ["risk", "arrs.json", "--risk", "R0", ...flags]);
      assert.equal(JSON.parse(classified.stdout).effective, "R3");
      assert.equal(JSON.parse(classified.stdout).policyMode, "protected-transition");
      assert.throws(() => inspectPolicyBaseline(root, root), /external directory/);
      for (const action of ["run", "start"]) {
        if (action === "start") {
          plan.category = "refactor";
          plan.steps.unshift({
            phase: "before",
            command: "verify",
            target: "greet",
            expectExitCode: 0,
          });
          plan.steps.at(-1).phase = "after";
          writeJson(root, "proof-plan.json", plan);
        }
        const before = snapshotFixtureTree(root);
        const result = invoke(root, [
          "proof",
          action,
          "proof-plan.json",
          "--execute",
          ...flags,
        ]);
        assert.equal(result.status, 1, result.stdout);
        assert.match(JSON.parse(result.stdout).error, /risk floor/);
        assert.equal(existsSync(join(root, "EXECUTED")), false);
        assert.deepEqual(snapshotFixtureTree(root), before);
      }
      plan.risk = "R3";
      assert.ok(
        validatePlan(root, plan, baseline).some((error) =>
          /human approval authorization/.test(error),
        ),
      );
      const originalConfig = readJson(source, "arrs.json");
      const direct = readJson(source, originalConfig.riskPolicy);
      direct.sensitivePaths = [];
      writeJson(root, originalConfig.riskPolicy, direct);
      const currentConfig = readJson(root, "arrs.json");
      currentConfig.riskPolicy = originalConfig.riskPolicy;
      writeJson(root, "arrs.json", currentConfig);
      assert.equal(policyRequirements(root, ["arrs.json"], "R0", baseline).risk, "R3");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  }
});

test("protected proof session retains selection and rejects missing, mismatched or stale context before effects", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture();
  try {
    plan.category = "refactor";
    plan.risk = "R3";
    plan.authorization = {
      humanApproval: "Actual fixture permission to execute the controlled transition",
    };
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 0,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    const started = invoke(root, [
      "proof",
      "start",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(started.status, 0, started.stdout);
    const session = JSON.parse(started.stdout).session;
    assert.deepEqual(readJson(root, session).plan.policyBaseline, baseline);
    for (const selected of [
      [],
      ["--baseline", source],
      ["--baseline", source, "--baseline-sha256", "0".repeat(64)],
      [...flags, "--baseline", source],
      [...flags, "--baseline-sha256", baseline.sha256],
    ]) {
      const before = snapshotFixtureTree(root);
      const result = invoke(root, ["proof", "finish", session, "--execute", ...selected]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(existsSync(join(root, "EXECUTED")), false);
      assert.deepEqual(snapshotFixtureTree(root), before);
    }
    const sourceConfig = readJson(source, "arrs.json");
    sourceConfig.project.name = "altered trusted source";
    const original = readFileSync(join(source, "arrs.json"));
    writeJson(source, "arrs.json", sourceConfig);
    const before = snapshotFixtureTree(root);
    const stale = invoke(root, ["proof", "finish", session, "--execute", ...flags]);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(JSON.parse(stale.stdout).error, /baseline controls changed/);
    assert.deepEqual(snapshotFixtureTree(root), before);
    writeFileSync(join(source, "arrs.json"), original);
    const finished = invoke(root, ["proof", "finish", session, "--execute", ...flags]);
    assert.equal(finished.status, 0, finished.stdout);
    const { path, manifest } = JSON.parse(finished.stdout);
    assert.deepEqual(manifest.policyBaseline, baseline);
    assert.equal(existsSync(join(root, "EXECUTED")), true);
    assert.equal(invoke(root, ["proof", "validate", path]).status, 1);
    assert.equal(invoke(root, ["proof", "validate", path, ...flags]).status, 0);
    assert.equal(
      invoke(root, ["proof", "validate", path, "--accepted", ...flags]).status,
      1,
    );
    writeJson(root, "incomplete-review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Actual fixture independent reviewer examined this attempt",
    });
    const history = snapshotFixtureTree(root);
    const rejectedReview = invoke(root, [
      "proof",
      "review",
      path,
      "incomplete-review.json",
      ...flags,
    ]);
    assert.equal(rejectedReview.status, 1, rejectedReview.stdout);
    assert.match(
      JSON.parse(rejectedReview.stdout).error,
      /Human approval of the implementation/,
    );
    assert.deepEqual(snapshotFixtureTree(root), history);
    // This test does not invent human acceptance. The selected R3 gate remains pending.
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("protected command bindings and baseline/candidate Feature Maps cannot be weakened", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.check.argv = [process.execPath, "--version"];
    writeJson(root, "arrs.json", config);
    const before = snapshotFixtureTree(root);
    const result = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).error, /command binding check/);
    assert.deepEqual(snapshotFixtureTree(root), before);
    config.commands.check = readJson(source, "arrs.json").commands.check;
    config.commands.check.timeoutSeconds = 1;
    writeJson(root, "arrs.json", config);
    assert.throws(
      () => policyRequirements(root, plan.scope, "R0", baseline),
      /command binding check/,
    );
    delete config.commands.check.timeoutSeconds;
    writeJson(root, "arrs.json", config);
    const map = readJson(root, "docs/features/greeting.json");
    map.risk = "R0";
    writeJson(root, "docs/features/greeting.json", map);
    assert.equal(policyRequirements(root, ["src/domain"], "R0", baseline).risk, "R1");
    map.risk = "R2";
    writeJson(root, "docs/features/greeting.json", map);
    assert.equal(policyRequirements(root, ["src/domain"], "R0", baseline).risk, "R2");
    config.verifyTargets.greet.argv = [process.execPath, "--version"];
    writeJson(root, "arrs.json", config);
    assert.throws(
      () => policyRequirements(root, ["src/domain"], "R0", baseline),
      /command binding verify greet/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("a candidate-only before session cannot acquire a protected baseline at finish", () => {
  const root = makeFixture();
  const source = makeFixture();
  try {
    const baseline = inspectPolicyBaseline(root, source);
    const session = startLifecycle(root, "refactor");
    const before = snapshotFixtureTree(root);
    const result = invoke(root, [
      "proof",
      "finish",
      session,
      "--execute",
      "--baseline",
      baseline.root,
      "--baseline-sha256",
      baseline.sha256,
    ]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).error, /baseline selected at proof start/);
    assert.deepEqual(snapshotFixtureTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("protected requirements retain baseline configuration checks, class gates and behavioral threshold", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture({
    prepare(config, policy) {
      config.proof.requiredChecks.push("setup");
      config.proof.behavioralRequiredFrom = "R0";
      policy.classes.R2.requiredChecks.push("dev");
      policy.classes.R2.independentReview = true;
      policy.classes.R2.humanApproval = true;
    },
  });
  try {
    const config = readJson(root, "arrs.json");
    config.proof.requiredChecks = config.proof.requiredChecks.filter(
      (check) => check !== "setup",
    );
    config.proof.behavioralRequiredFrom = "R4";
    writeJson(root, "arrs.json", config);
    const weak = readJson(root, config.riskPolicy);
    weak.classes.R2.requiredChecks = weak.classes.R2.requiredChecks.filter(
      (check) => check !== "dev",
    );
    weak.classes.R2.independentReview = false;
    weak.classes.R2.humanApproval = false;
    writeJson(root, config.riskPolicy, weak);
    plan.scope = ["docs/product/README.md"];
    plan.risk = "R2";
    let errors = validatePlan(root, plan, baseline);
    assert.ok(
      errors.some((error) => /required successful setup/.test(error)),
      errors.join(";"),
    );
    assert.ok(
      errors.some((error) => /required successful dev/.test(error)),
      errors.join(";"),
    );
    assert.ok(
      errors.some((error) => /human approval authorization/.test(error)),
      errors.join(";"),
    );
    const requirements = policyRequirements(root, plan.scope, plan.risk, baseline);
    assert.equal(requirements.policy.independentReview, true);
    assert.equal(requirements.policy.humanApproval, true);
    assert.equal(requirements.behavioralRequiredFrom, "R0");
    plan.steps.unshift(
      { phase: "mechanical", command: "setup", expectExitCode: 0 },
      { phase: "mechanical", command: "dev", expectExitCode: 0 },
    );
    plan.authorization = {
      humanApproval:
        "Fixture assertion supplies execution permission, not implementation acceptance",
    };
    const noBehavior = {
      ...plan,
      category: "docs",
      steps: plan.steps.map((step) => ({
        ...step,
        phase: step.phase === "behavior" ? "mechanical" : step.phase,
      })),
    };
    assert.ok(
      validatePlan(root, noBehavior, baseline).some((error) =>
        /runtime behavioral verification/.test(error),
      ),
    );
    writeJson(root, "proof-plan.json", plan);
    const proof = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(proof.status, 0, proof.stdout);
    const path = JSON.parse(proof.stdout).path;
    assert.equal(
      invoke(root, ["proof", "validate", path, "--accepted", ...flags]).status,
      1,
    );
    // No completed review or human acceptance record is fabricated to bypass this gate.
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("missing and invalid selected baseline sources reject admission without fallback or effects", () => {
  const { root, source, baseline, flags } = makePolicyTransitionFixture();
  try {
    const policyPath = readJson(source, "arrs.json").riskPolicy;
    const original = readFileSync(join(source, policyPath));
    const policy = readJson(source, policyPath);
    policy.classes.R3.independentReview = false;
    writeJson(source, policyPath, policy);
    const before = snapshotFixtureTree(root);
    const invalid = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(invalid.status, 1, invalid.stdout);
    assert.match(JSON.parse(invalid.stdout).error, /baseline is invalid; restore/);
    assert.deepEqual(snapshotFixtureTree(root), before);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    writeFileSync(join(source, policyPath), original);
    rmSync(source, { recursive: true, force: true });
    const missing = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(
      JSON.parse(missing.stdout).error,
      /baseline directory is missing; restore/,
    );
    assert.deepEqual(snapshotFixtureTree(root), before);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("capture uses the declared class instead of imposing unused lower-class command bindings", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture({
    prepare(config, policy) {
      policy.classes.R0.requiredChecks.push("dev");
    },
  });
  try {
    const config = readJson(root, "arrs.json");
    config.commands.dev = { argv: [process.execPath, "--version"] };
    writeJson(root, "arrs.json", config);
    plan.risk = "R1";
    plan.scope = ["src/domain", "src/application"];
    writeJson(root, "proof-plan.json", plan);
    assert.deepEqual(validatePlan(root, plan, baseline), []);
    const proof = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(proof.status, 0, proof.stdout);
    const { path, manifest } = JSON.parse(proof.stdout);
    assert.deepEqual(manifest.policyBaseline, baseline);
    assert.equal(
      invoke(root, ["proof", "validate", path, "--accepted", ...flags]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("same-byte baseline hardlink replacement changes selection and rejects proof/work before effects", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture({
    prepare(config, policy, root) {
      writeFileSync(join(root, "sensitive-control.txt"), "pre-change source identity\n");
      writeFileSync(join(root, "alias-control.txt"), "pre-change source identity\n");
      policy.sensitivePaths.push({
        path: "sensitive-control.txt",
        risk: "R3",
        reason: "Sensitive control source requires review.",
      });
    },
    prepareSource(source) {
      unlinkSync(join(source, "alias-control.txt"));
      linkSync(join(source, "sensitive-control.txt"), join(source, "alias-control.txt"));
      symlinkSync(join(source, "absent-dependencies"), join(source, "node_modules"));
    },
  });
  try {
    assert.equal(
      policyRequirements(root, ["alias-control.txt"], "R0", baseline).risk,
      "R3",
    );
    const contents = readFileSync(join(source, "alias-control.txt"));
    unlinkSync(join(source, "alias-control.txt"));
    writeFileSync(join(source, "alias-control.txt"), contents);
    assert.deepEqual(readFileSync(join(source, "alias-control.txt")), contents);
    assert.notEqual(inspectPolicyBaseline(root, source).sha256, baseline.sha256);
    plan.scope = ["alias-control.txt"];
    writeJson(root, "proof-plan.json", plan);
    const file = ".agent/work-items/alias-transition.json";
    writeJson(root, file, {
      schemaVersion: "0.1",
      id: plan.task,
      title: "Keep the baseline alias floor",
      state: "needs-triage",
      risk: "R0",
      category: "feature",
      featureIds: ["greeting"],
      acceptance: plan.acceptance,
      context: plan.scope,
      verificationTargets: ["greet"],
      dependencies: [],
      decisions: [],
    });
    const before = snapshotFixtureTree(root);
    const original = readFileSync(join(root, file));
    for (const args of [
      ["proof", "run", "proof-plan.json", "--execute"],
      ["work", "transition", file, "--to", "ready-for-agent"],
    ]) {
      const rejected = invoke(root, [...args, ...flags]);
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(JSON.parse(rejected.stdout).error, /source identities changed/);
      assert.equal(existsSync(join(root, "EXECUTED")), false);
      assert.deepEqual(snapshotFixtureTree(root), before);
      assert.deepEqual(readFileSync(join(root, file)), original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("nested reserved-name source identities are pinned while exact excluded roots stay unvisited", () => {
  const { root, source, baseline, flags } = makePolicyTransitionFixture({
    prepare(config, policy, root) {
      for (const name of ["build", "dist", "vendor", "node_modules", ".arrs", ".git"]) {
        mkdirSync(join(root, "src/domain", name), { recursive: true });
        writeFileSync(
          join(root, "src/domain", name, "state.txt"),
          "covered nested source\n",
        );
      }
    },
    prepareSource(source) {
      symlinkSync(join(source, "outside-dependencies"), join(source, "node_modules"));
    },
  });
  try {
    assert.equal(inspectPolicyBaseline(root, source).sha256, baseline.sha256);
    const path = join(source, "src/domain/node_modules/state.txt");
    const bytes = readFileSync(path);
    unlinkSync(path);
    writeFileSync(path, bytes);
    const before = snapshotFixtureTree(root);
    const rejected = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).error, /source identities changed/);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(snapshotFixtureTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("excluded floor anchors cannot establish protected selection even when source aliases share their inode", () => {
  const { root, source, flags } = makePolicyTransitionFixture();
  try {
    mkdirSync(join(source, ".arrs"), { recursive: true });
    writeFileSync(join(source, ".arrs/anchor.txt"), "excluded anchor\n");
    linkSync(join(source, ".arrs/anchor.txt"), join(source, "source-alias.txt"));
    const config = readJson(source, "arrs.json");
    const policy = readJson(source, config.riskPolicy);
    policy.sensitivePaths.push({
      path: "./.arrs//anchor.txt",
      risk: "R3",
      reason: "Excluded metadata anchor must not supply unpinned source identity.",
    });
    writeJson(source, config.riskPolicy, policy);
    assert.throws(
      () => inspectPolicyBaseline(root, source),
      /floor reference.*excluded root \.arrs/,
    );
    const before = snapshotFixtureTree(root);
    const rejected = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(JSON.parse(rejected.stdout).error, /floor reference.*excluded root/);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(snapshotFixtureTree(root), before);
    const saved = policy.sensitivePaths.at(-1);
    policy.sensitivePaths.pop();
    for (const path of [".git/anchor.txt", "node_modules/anchor.txt"]) {
      policy.sensitivePaths.push({ ...saved, path });
      writeJson(source, config.riskPolicy, policy);
      assert.throws(
        () => inspectPolicyBaseline(root, source),
        /floor reference.*excluded root/,
      );
      policy.sensitivePaths.pop();
    }
    // Actual case aliases reject too; distinct uppercase source remains supported.
    policy.sensitivePaths.push({ ...saved, path: ".ARRS/anchor.txt" });
    writeJson(source, config.riskPolicy, policy);
    if (
      existsSync(join(source, ".ARRS")) &&
      lstatSync(join(source, ".ARRS")).ino === lstatSync(join(source, ".arrs")).ino
    )
      assert.throws(
        () => inspectPolicyBaseline(root, source),
        /floor reference.*excluded root/,
      );
    else {
      mkdirSync(join(source, ".ARRS"), { recursive: true });
      writeFileSync(join(source, ".ARRS/anchor.txt"), "distinct uppercase source\n");
      assert.doesNotThrow(() => inspectPolicyBaseline(root, source));
    }
    policy.sensitivePaths = policy.sensitivePaths.filter(
      (item) => item.path === "arrs.json",
    );
    writeJson(source, config.riskPolicy, policy);
    const architecture = readJson(source, config.architecture.policy);
    architecture.modules.push({
      id: "excluded",
      path: ".arrs",
      allows: [],
      public: [".arrs/anchor.txt"],
    });
    writeJson(source, config.architecture.policy, architecture);
    const mapPath = `${config.knowledge.features}/greeting.json`;
    const map = readJson(source, mapPath);
    map.boundaries.push("excluded");
    for (const field of ["implementation", "entryPoints"]) {
      map[field].push(".arrs/anchor.txt");
      writeJson(source, mapPath, map);
      assert.throws(
        () => inspectPolicyBaseline(root, source),
        /floor reference.*excluded root/,
      );
      map[field].pop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("excluded protected work context and risk queries cannot use unpinned alias relations", () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture({
    prepare(config, policy, root) {
      writeFileSync(join(root, "sensitive-control.txt"), "retained source anchor\n");
      writeFileSync(join(root, ".arrs/context-alias.txt"), "retained source anchor\n");
      policy.sensitivePaths.push({
        path: "sensitive-control.txt",
        risk: "R3",
        reason: "Inventoried source anchor requires review.",
      });
    },
    prepareSource(source) {
      unlinkSync(join(source, ".arrs/context-alias.txt"));
      linkSync(
        join(source, "sensitive-control.txt"),
        join(source, ".arrs/context-alias.txt"),
      );
    },
  });
  try {
    const bytes = readFileSync(join(source, ".arrs/context-alias.txt"));
    unlinkSync(join(source, ".arrs/context-alias.txt"));
    writeFileSync(join(source, ".arrs/context-alias.txt"), bytes);
    assert.equal(inspectPolicyBaseline(root, source).sha256, baseline.sha256);
    const context = "./.arrs//context-alias.txt";
    const file = ".agent/work-items/excluded-context.json";
    writeJson(root, file, {
      schemaVersion: "0.1",
      id: plan.task,
      title: "Do not use excluded query aliases",
      state: "needs-triage",
      risk: "R1",
      category: "feature",
      featureIds: ["greeting"],
      acceptance: plan.acceptance,
      context: [context],
      verificationTargets: ["greet"],
      dependencies: [],
      decisions: [],
    });
    const before = snapshotFixtureTree(root);
    const original = readFileSync(join(root, file));
    for (const args of [
      ["risk", context, "--risk", "R0"],
      ["work", "transition", file, "--to", "ready-for-agent"],
    ]) {
      const rejected = invoke(root, [...args, ...flags]);
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(JSON.parse(rejected.stdout).error, /scope\/context.*excluded root/);
      assert.equal(existsSync(join(root, "EXECUTED")), false);
      assert.deepEqual(snapshotFixtureTree(root), before);
      assert.deepEqual(readFileSync(join(root, file)), original);
    }
    const local = invoke(root, ["risk", context, "--risk", "R0"]);
    assert.equal(local.status, 0, local.stdout);
    assert.equal(JSON.parse(local.stdout).policyMode, "candidate-only");
    assert.equal(policyRequirements(root, ["."], "R0", baseline).risk, "R3");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
