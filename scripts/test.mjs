import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism, constants } from "node:os";
const tests = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `tests/${file}`);
if (!tests.length) throw new Error("No ARRS test suites found.");
// Node isolates each suite in its own process; fixtures use unique temporary roots.
// Bound parallel suites to two so command-heavy tests leave capacity for their children.
const concurrency = Math.min(2, availableParallelism());
const result = spawnSync(
  process.execPath,
  ["--test", `--test-concurrency=${concurrency}`, ...tests],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 128 + (constants.signals[result.signal] ?? 1);
