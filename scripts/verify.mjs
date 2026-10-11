// Real CLI behavior: initialize -> configure -> execute -> proof -> audit.
import { strict as assert } from "node:assert";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixture, invoke, readJson, writeJson } from "../tests/helpers.mjs";
import { audit } from "../dist/core/audit.js";
const root = makeFixture(4);
try {
  assert.equal(invoke(root, ["doctor"]).status, 0, "Fixture doctor must be healthy");
  assert.equal(
    invoke(root, ["run", "verify", "greet"]).status,
    0,
    "Actual application CLI acceptance",
  );
  const proof = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  const evidence = JSON.parse(proof.stdout);
  assert.equal(invoke(root, ["proof", "validate", evidence.path]).status, 0);
  const passed = await audit(root, { execute: true });
  assert.equal(passed.level, 4, JSON.stringify(passed, null, 2));
  const old = readFileSync(join(root, "src/domain/greeting.mjs"), "utf8");
  writeFileSync(
    join(root, "src/domain/forbidden.mjs"),
    "import '../application/main.mjs';\n",
  );
  assert.notEqual(invoke(root, ["gate"]).status, 0, "Forbidden dependency must fail");
  rmSync(join(root, "src/domain/forbidden.mjs"));
  const config = readJson(root, "arrs.json");
  config.commands.test = { argv: [process.execPath, "-e", "process.exit(37)"] };
  writeJson(root, "arrs.json", config);
  const failing = invoke(root, ["run", "test"]);
  assert.equal(failing.status, 37, "Underlying exit status must survive");
  writeFileSync(join(root, "src/domain/greeting.mjs"), old);
  console.log(
    "Verified CLI initialization, standard commands, real greeting acceptance, proof integrity, level4 audit, architecture mutation rejection and failure propagation.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
// Exercise the opted-in changeset contract through real CLI/Git interfaces,
// including negative integrity/no-effect cases, under the existing verify argv.
const changeset = spawnSync(process.execPath, ["--test", "tests/changeset.test.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
  timeout: 120000,
});
assert.equal(changeset.status, 0, "Explicit Git changeset behavior must pass");

// Public graph/readiness composition is exercised under the unchanged standard verify binding.
const graph = spawnSync(process.execPath, ["--test", "tests/graph.test.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
  timeout: 120000,
});
assert.equal(graph.status, 0, "Capability graph behavior must pass");
