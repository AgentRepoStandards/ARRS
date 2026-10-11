import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../dist/core/audit.js";
import { doctor } from "../dist/core/doctor.js";
import { checkSecurity } from "../dist/core/security.js";
import { makeFixture, readJson, writeJson } from "./helpers.mjs";

const control = (report, id) => report.controls.find((item) => item.id === id);
function fixture(t) {
  const root = makeFixture(4);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("read-only audit labels execution as unevaluated and never invokes configured commands", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  const command = {
    argv: [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('executed-marker','yes')",
    ],
  };
  for (const name of ["check", "test", "build", "verify"])
    config.commands[name] = command;
  config.verifyTargets.greet = command;
  writeJson(root, "arrs.json", config);
  const report = await audit(root);
  assert.equal(existsSync(join(root, "executed-marker")), false);
  for (const id of ["check-executed", "verification-executed"]) {
    assert.equal(control(report, id).status, "not-evaluated");
    assert.equal(control(report, id).passed, false);
  }
  assert.ok(report.level <= 1);
});

test("unconfigured commands produce one prerequisite-aware execution diagnostic", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  delete config.commands.check;
  delete config.commands.verify;
  writeJson(root, "arrs.json", config);
  const report = await audit(root);
  assert.equal(control(report, "commands").status, "incomplete");
  assert.equal(control(report, "check-executed").status, "blocked");
  assert.deepEqual(control(report, "check-executed").dependsOn, ["commands"]);
  const verification = control(report, "verification-executed");
  assert.equal(verification.status, "blocked");
  assert.equal((verification.detail.match(/verify is unconfigured/g) ?? []).length, 1);
});

test("doctor accurately labels instruction presence and empty risk coverage cannot qualify", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "AGENTS.md"), "# Existing instructions\n");
  const diagnostics = await doctor(root);
  const agents = diagnostics.checks.find((item) => item.id === "agents");
  assert.equal(agents.passed, true);
  assert.match(agents.detail, /file.*present/i);
  assert.doesNotMatch(agents.detail, /navigation contract/i);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths = [];
  writeJson(root, ".agent/policies/risk.json", policy);
  const report = await audit(root);
  assert.equal(control(report, "risk").status, "incomplete");
  assert.equal(control(report, "sensitive-classification").status, "blocked");
  assert.deepEqual(control(report, "sensitive-classification").dependsOn, ["risk"]);
  assert.equal(control(report, "sensitive-classification").passed, false);
  assert.ok(report.level < 4);
});

test("executed audit preserves a failing command result", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  config.commands.check = { argv: [process.execPath, "-e", "process.exit(37)"] };
  writeJson(root, "arrs.json", config);
  const report = await audit(root, { execute: true });
  assert.equal(control(report, "check-executed").passed, false);
  assert.match(control(report, "check-executed").detail, /exited 37/);
});

test("doctor never mistakes an executable directory for an available command", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  config.commands.check = { argv: ["."] };
  writeJson(root, "arrs.json", config);
  const diagnostics = await doctor(root);
  const check = diagnostics.checks.find((item) => item.id === "command:check");
  assert.equal(check.passed, false);
  assert.equal(check.status, "failed");
});

test("missing verify never cites a passed Level 1 commands control as its blocker", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  delete config.commands.verify;
  writeJson(root, "arrs.json", config);
  const report = await audit(root);
  assert.equal(control(report, "commands").passed, true);
  const verification = control(report, "verification-executed");
  assert.equal(verification.status, "blocked");
  assert.match(verification.detail, /verify is unconfigured/);
  assert.equal(verification.dependsOn?.includes("commands") ?? false, false);
});

test("valid maps with empty architectural setup report one ownership prerequisite", async (t) => {
  const root = fixture(t);
  writeJson(root, ".agent/policies/architecture.json", {
    schemaVersion: "0.1",
    modules: [],
  });
  const report = await audit(root);
  const features = control(report, "features");
  assert.equal(features.status, "blocked");
  assert.deepEqual(features.dependsOn, ["architecture"]);
  assert.match(features.detail, /architecture is unconfigured/);
  assert.doesNotMatch(
    features.detail,
    /unknown owning module|outside its declared boundaries/,
  );
  assert.equal(control(report, "architecture").status, "incomplete");
  assert.equal(control(report, "architecture-guard").status, "blocked");
  assert.ok(report.level < 2);
});

test("broken knowledge references are failed evaluations consistently in doctor and audit", async (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "docs/product/README.md"),
    "# Product context\n\nAn operator supplies a recipient name and receives a stable salutation with surrounding whitespace removed. Read [acceptance](missing.md).\n",
  );
  const diagnostic = await doctor(root);
  const assessment = await audit(root);
  assert.equal(
    diagnostic.checks.find((item) => item.id === "knowledge:product").status,
    "failed",
  );
  assert.equal(control(assessment, "knowledge").status, "failed");
  assert.equal(control(assessment, "knowledge").passed, false);
});

test("dependency inventory and an unreviewed baseline rewrite do not grant approval", (t) => {
  const root = fixture(t);
  writeJson(root, "package.json", { dependencies: { fictional: "1.0.0" } });
  assert.match(checkSecurity(root).join(";"), /no recorded justification/);
  writeJson(root, ".agent/policies/dependency-baseline.json", {
    schemaVersion: "0.1",
    dependencies: { fictional: "1.0.0" },
  });
  assert.match(checkSecurity(root).join(";"), /no recorded justification/);
  const policy = readJson(root, ".agent/policies/exceptions.json");
  policy.baseline = { fictional: "1.0.0" };
  writeJson(root, ".agent/policies/exceptions.json", policy);
  assert.match(checkSecurity(root).join(";"), /additional properties/);
});
