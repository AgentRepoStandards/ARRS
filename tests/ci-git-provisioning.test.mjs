import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGit } from "../.github/scripts/setup-git.mjs";

function fixture(t) {
  const runnerTemp = mkdtempSync(join(tmpdir(), "arrs-git-setup-contract-"));
  t.after(() => rmSync(runnerTemp, { recursive: true, force: true }));
  const payload = Buffer.from("isolated archive fixture");
  return {
    platform: "win32",
    arch: "x64",
    runnerTemp,
    pathFile: join(runnerTemp, "github-path"),
    artifact: {
      platform: "win32",
      url: "https://example.invalid/archive.zip",
      archive: "fixture.zip",
      sha256: createHash("sha256").update(payload).digest("hex"),
      version: "git version 2.52.0.windows.1",
    },
    downloadArchive: async () => payload,
  };
}

test("damaged archive stops before any extraction or installer execution", async (t) => {
  const setup = fixture(t);
  let executions = 0;
  await assert.rejects(
    provisionGit({
      ...setup,
      downloadArchive: async () => Buffer.from("damaged archive"),
      run: () => {
        executions++;
        return { status: 0, stdout: "" };
      },
    }),
    /SHA-256 mismatch/,
  );
  assert.equal(executions, 0);
  assert.equal(existsSync(setup.pathFile), false);
});

test("failed extraction cannot publish a Git path or continue to version checks", async (t) => {
  const setup = fixture(t);
  const commands = [];
  await assert.rejects(
    provisionGit({
      ...setup,
      run: (file) => {
        commands.push(file);
        return { status: 17, stdout: "" };
      },
    }),
    /powershell.exe failed \(17\)/,
  );
  assert.deepEqual(commands, ["powershell.exe"]);
  assert.equal(existsSync(setup.pathFile), false);
});

test("incorrect installed Git version fails before publishing PATH", async (t) => {
  const setup = fixture(t);
  let commands = 0;
  await assert.rejects(
    provisionGit({
      ...setup,
      run: () => {
        commands++;
        return { status: 0, stdout: "git version 2.55.0.windows.5\n" };
      },
    }),
    /Installed Git version mismatch/,
  );
  assert.equal(commands, 2);
  assert.equal(existsSync(setup.pathFile), false);
});

test("a different PATH-selected Git cannot be published even if the installed binary matches", async (t) => {
  const setup = fixture(t);
  let commands = 0;
  await assert.rejects(
    provisionGit({
      ...setup,
      run: () => {
        commands++;
        return {
          status: 0,
          stdout: commands === 2 ? setup.artifact.version : "git version 2.55.0\n",
        };
      },
    }),
    /PATH resolves unsupported Git/,
  );
  assert.equal(existsSync(setup.pathFile), false);
});

test("missing native remote-ext capability cannot publish the pinned Git", async (t) => {
  const setup = fixture(t);
  await assert.rejects(
    provisionGit({
      ...setup,
      run: (_file, args) =>
        args[0] === "remote-ext"
          ? { status: 1, stderr: "unknown command" }
          : { status: 0, stdout: setup.artifact.version },
    }),
    /lacks the required native remote-ext helper/,
  );
  assert.equal(existsSync(setup.pathFile), false);
});

test("a damaged bundled shell cannot publish the pinned Git", async (t) => {
  const setup = fixture(t);
  await assert.rejects(
    provisionGit({
      ...setup,
      run: (_file, args) =>
        args[0] === "remote-ext"
          ? { status: 129, stderr: "usage: git remote-ext <remote> <url>" }
          : args[0] === "-c"
            ? { status: 23 }
            : { status: 0, stdout: setup.artifact.version },
    }),
    /sh.exe failed \(23\)/,
  );
  assert.equal(existsSync(setup.pathFile), false);
});
