import { spawnSync } from "node:child_process";
for (const file of ["src/domain/task.mjs", "src/application/main.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
}
console.log("JavaScript distribution syntax validated");
