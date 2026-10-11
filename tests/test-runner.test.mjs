import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "arrs-test-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  copyFileSync(
    fileURLToPath(new URL("../scripts/test.mjs", import.meta.url)),
    join(root, "test.mjs"),
  );
  return root;
}
const invoke = (root) =>
  spawnSync(process.execPath, ["test.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    // Exercise a fresh admission invocation, not Node's recursive-run guard.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });

test("test admission rejects an empty discovery inventory", (t) => {
  const result = invoke(fixture(t));
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No ARRS test suites found/);
});

test("test admission runs isolated suites, excludes helpers and retains a failed assertion", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "tests/helper.mjs"), "throw Error('HELPER_EXECUTED');\n");
  for (const [name, peer, expected] of [
    ["first", "second", 1],
    ["second", "first", 2],
  ])
    writeFileSync(
      join(root, `tests/${name}.test.mjs`),
      `import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
test('${name} isolated suite',async()=>{
  writeFileSync('${name}.ready',String(process.pid));
  if (${availableParallelism() > 1}) {
    const deadline=Date.now()+4000;
    while(!existsSync('${peer}.ready')&&Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync('${peer}.ready'),'Both isolated suites must start before either completes');
  }
  writeFileSync('${name}.completed','checked');
  assert.equal(1,${expected},'Fixture validation failure must reach test admission');
});\n`,
    );
  const result = invoke(root);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Fixture validation failure/);
  assert.doesNotMatch(result.stdout + result.stderr, /HELPER_EXECUTED/);
  for (const name of ["first", "second"])
    assert.ok(existsSync(join(root, `${name}.completed`)), name);
  assert.notEqual(
    readFileSync(join(root, "first.ready"), "utf8"),
    readFileSync(join(root, "second.ready"), "utf8"),
    "Separate suites must run in separate processes",
  );
});

test("fixture native assertions run inside outer tests and their failures reach CLI and proof capture", async (t) => {
  const { makeFixture, invoke: invokeCli, readJson } = await import("./helpers.mjs");
  const { runCommand } = await import("../dist/core/runner.js");
  const { runProof } = await import("../dist/workflows/proof.js");
  const root = makeFixture(3);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readJson(root, "arrs.json");
  const passing = await runCommand(root, config.commands.test);
  assert.equal(passing.exitCode, 0, passing.stdout + passing.stderr);
  assert.match(passing.stdout, /trims and greets a name/);
  assert.match(passing.stdout, /\btests 1\b/);
  assert.doesNotMatch(passing.stderr, /recursively|skipping running files/);
  const cliPassing = invokeCli(root, ["run", "test"]);
  assert.equal(cliPassing.status, 0, cliPassing.stdout + cliPassing.stderr);
  assert.match(JSON.parse(cliPassing.stdout).stdout, /\btests 1\b/);

  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    "export const greeting = () => 'broken';\n",
  );
  const cliFailure = invokeCli(root, ["run", "test"]);
  assert.notEqual(cliFailure.status, 0);
  assert.match(JSON.parse(cliFailure.stdout).stdout, /trims and greets a name/);
  const captured = await runProof(root, "proof-plan.json", true);
  assert.equal(captured.manifest.status, "failed");
  const nativeTest = captured.manifest.results.find(
    (result) => result.command === "test",
  );
  assert.ok(nativeTest);
  assert.notEqual(nativeTest.exitCode, 0);
  const log = readJson(root, nativeTest.log);
  assert.match(log.stdout, /trims and greets a name/);
  assert.match(log.stdout, /\bfail 1\b/);
  assert.ok(
    captured.errors.some((error) => /Required verification result .* failed/.test(error)),
  );
});
