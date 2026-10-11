import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../dist/core/audit.js";
import {
  makeFixture,
  invoke,
  readJson,
  writeJson,
  makePolicyTransitionFixture,
} from "./helpers.mjs";

test("unmanaged repo is level0 and execution opt-in caps static maturity at mapped", async () => {
  const empty = mkdtempSync(join(tmpdir(), "arrs-level0-"));
  try {
    assert.equal((await audit(empty, { execute: true })).level, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const root = makeFixture();
  try {
    const report = await audit(root);
    assert.equal(report.level, 1, JSON.stringify(report));
    assert.ok(report.warnings.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mapped, constrained, self-verifying and delegatable repositories classify cumulatively", async () => {
  for (const expected of [1, 2, 3, 4]) {
    const root = makeFixture(expected);
    try {
      if (expected === 1) {
        const policy = readJson(root, ".agent/policies/architecture.json");
        policy.modules[0].allows = ["application"];
        writeJson(root, ".agent/policies/architecture.json", policy);
      }
      if (expected >= 3) {
        const proof = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
        assert.equal(proof.status, 0, proof.stdout + proof.stderr);
      }
      const report = await audit(root, { execute: true });
      assert.equal(report.level, expected, JSON.stringify(report, null, 2));
      assert.ok(report.controls.some((control) => control.passed));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("violating dependency and failing real acceptance gate reduce maturity", async () => {
  const root = makeFixture(4);
  try {
    let proof = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(proof.status, 0, proof.stdout);
    writeFileSync(
      join(root, "src/domain/bad.mjs"),
      "import '../application/main.mjs';\n",
    );
    let report = await audit(root, { execute: true });
    assert.equal(report.level, 1);
    assert.ok(
      report.controls.some(
        (control) => !control.passed && /architecture/.test(control.id),
      ),
    );
    rmSync(join(root, "src/domain/bad.mjs"));
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = () => 'wrong';\n",
    );
    report = await audit(root, { execute: true });
    assert.equal(report.level, 2);
    assert.ok(
      report.controls.some(
        (control) => !control.passed && /test|behavior|proof/.test(control.id),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending implementation review cannot satisfy the audit evidence gate", async () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R2";
    plan.review = {
      independent: "Fixture proposed-plan review before actual implementation",
    };
    writeJson(root, "proof-plan.json", plan);
    const run = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
    assert.equal(run.status, 0, run.stdout);
    const control = (await audit(root)).controls.find(
      (control) => control.id === "proof-evidence",
    );
    assert.equal(control.passed, false, control.detail);
    assert.equal(
      invoke(root, ["proof", "validate", JSON.parse(run.stdout).path]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected audit validates source and command bindings before actual execution effects", async () => {
  const { root, source, baseline, flags, plan } = makePolicyTransitionFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.test.argv = [process.execPath, "--version"];
    writeJson(root, "arrs.json", config);
    const before = existsSync(join(root, ".arrs/evidence"))
      ? readdirSync(join(root, ".arrs/evidence")).sort()
      : [];
    await assert.rejects(
      audit(root, { execute: true, baseline }),
      /command binding test/,
    );
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.deepEqual(
      existsSync(join(root, ".arrs/evidence"))
        ? readdirSync(join(root, ".arrs/evidence")).sort()
        : [],
      before,
    );
    config.commands.test = readJson(source, "arrs.json").commands.test;
    writeJson(root, "arrs.json", config);
    await assert.rejects(
      audit(root, { execute: true, baseline: { ...baseline, sha256: "0".repeat(64) } }),
      /baseline controls changed/,
    );
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    plan.risk = "R3";
    plan.authorization = {
      humanApproval:
        "Fixture assertion authorizes capture; no real human acceptance is claimed",
    };
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
    const original = readFileSync(join(root, path));
    const report = await audit(root, { baseline });
    assert.equal(
      report.controls.find((control) => control.id === "proof-evidence").passed,
      false,
    );
    assert.ok(
      report.warnings.some((warning) => /No valid implementation review/.test(warning)),
    );
    const missing = await audit(root);
    assert.equal(
      missing.controls.find((control) => control.id === "proof-evidence").passed,
      false,
    );
    assert.ok(missing.warnings.some((warning) => /independently supplied/.test(warning)));
    assert.deepEqual(readFileSync(join(root, path)), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
