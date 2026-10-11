import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
const valid = spawnSync(
  process.execPath,
  ["src/application/main.mjs", " Inspect drift "],
  { encoding: "utf8" },
);
assert.equal(valid.status, 0);
assert.deepEqual(JSON.parse(valid.stdout), { title: "Inspect drift", state: "queued" });
const invalid = spawnSync(process.execPath, ["src/application/main.mjs", " "], {
  encoding: "utf8",
});
assert.equal(invalid.status, 1);
assert.match(invalid.stderr, /required/);
console.log("Task preview CLI acceptance passed");
