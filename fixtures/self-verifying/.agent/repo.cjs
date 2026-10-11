#!/usr/bin/env node
"use strict";
// Standalone Node >=22 runner. No package-manager download or shell interpolation.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const COMMANDS = ["setup", "dev", "check", "test", "verify", "build"];
function resolveCommand(config, name, target) {
  if (config.schemaVersion !== "0.1")
    throw new Error("Unsupported arrs.json schemaVersion; expected 0.1.");
  if (!COMMANDS.includes(name))
    throw new Error(`Unknown repo command: ${name}. Use ${COMMANDS.join(", ")}.`);
  if (target && name !== "verify") throw new Error("Only verify accepts a target.");
  const command = target ? config.verifyTargets?.[target] : config.commands?.[name];
  if (!command)
    throw new Error(
      `Configure ${target ? `verifyTargets.${target}` : `commands.${name}`} in arrs.json.`,
    );
  if (
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    command.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !command.argv[0]
  )
    throw new Error(
      "Commands must be nonempty argv arrays of strings without NUL bytes. Shell strings are not supported.",
    );
  if (
    command.timeoutSeconds !== undefined &&
    (!Number.isInteger(command.timeoutSeconds) ||
      command.timeoutSeconds < 1 ||
      command.timeoutSeconds > 3600)
  )
    throw new Error("timeoutSeconds must be an integer from 1 to 3600.");
  return command;
}
const activeCommands = new Set();
let interruption;
function interrupted(signal) {
  interruption = signal;
  for (const stop of activeCommands) stop(signal);
  const forced = setTimeout(() => {
    for (const stop of activeCommands) stop("SIGKILL");
    process.exit(128 + (constants.signals[signal] ?? 1));
  }, 1200);
  forced.unref();
}
const onInterrupt = () => interrupted("SIGINT");
const onTerminate = () => interrupted("SIGTERM");
function spawnArgv(command) {
  if (process.platform === "win32" && /^(npm|npm\.cmd)$/.test(command.argv[0])) {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ];
    const npmCli = candidates.find(
      (candidate) =>
        candidate &&
        path.basename(candidate) === "npm-cli.js" &&
        fs.existsSync(candidate),
    );
    if (!npmCli)
      throw new Error(
        "Cannot locate npm-cli.js; configure a direct node argv command for npm on Windows.",
      );
    return [process.execPath, npmCli, ...command.argv.slice(1)];
  }
  return command.argv;
}
function execute(root, command, options = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "",
      stderr = "",
      truncated = false,
      timedOut = false,
      settled = false;
    const limit = 8 * 1024 * 1024;
    let outputBytes = 0;
    const actualArgv = spawnArgv(command);
    const child = spawn(actualArgv[0], actualArgv.slice(1), {
      cwd: root,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const terminate = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else if (child.pid) {
          const killer = spawn(
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(child.pid), "/t", "/f"],
            { stdio: "ignore", shell: false },
          );
          killer.on("error", () => child.kill(signal));
        }
      } catch {
        /* Child may already have exited. */
      }
    };
    if (activeCommands.size === 0) {
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    }
    activeCommands.add(terminate);
    const escalate = () => {
      if (!escalation) {
        escalation = setTimeout(() => terminate("SIGKILL"), 1000);
        escalation.unref();
      }
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        terminate("SIGTERM");
        escalate();
      },
      (command.timeoutSeconds ?? 300) * 1000,
    );
    let escalation;
    const append = (kind, chunk) => {
      if (truncated) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (outputBytes + bytes <= limit) {
        outputBytes += bytes;
        if (kind === "stdout") stdout += chunk;
        else stderr += chunk;
        if (options.stream)
          (kind === "stdout" ? process.stdout : process.stderr).write(chunk);
      } else {
        truncated = true;
        terminate("SIGTERM");
        escalate();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      activeCommands.delete(terminate);
      if (activeCommands.size === 0) {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
        if (interruption) process.exit(128 + (constants.signals[interruption] ?? 1));
      }
      if (timedOut) stderr += "\nARRS: command timed out.\n";
      if (truncated) stderr += "\nARRS: output exceeded 8 MiB limit.\n";
      resolve({
        argv: [...command.argv],
        exitCode: timedOut ? 124 : truncated ? 125 : exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    };
    child.on("error", (error) => {
      stderr += error.message;
      finish(error.code === "ENOENT" ? 127 : 126);
    });
    child.on("close", (code, signal) => {
      finish(code ?? 128 + (constants.signals[signal] ?? 1));
    });
  });
}
module.exports = { resolveCommand, execute };
if (require.main === module) {
  (async () => {
    const root = __dirname;
    const [name, target, ...extra] = process.argv.slice(2);
    if (!name || name === "--help") {
      console.log("Usage: ./repo setup|dev|check|test|verify [target]|build");
      return;
    }
    if (extra.length)
      throw new Error("Unexpected extra arguments. Configure arguments in arrs.json.");
    const config = JSON.parse(fs.readFileSync(path.join(root, "arrs.json"), "utf8"));
    const result = await execute(root, resolveCommand(config, name, target), {
      stream: true,
    });
    if (result.exitCode && !result.stderr)
      console.error(`ARRS: command exited ${result.exitCode}.`);
    process.exitCode = result.exitCode;
  })().catch((error) => {
    console.error(`ARRS: ${error.message}`);
    process.exitCode = 1;
  });
}
