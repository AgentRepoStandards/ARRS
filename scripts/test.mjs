import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism, constants } from "node:os";
const tests = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `tests/${file}`);
if (!tests.length) throw new Error("No ARRS test suites found.");
// Run the real packed-consumer suite before the other command-heavy suites.
// Every discovered file remains a native Node test suite and runs exactly once.
const concurrency = Math.min(2, availableParallelism());
const packageTests = tests.filter((file) => file === "tests/package.test.mjs");
const remainingTests = tests.filter((file) => file !== "tests/package.test.mjs");
const phases = [];
if (packageTests.length)
  phases.push({
    name: "package",
    files: packageTests,
    argv: ["--test", ...packageTests],
  });
if (remainingTests.length)
  phases.push({
    name: "remaining",
    files: remainingTests,
    argv: ["--test", `--test-concurrency=${concurrency}`, ...remainingTests],
  });

let firstFailure;
for (const phase of phases) {
  // Keep phase metadata on stderr; stdout remains the genuine native reports.
  console.error(
    JSON.stringify({ phase: phase.name, stage: "start", fileCount: phase.files.length }),
  );
  let result;
  try {
    result = spawnSync(process.execPath, phase.argv, { stdio: "inherit" });
  } catch (error) {
    result = { error, status: null, signal: null };
  }
  if (result.error || result.status !== 0 || result.signal) {
    // Attempt later phases after an ordinary failure, retaining the first failure.
    // The caller still owns cancellation and the one configured overall deadline.
    firstFailure ??=
      Number.isInteger(result.status) && result.status !== 0
        ? result.status
        : result.signal
          ? 128 + (constants.signals[result.signal] ?? 1)
          : 1;
    console.error(
      JSON.stringify({
        phase: phase.name,
        stage: "failed",
        status: result.status ?? null,
        signal: result.signal ? String(result.signal).slice(0, 64) : null,
        error: result.error
          ? {
              name: String(result.error.name ?? "Error").slice(0, 64),
              code: String(result.error.code ?? "").slice(0, 64),
              message: String(result.error.message ?? result.error).slice(0, 512),
            }
          : null,
      }),
    );
  }
}
process.exitCode = firstFailure ?? 0;
