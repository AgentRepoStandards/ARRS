import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  rmSync,
  cpSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { tmpdir, constants } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { initRepository } from "../dist/workflows/init.js";
import { checkArchitecture, checkArchitectureGuard } from "../dist/core/architecture.js";
import { scanFeatures, readArchitecture } from "../dist/core/config.js";
import { validate } from "../dist/core/schema.js";
import { makeFixture, invoke, readJson, writeJson } from "./helpers.mjs";

test("CLI initializes empty repository with actionable commands and idempotent preservation", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-init-"));
  try {
    const first = invoke(root, ["init"]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.ok(existsSync(join(root, "repo")));
    const second = invoke(root, ["init"]);
    assert.equal(second.status, 0);
    assert.equal(JSON.parse(second.stdout).created.length, 0);
    const config = readJson(root, "arrs.json");
    assert.equal(config.commands.test, undefined);
    assert.equal(invoke(root, ["doctor"]).status, 1);
    const missing = spawnSync(process.execPath, ["repo", "test"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Configure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("dry run changes nothing and existing conventions/instructions are byte preserved", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-preserve-"));
  try {
    writeFileSync(join(root, "AGENTS.md"), "# Existing policy\nPreserve this exactly.\n");
    writeJson(root, "package.json", {
      scripts: { test: "node --test", check: "eslint .", build: "custom-build" },
    });
    writeFileSync(join(root, "repo"), "user-owned runner");
    const dry = invoke(root, ["init", "--dry-run"]);
    assert.equal(dry.status, 0);
    assert.ok(!existsSync(join(root, "arrs.json")));
    initRepository(root);
    assert.equal(readFileSync(join(root, "repo"), "utf8"), "user-owned runner");
    assert.equal(
      readFileSync(join(root, "AGENTS.md"), "utf8"),
      "# Existing policy\nPreserve this exactly.\n",
    );
    assert.deepEqual(readJson(root, "arrs.json").commands.test.argv, [
      "npm",
      "run",
      "test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("initialized architecture is valid incomplete setup and cannot qualify Level 2", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-architecture-setup-"));
  try {
    initRepository(root);
    const policy = readJson(root, ".agent/policies/architecture.json");
    assert.deepEqual(validate("architecture", policy), []);
    assert.deepEqual(readArchitecture(root).modules, []);
    assert.match(checkArchitecture(root).join(";"), /unconfigured.*architecture\.json/i);
    assert.match(checkArchitectureGuard(root).join(";"), /unconfigured/i);
    const report = JSON.parse(invoke(root, ["audit", "--execute"]).stdout);
    assert.ok(report.level < 2);
    assert.equal(
      report.controls.find((control) => control.id === "architecture").passed,
      false,
    );
    assert.equal(
      report.controls.find((control) => control.id === "architecture-guard").passed,
      false,
    );
    const malformed = { schemaVersion: "0.1", modules: [{ id: "application" }] };
    writeJson(root, ".agent/policies/architecture.json", malformed);
    assert.ok(validate("architecture", malformed).length);
    assert.match(checkArchitecture(root).join(";"), /Invalid architecture/);
    assert.match(checkArchitectureGuard(root).join(";"), /Invalid architecture/);
    assert.ok(validate("architecture", { schemaVersion: "0.1" }).length);
    assert.ok(validate("architecture", { schemaVersion: "0.1", modules: null }).length);
    assert.ok(validate("architecture", { ...policy, hiddenApproval: true }).length);
    const config = readJson(root, "arrs.json");
    config.architecture.policy = ".engineering/boundaries.json";
    writeJson(root, "arrs.json", config);
    writeJson(root, config.architecture.policy, policy);
    assert.match(checkArchitecture(root).join(";"), /\.engineering\/boundaries\.json/);
    assert.match(
      checkArchitectureGuard(root).join(";"),
      /\.engineering\/boundaries\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("initialization preserves existing instructions, knowledge and policies byte-for-byte", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-owned-context-"));
  const paths = [
    "arrs.json",
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
    "docs/architecture/README.md",
    "docs/product/README.md",
    "docs/features/README.md",
    "docs/adr/README.md",
    ".agent/policies/architecture.json",
    ".agent/policies/risk.json",
    ".agent/policies/exceptions.json",
  ];
  try {
    const originals = new Map(
      paths.map((path) => [
        path,
        Buffer.from(`\ufeffUser-owned ${path}\r\nExact content retained.\r\n`),
      ]),
    );
    for (const [path, content] of originals) {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const dry = initRepository(root, true);
    assert.ok(!existsSync(join(root, "repo")));
    const first = initRepository(root);
    const second = initRepository(root);
    for (const [path, content] of originals) {
      assert.deepEqual(readFileSync(join(root, path)), content, path);
      if (
        !["CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"].includes(path)
      ) {
        assert.ok(dry.preserved.includes(path), path);
        assert.ok(first.preserved.includes(path), path);
      }
    }
    assert.deepEqual(second.created, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("initialization locates a sole GitHub workflow without asserting its gate capability", () => {
  for (const extension of ["yml", "yaml"]) {
    const root = mkdtempSync(join(tmpdir(), "arrs-ci-discovery-"));
    try {
      const path = `.github/workflows/quality.${extension}`;
      const content =
        "name: User-owned workflow\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo existing workflow\n";
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      writeFileSync(join(root, path), content);
      const report = initRepository(root);
      assert.equal(readJson(root, "arrs.json").ci.workflow, path);
      assert.ok(report.detected.some((item) => item.includes(path)));
      assert.equal(readFileSync(join(root, path), "utf8"), content);
      const auditReport = JSON.parse(invoke(root, ["audit"]).stdout);
      assert.equal(
        auditReport.controls.find((control) => control.id === "ci").passed,
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("ambiguous or absent workflow discovery requires explicit configuration", () => {
  for (const present of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "arrs-ci-unconfigured-"));
    try {
      if (present) {
        mkdirSync(join(root, ".github/workflows"), { recursive: true });
        writeFileSync(join(root, ".github/workflows/build.yml"), "name: build\n");
        writeFileSync(join(root, ".github/workflows/release.yaml"), "name: release\n");
      }
      const report = initRepository(root);
      assert.equal(readJson(root, "arrs.json").ci.workflow, ".github/workflows/ci.yml");
      assert.ok(report.requirements.some((item) => /configure ci\.workflow/i.test(item)));
      if (present)
        assert.ok(
          report.requirements.some((item) =>
            /Multiple.*build\.yml.*release\.yaml/.test(item),
          ),
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("dry-run initialization of a new directory reports missing CI without writes", () => {
  const parent = mkdtempSync(join(tmpdir(), "arrs-new-target-"));
  const root = join(parent, "new-repository");
  try {
    const report = initRepository(root, true);
    assert.ok(!existsSync(root));
    assert.ok(report.requirements.some((item) => /configure ci\.workflow/i.test(item)));
    assert.ok(!report.requirements.some((item) => /Cannot discover CI/.test(item)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test("workflow discovery never rewrites existing explicit configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-ci-explicit-"));
  try {
    initRepository(root);
    const config = readJson(root, "arrs.json");
    config.ci.workflow = ".github/workflows/operator-selected.yml";
    writeJson(root, "arrs.json", config);
    const original = readFileSync(join(root, "arrs.json"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/sole.yml"), "name: Existing workflow\n");
    initRepository(root);
    assert.deepEqual(readFileSync(join(root, "arrs.json")), original);
    assert.equal(readJson(root, "arrs.json").ci.workflow, config.ci.workflow);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a symlink at the default CI path cannot produce an unsafe generated configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-ci-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "arrs-ci-outside-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(outside, "workflow.yml"), "name: External file\n");
    if (process.platform === "win32")
      symlinkSync(outside, join(root, ".github/workflows/ci.yml"), "junction");
    else
      symlinkSync(join(outside, "workflow.yml"), join(root, ".github/workflows/ci.yml"));
    assert.throws(() => initRepository(root), /symlink/i);
    assert.ok(!existsSync(join(root, "arrs.json")));
    assert.equal(
      readFileSync(join(outside, "workflow.yml"), "utf8"),
      "name: External file\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test(
  "init detects nested parent symlink escape before any generated write",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "arrs-symlink-")),
      outside = mkdtempSync(join(tmpdir(), "arrs-outside-"));
    try {
      symlinkSync(outside, join(root, "docs"), "dir");
      assert.throws(() => initRepository(root), /symlink/i);
      assert.ok(!existsSync(join(root, "arrs.json")));
      assert.ok(!existsSync(join(outside, "architecture")));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
test("standard runner retains exit status and argument values without shell evaluation", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.test = {
      argv: [
        process.execPath,
        "-e",
        "console.log(process.argv[1]);process.exit(23)",
        "$(touch NEVER);literal",
      ],
    };
    writeJson(root, "arrs.json", config);
    const result = spawnSync(process.execPath, ["repo", "test"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 23);
    assert.match(result.stdout, /\$\(touch NEVER\);literal/);
    assert.ok(!existsSync(join(root, "NEVER")));
    const cli = invoke(root, ["run", "test"]);
    assert.equal(cli.status, 23);
    assert.equal(JSON.parse(cli.stdout).exitCode, 23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CLI schema rejects malformed configuration and unknown commands/options", () => {
  const root = makeFixture();
  try {
    writeFileSync(join(root, "arrs.json"), "{broken");
    const audit = invoke(root, ["audit"]);
    assert.equal(JSON.parse(audit.stdout).level, 0);
    assert.equal(invoke(root, ["doctor"]).status, 1);
    assert.equal(invoke(root, ["invalid"]).status, 1);
    assert.equal(invoke(root, ["audit", "--excute"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("standalone runner reports timeout and missing executable", () => {
  const root = makeFixture();
  try {
    const config = readJson(root, "arrs.json");
    config.commands.test = {
      argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
      timeoutSeconds: 1,
    };
    writeJson(root, "arrs.json", config);
    const timeout = spawnSync(process.execPath, ["repo", "test"], {
      cwd: root,
      encoding: "utf8",
      timeout: 6000,
    });
    assert.equal(timeout.status, 124);
    config.commands.test = { argv: ["arrs-nonexistent-executable"] };
    writeJson(root, "arrs.json", config);
    assert.equal(
      spawnSync(process.execPath, ["repo", "test"], { cwd: root }).status,
      127,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function resistantDescendant(root, outputLimit = false) {
  writeFileSync(
    join(root, "descendant.cjs"),
    `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    fs.writeFileSync('descendant.pid', String(process.pid));
    setInterval(() => fs.writeFileSync('heartbeat', String(Date.now())), 20);
    setTimeout(() => process.exit(0), 12000);
  `,
  );
  writeFileSync(
    join(root, "parent.cjs"),
    `
    require('node:child_process').spawn(process.execPath, ['descendant.cjs'], {stdio: 'ignore'});
    const fs = require('node:fs');
    const ready = setInterval(() => {
      if (!fs.existsSync('heartbeat')) return;
      clearInterval(ready);
      ${outputLimit ? "process.stdout.write('x'.repeat(9 * 1024 * 1024));" : ""}
    }, 10);
    setInterval(() => {}, 1000);
  `,
  );
}

async function assertHeartbeatStopped(root) {
  const before = readFileSync(join(root, "heartbeat"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    readFileSync(join(root, "heartbeat"), "utf8"),
    before,
    "No descendant writes after runner completion",
  );
}

function cleanupDescendant(root) {
  if (!existsSync(join(root, "descendant.pid"))) return;
  const pid = Number(readFileSync(join(root, "descendant.pid"), "utf8"));
  try {
    if (process.platform === "win32")
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

for (const interfaceName of ["generated", "cli"]) {
  for (const reason of ["timeout", "output-limit"]) {
    test(`${interfaceName} ${reason} owns resistant descendants until cleanup completes`, async () => {
      const { cli } = await import("./helpers.mjs");
      const root = makeFixture();
      try {
        resistantDescendant(root, reason === "output-limit");
        const config = readJson(root, "arrs.json");
        config.commands.test = {
          argv: [process.execPath, "parent.cjs"],
          timeoutSeconds: 1,
        };
        writeJson(root, "arrs.json", config);
        const args =
          interfaceName === "generated"
            ? ["repo", "test"]
            : [cli, "run", "test", "--root", root];
        const started = Date.now();
        const result = spawnSync(process.execPath, args, {
          cwd: root,
          encoding: "utf8",
          timeout: 8000,
          maxBuffer: 12 * 1024 * 1024,
        });
        assert.equal(result.status, reason === "timeout" ? 124 : 125, result.stderr);
        assert.ok(Date.now() - started < 8000, "Cleanup is bounded");
        await assertHeartbeatStopped(root);
      } finally {
        cleanupDescendant(root);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(
      `${interfaceName} ${signal} waits for resistant-descendant cleanup`,
      { skip: process.platform === "win32" },
      async () => {
        const { spawn } = await import("node:child_process");
        const { once } = await import("node:events");
        const { cli } = await import("./helpers.mjs");
        const root = makeFixture();
        let running;
        try {
          resistantDescendant(root);
          const config = readJson(root, "arrs.json");
          config.commands.test = { argv: [process.execPath, "parent.cjs"] };
          writeJson(root, "arrs.json", config);
          running = spawn(
            process.execPath,
            interfaceName === "generated"
              ? ["repo", "test"]
              : [cli, "run", "test", "--root", root],
            { cwd: root, stdio: "ignore" },
          );
          const exited = once(running, "exit", { signal: AbortSignal.timeout(8000) });
          for (let n = 0; n < 200 && !existsSync(join(root, "heartbeat")); n++)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.ok(
            existsSync(join(root, "heartbeat")),
            "Descendant is running before cancellation",
          );
          running.kill(signal);
          await new Promise((resolve) => setTimeout(resolve, 25));
          running.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
          const [code] = await exited;
          assert.equal(code, 128 + constants.signals[signal]);
          await assertHeartbeatStopped(root);
        } finally {
          running?.kill("SIGKILL");
          cleanupDescendant(root);
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test("new paths beneath filesystem root are computed exactly and root initialization is refused", () => {
  const target =
    process.platform === "win32"
      ? "C:/arrs-path-dry-run-example"
      : "/arrs-path-dry-run-example";
  assert.equal(initRepository(target, true).root, resolve(target));
  assert.throws(
    () => initRepository(process.platform === "win32" ? "C:/" : "/", true),
    /filesystem root/,
  );
});
test("nondirectory parent prevents partial initialization writes", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-file-parent-"));
  try {
    writeFileSync(join(root, "docs"), "existing file");
    assert.throws(() => initRepository(root), /not a directory/);
    assert.ok(!existsSync(join(root, "arrs.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("generated runner supports existing ESM package conventions", () => {
  const root = makeFixture();
  try {
    writeJson(root, "package.json", { type: "module" });
    assert.equal(
      spawnSync(process.execPath, ["repo", "verify", "greet"], { cwd: root }).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  "all Unix signal exits retain their actual signal number",
  { skip: process.platform === "win32" },
  () => {
    const root = makeFixture();
    try {
      const config = readJson(root, "arrs.json");
      config.commands.test = {
        argv: [process.execPath, "-e", 'process.kill(process.pid,"SIGUSR2")'],
      };
      writeJson(root, "arrs.json", config);
      const result = spawnSync(process.execPath, ["repo", "test"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 128 + constants.signals.SIGUSR2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("generated runner executes and preserves failures under explicit CommonJS conventions", () => {
  const root = makeFixture();
  try {
    writeJson(root, "package.json", { type: "commonjs" });
    const config = readJson(root, "arrs.json");
    config.commands.test = {
      argv: [process.execPath, "-e", 'console.log("executed");process.exit(29)'],
    };
    writeJson(root, "arrs.json", config);
    const result = spawnSync(process.execPath, ["repo", "test"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 29);
    assert.match(result.stdout, /executed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "filesystem-root aliases cannot bypass bootstrap root refusal",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "arrs-root-alias-"));
    try {
      symlinkSync("/", join(root, "alias"), "dir");
      assert.throws(() => initRepository(join(root, "alias"), true), /filesystem root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "interrupting the CLI terminates its owned command group",
  { skip: process.platform === "win32" },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { cli } = await import("./helpers.mjs");
    const root = makeFixture();
    let cliProcess;
    let ownedPid;
    try {
      const config = readJson(root, "arrs.json");
      config.commands.test = {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)",
        ],
      };
      writeJson(root, "arrs.json", config);
      cliProcess = spawn(process.execPath, [cli, "run", "test", "--root", root], {
        stdio: "ignore",
      });
      const exited = once(cliProcess, "exit");
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(join(root, "child.pid"));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(join(root, "child.pid")), "Configured command started");
      ownedPid = Number(readFileSync(join(root, "child.pid"), "utf8"));
      cliProcess.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 143);
      assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
    } finally {
      cliProcess?.kill("SIGKILL");
      if (ownedPid)
        try {
          process.kill(-ownedPid, "SIGKILL");
        } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("runner limits decoded Unicode output in bytes and preserves UTF8 across chunks", async () => {
  const { runCommand } = await import("../dist/core/runner.js");
  const root = makeFixture();
  try {
    const capped = await runCommand(root, {
      argv: [process.execPath, "-e", "process.stdout.write('é'.repeat(5*1024*1024))"],
    });
    assert.equal(capped.exitCode, 125);
    assert.ok(Buffer.byteLength(capped.stdout, "utf8") <= 8 * 1024 * 1024);
    const unicode = await runCommand(root, {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])),10)",
      ],
    });
    assert.equal(unicode.exitCode, 0);
    assert.equal(unicode.stdout, "😀");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureTree(root) {
  const entries = [];
  const visit = (path = "") => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path ? `${path}/${entry.name}` : entry.name;
      entries.push([
        file,
        entry.isDirectory()
          ? "directory"
          : readFileSync(join(root, file)).toString("base64"),
      ]);
      if (entry.isDirectory()) visit(file);
    }
  };
  if (existsSync(root)) visit();
  return entries;
}

test("unsupported global flags fail before skills, metrics, work or proof mutations", () => {
  const root = makeFixture(4);
  try {
    writeJson(root, "event.json", {
      schemaVersion: "0.1",
      id: "flag-event",
      task: "flag-task",
      category: "docs",
      risk: "R0",
      scopeSize: 1,
      workflow: { id: "fixture" },
      outcome: {
        firstPassVerification: true,
        humanInterventions: 0,
        reviewRejected: false,
        reverted: false,
        escapedDefects: 0,
        architectureGateFailures: 0,
        verificationCompleteness: 1,
      },
      failureCategories: [],
      recordedAt: new Date().toISOString(),
    });
    rmSync(join(root, ".agent/skills"), { recursive: true });
    for (const args of [
      ["skills", "install", "--dry-run"],
      ["skills", "install", "--execute"],
      ["metrics", "record", "event.json", "--dry-run"],
      [
        "work",
        "transition",
        ".agent/work-items/greeting.json",
        "--to",
        "in-progress",
        "--dry-run",
      ],
      ["proof", "run", "proof-plan.json", "--execute", "--dry-run"],
    ]) {
      const before = fixtureTree(root);
      const result = invoke(root, args);
      assert.equal(result.status, 1, result.stdout);
      const error = JSON.parse(result.stdout).error;
      assert.match(error, /--dry-run|--execute/);
      assert.match(error, /support|appl|only/);
      assert.deepEqual(fixtureTree(root), before, args.join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global action-specific options are rejected on every unrelated command before dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-global-flags-"));
  try {
    const flags = [
      ["--dry-run"],
      ["--execute"],
      ["--require-level", "0"],
      ["--risk", "R0"],
      ["--to", "in-progress"],
      ["--accepted"],
    ];
    const actions = [
      ["init"],
      ["doctor"],
      ["audit"],
      ["run", "test"],
      ["gate"],
      ["validate", "config", "missing.json"],
      ["risk", "missing"],
      ["proof", "run", "missing.json"],
      ["proof", "start", "missing.json"],
      ["proof", "finish", "missing.json"],
      ["proof", "validate", "missing.json"],
      ["proof", "review", "missing.json", "missing-review.json"],
      ["skills", "install"],
      ["metrics", "record", "missing.json"],
      ["metrics", "observe", "missing.json"],
      ["metrics", "summary"],
      ["metrics", "export"],
      ["receipt", "verify", "missing.json"],
      ["receipt", "import", "missing.json"],
      ["receipt", "export", "missing.json"],
      ["gardener"],
      ["work", "validate", "missing.json"],
      ["work", "transition", "missing.json"],
    ];
    const allowed = (args, flag) =>
      (flag === "--dry-run" && args[0] === "init") ||
      (flag === "--execute" &&
        (args[0] === "audit" ||
          (args[0] === "proof" && ["run", "start", "finish"].includes(args[1])))) ||
      (flag === "--require-level" && args[0] === "audit") ||
      (flag === "--risk" &&
        (args[0] === "risk" || (args[0] === "metrics" && args[1] === "summary"))) ||
      (flag === "--to" && args[0] === "work" && args[1] === "transition") ||
      (flag === "--accepted" && args[0] === "proof" && args[1] === "validate");
    for (const args of actions)
      for (const flag of flags) {
        if (allowed(args, flag[0])) continue;
        const before = fixtureTree(root);
        const result = invoke(root, [...flag, ...args]);
        assert.equal(result.status, 1, `${args} ${flag}: ${result.stdout}`);
        assert.ok(JSON.parse(result.stdout).error.includes(flag[0]), result.stdout);
        assert.deepEqual(fixtureTree(root), before);
      }
    const before = fixtureTree(root);
    const filtered = invoke(root, ["metrics", "summary", "--risk", "R0"]);
    assert.equal(filtered.status, 0, filtered.stdout);
    assert.equal(JSON.parse(filtered.stdout).lifecycle.filters.risk, "R0");
    assert.deepEqual(fixtureTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run remains write-free for new and existing destinations and ignored flags cannot run commands", () => {
  const root = makeFixture();
  try {
    const fresh = join(root, "new-destination");
    assert.equal(invoke(root, ["init", "new-destination", "--dry-run"]).status, 0);
    assert.equal(existsSync(fresh), false);
    const before = fixtureTree(root);
    assert.equal(invoke(root, ["init", "--dry-run"]).status, 0);
    assert.deepEqual(fixtureTree(root), before);
    const config = readJson(root, "arrs.json");
    config.commands.test = {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('EXECUTED','yes')",
      ],
    };
    writeJson(root, "arrs.json", config);
    for (const flag of [
      ["--dry-run"],
      ["--execute"],
      ["--require-level", "0"],
      ["--risk", "R0"],
      ["--to", "completed"],
    ]) {
      const result = invoke(root, ["run", "test", ...flag]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(existsSync(join(root, "EXECUTED")), false);
    }
    assert.equal(invoke(root, ["run", "test"]).status, 0);
    assert.equal(existsSync(join(root, "EXECUTED")), true);
    assert.equal(invoke(root, ["audit", "--require-level", "0"]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization protects evidence against root negations while preserving existing ignore bytes", () => {
  for (const ignore of [".arrs/\n!.arrs/\n", ".arrs/\r\n!.arrs/", ".arrs/"]) {
    const root = mkdtempSync(join(tmpdir(), "arrs-ignore-"));
    try {
      assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
      writeFileSync(join(root, ".gitignore"), ignore);
      const before = fixtureTree(root);
      assert.equal(invoke(root, ["init", "--dry-run"]).status, 0);
      assert.deepEqual(fixtureTree(root), before);
      assert.equal(invoke(root, ["init"]).status, 0);
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), ignore);
      assert.equal(
        readFileSync(join(root, ".arrs/.gitignore"), "utf8"),
        "*\n!.gitignore\n",
      );
      mkdirSync(join(root, ".arrs/evidence"), { recursive: true });
      writeFileSync(join(root, ".arrs/evidence/review.log"), "fixture");
      assert.equal(
        spawnSync(
          "git",
          ["check-ignore", "--no-index", "--quiet", "--", ".arrs/evidence/review.log"],
          { cwd: root },
        ).status,
        0,
      );
      const installed = fixtureTree(root);
      assert.equal(invoke(root, ["init"]).status, 0);
      assert.deepEqual(fixtureTree(root), installed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("existing scoped ignore conventions stay intact and unsafe protection is actionable", () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-existing-ignore-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    writeFileSync(join(root, ".gitignore"), ".arrs/\n!.arrs/\n");
    mkdirSync(join(root, ".arrs"));
    const unsafe = "*\n!evidence/\n";
    writeFileSync(join(root, ".arrs/.gitignore"), unsafe);
    const init = invoke(root, ["init"]);
    assert.equal(init.status, 0, init.stdout);
    assert.equal(readFileSync(join(root, ".arrs/.gitignore"), "utf8"), unsafe);
    assert.ok(
      JSON.parse(init.stdout).requirements.some((text) =>
        /ignor.*evidence|evidence.*ignor/i.test(text),
      ),
      init.stdout,
    );
    // Git can treat the missing destination as a file; verify the existing directory.
    mkdirSync(join(root, ".arrs/evidence"));
    assert.equal(
      spawnSync(
        "git",
        ["check-ignore", "--no-index", "--quiet", "--", ".arrs/evidence"],
        { cwd: root },
      ).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Adoption runs through the same packaged public CLI entry point as initialization.
const adoptionInput = () => ({
  schemaVersion: "0.1",
  id: "report-export",
  goal: "Operators receive a reviewed export with stable formatting.",
  owners: ["application"],
  entryPoints: ["src/application/main.mjs"],
  implementation: ["src/application"],
  boundaries: ["application"],
  dependencies: ["greeting"],
  domainTerms: ["Report"],
  invariants: ["Existing application behavior is preserved."],
  sensitivity: "internal",
  acceptance: ["Exports the configured report"],
  verification: {
    target: "reports",
    command: { argv: [process.execPath, "verify.mjs"] },
  },
  risk: "R2",
  related: ["docs/product/README.md"],
  tests: ["test.mjs"],
});
function adoptionFixture() {
  const root = makeFixture(3);
  writeFileSync(
    join(root, "src/application/AGENTS.md"),
    "# Report guidance\nUse established acceptance scenarios and preserve the module public interface.\n",
  );
  writeJson(root, "package.json", {
    scripts: {
      typecheck: "node -e \"require('fs').writeFileSync('SENTINEL','ran')\"",
      "test:unit": "node --test test.mjs",
      "test:acceptance": "node verify.mjs",
    },
  });
  writeFileSync(join(root, "package-lock.json"), "user-owned lock bytes\n");
  writeJson(root, ".agent/adoption/report-export.json", adoptionInput());
  return root;
}
const adoptionPlan = (root, extra = []) =>
  invoke(root, ["adopt", "plan", ".agent/adoption/report-export.json", ...extra]);
function retainAdoptionBaseline(root) {
  const source = mkdtempSync(join(tmpdir(), "arrs-adoption-baseline-"));
  cpSync(root, source, { recursive: true });
  const result = invoke(root, ["baseline", "inspect", source]);
  assert.equal(result.status, 0, result.stdout);
  const selection = JSON.parse(result.stdout).selection;
  return {
    source,
    flags: ["--baseline", selection.root, "--baseline-sha256", selection.sha256],
  };
}
function prepareAdoption(root) {
  const baseline = retainAdoptionBaseline(root);
  const result = adoptionPlan(root, ["--output", ".arrs/adoption/report-export"]);
  assert.equal(result.status, 0, result.stdout);
  const planned = JSON.parse(result.stdout);
  assert.equal(planned.status, "ready-for-review", result.stdout);
  assert.match(
    readFileSync(join(root, planned.output.patch), "utf8"),
    /diff --arrs docs\/features\/report-export.json/,
  );
  writeJson(root, ".agent/adoption/authorization.json", {
    schemaVersion: "0.1",
    proposalSha256: planned.output.sha256,
    humanApproval:
      "Fixture maintainer authorizes application of the reviewed exact proposal bytes; implementation acceptance remains pending.",
  });
  return {
    ...baseline,
    planned,
    args: [
      "adopt",
      "apply",
      planned.output.proposal,
      "--authorization",
      ".agent/adoption/authorization.json",
      ...baseline.flags,
    ],
  };
}
function snapshotRepository(root) {
  const bytes = {};
  const visit = (path) => {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      if ([".arrs", ".git", "node_modules"].includes(item.name) && !path) continue;
      const name = path ? `${path}/${item.name}` : item.name;
      if (item.isDirectory()) visit(name);
      else if (item.isFile())
        bytes[name] = readFileSync(join(root, name)).toString("base64");
    }
  };
  visit("");
  return bytes;
}

test("guided adoption plans deterministic exact-byte integration with provenance and no effects", () => {
  const root = adoptionFixture();
  try {
    const before = snapshotRepository(root);
    const first = adoptionPlan(root),
      second = adoptionPlan(root);
    assert.equal(first.status, 0, first.stdout);
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(snapshotRepository(root), before);
    assert.equal(existsSync(join(root, "SENTINEL")), false);
    const proposal = JSON.parse(first.stdout);
    assert.equal(proposal.status, "ready-for-review");
    assert.equal(
      proposal.operations.filter((item) => item.path.endsWith("report-export.json"))
        .length,
      1,
    );
    assert.deepEqual(
      proposal.operations.map((item) => item.path),
      ["arrs.json", "docs/features/report-export.json"],
    );
    const map = JSON.parse(
      Buffer.from(proposal.operations[1].replacement.bytesBase64, "base64"),
    );
    assert.deepEqual(validate("feature", map), []);
    assert.ok(map.related.includes("src/application/AGENTS.md"));
    assert.ok(
      proposal.discovery.some(
        (item) =>
          item.source === "package.json#/scripts/typecheck" && item.supplied === false,
      ),
    );
    assert.equal(proposal.input.acceptance[0], "Exports the configured report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption retains missing facts and ambiguous scripts as actionable blockers", () => {
  const root = adoptionFixture();
  try {
    const input = adoptionInput();
    delete input.verification;
    delete input.acceptance;
    input.owners = ["unknown-owner"];
    input.entryPoints = ["src/missing.mjs"];
    writeFileSync(join(root, "src/application/reports.py"), "print('unsupported')\n");
    writeJson(root, ".agent/adoption/report-export.json", input);
    const result = adoptionPlan(root);
    assert.equal(result.status, 0, result.stdout);
    const proposal = JSON.parse(result.stdout);
    assert.equal(proposal.status, "blocked");
    for (const code of [
      "missing-acceptance",
      "unknown-owner",
      "missing-path",
      "unsupported-architecture",
      "verification-decision",
    ])
      assert.ok(
        proposal.blockers.some((item) => item.code === code),
        code,
      );
    const decision = proposal.blockers.find(
      (item) => item.code === "verification-decision",
    );
    assert.match(decision.message, /test:unit/);
    assert.match(decision.message, /test:acceptance/);
    assert.equal(
      proposal.operations.some((item) => item.path === "arrs.json"),
      false,
    );
    assert.equal(existsSync(join(root, "SENTINEL")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption applies only reviewed paths, preserves modes and bytes, and remains configured without proof", () => {
  const root = adoptionFixture();
  let source;
  try {
    const prepared = prepareAdoption(root);
    source = prepared.source;
    const configPath = join(root, "arrs.json"),
      originalMode = lstatSync(configPath).mode & 0o7777;
    chmodSync(configPath, 0o444);
    try {
      assert.notEqual(lstatSync(configPath).mode & 0o7777, originalMode);
      // Removing the write bit must make the reviewed mode stale on every platform.
      assert.equal(invoke(root, prepared.args).status, 1);
    } finally {
      chmodSync(configPath, originalMode);
    }
    const before = snapshotRepository(root),
      configBefore = readFileSync(join(root, "arrs.json"), "utf8");
    const result = invoke(root, prepared.args);
    assert.equal(result.status, 0, result.stdout);
    const application = JSON.parse(result.stdout);
    assert.equal(application.status, "configured");
    assert.equal(application.accepted, false);
    assert.equal(application.behavioralProof, "not-evaluated");
    const after = snapshotRepository(root);
    for (const [path, bytes] of Object.entries(before))
      if (path !== "arrs.json") assert.equal(after[path], bytes, path);
    assert.deepEqual(
      readJson(root, "arrs.json").commands,
      JSON.parse(configBefore).commands,
    );
    assert.equal(
      lstatSync(join(root, "arrs.json")).mode & 0o7777,
      prepared.planned.operations[0].expected.mode,
    );
    const inserted = readFileSync(join(root, "arrs.json"), "utf8");
    const oldOperation = prepared.planned.operations[0],
      newBytes = Buffer.from(oldOperation.replacement.bytesBase64, "base64").toString();
    assert.equal(inserted, newBytes);
    const journal = readJson(root, application.recovery);
    assert.equal(journal.status, "applied");
    assert.equal(
      Buffer.from(journal.operations[0].expected.bytesBase64, "base64").toString(),
      configBefore,
    );
    assert.deepEqual(scanFeatures(root).errors, []);
    assert.equal(existsSync(join(root, "SENTINEL")), false);
    const audit = JSON.parse(invoke(root, ["audit"]).stdout);
    assert.equal(
      audit.controls.find((item) => item.id === "check-executed").status,
      "not-evaluated",
    );
    assert.equal(
      audit.controls.find((item) => item.id === "proof-evidence").passed,
      false,
    );
    const second = invoke(root, prepared.args);
    assert.equal(second.status, 1);
    assert.match(JSON.parse(second.stdout).error, /Stale|stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (source) rmSync(source, { recursive: true, force: true });
  }
});

test("adoption rejects stale paths, input edits, duplicated targets and tampering before every effect", () => {
  for (const attack of [
    "source",
    "input",
    "duplicate",
    "replacement",
    "blocker",
    "snapshot",
    "version",
    "approval-looking",
    "traversal",
    "absolute",
    "reserved",
  ]) {
    const root = adoptionFixture();
    let source;
    try {
      const prepared = prepareAdoption(root);
      source = prepared.source;
      const path = prepared.planned.output.proposal,
        proposal = readJson(root, path);
      if (attack === "source")
        writeFileSync(join(root, "src/application/main.mjs"), "changed source\n");
      else if (attack === "input") {
        const input = adoptionInput();
        input.acceptance = ["Changed behavior"];
        writeJson(root, ".agent/adoption/report-export.json", input);
      } else {
        if (attack === "duplicate") proposal.operations.push(proposal.operations[0]);
        if (attack === "replacement")
          proposal.operations[0].replacement.bytesBase64 = Buffer.from(
            "malicious replacement",
          ).toString("base64");
        if (attack === "blocker")
          proposal.blockers.push({
            code: "unresolved",
            message: "Decision required",
            remediation: "Resolve explicitly",
          });
        if (attack === "snapshot") proposal.snapshots[0].sha256 = "0".repeat(64);
        if (attack === "version") proposal.schemaVersion = "0.2";
        if (attack === "approval-looking")
          proposal.authorization = { humanApproval: "self-authorized" };
        if (attack === "traversal") proposal.operations[0].path = "docs/../outside.json";
        if (attack === "absolute")
          proposal.operations[0].path = join(root, "outside.json");
        if (attack === "reserved") proposal.operations[0].path = "./.arrs//injected.json";
        writeJson(root, path, proposal);
      }
      const before = snapshotRepository(root),
        outputBefore = readdirSync(join(root, ".arrs/adoption"));
      const result = invoke(root, prepared.args);
      assert.equal(result.status, 1, attack);
      assert.ok(JSON.parse(result.stdout).error, attack);
      assert.deepEqual(snapshotRepository(root), before, attack);
      assert.deepEqual(readdirSync(join(root, ".arrs/adoption")), outputBefore, attack);
      assert.equal(existsSync(join(root, "SENTINEL")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (source) rmSync(source, { recursive: true, force: true });
    }
  }
});

test("adoption output and paths reject symlinks, normalization aliases and unsafe ignore state", () => {
  const root = adoptionFixture();
  const outside = mkdtempSync(join(tmpdir(), "arrs-adopt-outside-"));
  try {
    for (const output of [
      ".arrs",
      "./.arrs/adoption/alias",
      ".arrs//adoption/alias",
      ".arrs/adoption/../alias",
      "docs/output",
      ".arrs/evidence/report",
      join(root, ".arrs/adoption/absolute"),
    ]) {
      const result = adoptionPlan(root, ["--output", output]);
      assert.equal(result.status, 1, output);
      assert.ok(JSON.parse(result.stdout).error);
      assert.equal(existsSync(join(root, ".arrs/adoption")), false);
    }
    symlinkSync(outside, join(root, ".arrs/adoption"), "dir");
    assert.equal(adoptionPlan(root, ["--output", ".arrs/adoption/escape"]).status, 1);
    rmSync(join(root, ".arrs/adoption"));
    symlinkSync(outside, join(root, "source-alias"), "dir");
    const input = adoptionInput();
    input.entryPoints = ["source-alias/file.mjs"];
    writeJson(root, ".agent/adoption/report-export.json", input);
    assert.equal(adoptionPlan(root).status, 1);
    writeJson(root, ".agent/adoption/report-export.json", adoptionInput());
    writeFileSync(join(root, ".arrs/.gitignore"), "*\n!adoption/\n");
    const result = adoptionPlan(root, ["--output", ".arrs/adoption/unsafe"]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /ignore|protection|marker/i);
    assert.equal(existsSync(join(root, ".arrs/adoption")), false);
    assert.equal(readdirSync(outside).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("adoption schema versions and action flag applicability fail with one JSON error and no effects", () => {
  const root = adoptionFixture();
  try {
    for (const args of [
      ["adopt", "plan", ".agent/adoption/report-export.json", "--execute"],
      ["adopt", "plan", ".agent/adoption/report-export.json", "--authorization", "fake"],
      ["adopt", "apply", "fake", "--output", ".arrs/adoption/fake"],
      ["adopt", "apply", "fake", "--dry-run"],
      ["adopt", "plan", ".agent/adoption/report-export.json", "--unknown"],
      ["adopt", "unknown", "fake"],
    ]) {
      const before = snapshotRepository(root);
      const result = invoke(root, args);
      assert.equal(result.status, 1);
      assert.ok(JSON.parse(result.stdout).error);
      assert.deepEqual(snapshotRepository(root), before);
    }
    const input = adoptionInput();
    input.schemaVersion = "0.2";
    writeJson(root, ".agent/adoption/report-export.json", input);
    const result = adoptionPlan(root);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /schemaVersion/);
    assert.equal(existsSync(join(root, "SENTINEL")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption proposals cannot authorize governing-control edits or select their own baseline", () => {
  const root = adoptionFixture();
  let source;
  try {
    const prepared = prepareAdoption(root);
    source = prepared.source;
    const before = snapshotRepository(root);
    for (const args of [
      ["adopt", "apply", prepared.planned.output.proposal],
      ["adopt", "apply", prepared.planned.output.proposal, ...prepared.flags],
      [
        "adopt",
        "apply",
        prepared.planned.output.proposal,
        "--authorization",
        prepared.planned.output.proposal,
        ...prepared.flags,
      ],
    ]) {
      const result = invoke(root, args);
      assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stdout).error, /authorization|baseline|controls/);
      assert.deepEqual(snapshotRepository(root), before);
    }
    const auth = readJson(root, ".agent/adoption/authorization.json");
    auth.proposalSha256 = "0".repeat(64);
    writeJson(root, ".agent/adoption/authorization.json", auth);
    const result = invoke(root, prepared.args);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /bind/);
    assert.equal(existsSync(join(root, "docs/features/report-export.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (source) rmSync(source, { recursive: true, force: true });
  }
});

test("adoption appends explicit module and sensitive decisions while preserving all existing policy bytes", () => {
  const root = adoptionFixture();
  let source;
  try {
    mkdirSync(join(root, "src/reports"));
    writeFileSync(
      join(root, "src/reports/export.mjs"),
      "export const report = () => 'columns';\n",
    );
    const input = adoptionInput();
    input.owners = ["reports"];
    input.boundaries = ["reports"];
    input.entryPoints = ["src/reports/export.mjs"];
    input.implementation = ["src/reports"];
    input.architecture = {
      modules: [
        {
          id: "reports",
          path: "src/reports",
          allows: [],
          public: ["src/reports/export.mjs"],
        },
      ],
    };
    input.sensitivity = "sensitive";
    input.risk = "R3";
    const existingRisk = readJson(root, ".agent/policies/risk.json");
    existingRisk.sensitivePaths.push({
      path: ".",
      risk: "R3",
      reason: "Existing repository-wide sensitive floor.",
    });
    writeJson(root, ".agent/policies/risk.json", existingRisk);
    input.sensitivePaths = [
      {
        path: "src/reports",
        risk: "R3",
        reason: "Maintainer identifies private report content.",
      },
    ];
    writeJson(root, ".agent/adoption/report-export.json", input);
    const prepared = prepareAdoption(root);
    source = prepared.source;
    assert.deepEqual(
      prepared.planned.operations.map((item) => item.path),
      [
        ".agent/policies/architecture.json",
        ".agent/policies/risk.json",
        "arrs.json",
        "docs/features/report-export.json",
      ],
    );
    const policies = [
      ".agent/policies/architecture.json",
      ".agent/policies/risk.json",
    ].map((path) => [path, readJson(root, path)]);
    const result = invoke(root, prepared.args);
    assert.equal(result.status, 0, result.stdout);
    for (const [path, before] of policies) {
      const after = readJson(root, path);
      if (path.includes("architecture"))
        assert.deepEqual(after.modules.slice(0, before.modules.length), before.modules);
      else {
        assert.deepEqual(after.classes, before.classes);
        assert.deepEqual(
          after.sensitivePaths.slice(0, before.sensitivePaths.length),
          before.sensitivePaths,
        );
      }
      const op = prepared.planned.operations.find((item) => item.path === path);
      const original = Buffer.from(op.expected.bytesBase64, "base64").toString();
      const replacement = Buffer.from(op.replacement.bytesBase64, "base64").toString();
      // Integration is a single insertion; removing that insertion recovers every existing byte.
      let index = 0;
      while (index < original.length && original[index] === replacement[index]) index++;
      const extra = replacement.length - original.length;
      assert.equal(
        replacement.slice(0, index) + replacement.slice(index + extra),
        original,
      );
    }
    assert.deepEqual(scanFeatures(root).errors, []);
    assert.deepEqual(checkArchitecture(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (source) rmSync(source, { recursive: true, force: true });
  }
});

test("adoption reports rollback and partial writes with retained originals through the CLI", () => {
  for (const intervening of [false, true]) {
    const root = adoptionFixture();
    let source;
    try {
      const prepared = prepareAdoption(root);
      source = prepared.source;
      const before = readFileSync(join(root, "arrs.json"));
      const injection = join(root, ".arrs/fault-injection.mjs");
      writeFileSync(
        injection,
        `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.writeFileSync; fs.writeFileSync=function(path,...args) { if (String(path) === ${JSON.stringify(join(root, "docs/features/report-export.json"))}) { ${intervening ? `original.call(this,${JSON.stringify(join(root, "arrs.json"))},'intervening maintainer bytes\\n');` : ""} const error=new Error('fixture simulated write failure'); error.code='EIO'; throw error; } return original.call(this,path,...args); }; syncBuiltinESMExports();\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(injection).href,
          resolve("dist/cli.js"),
          ...prepared.args,
          "--root",
          root,
          "--json",
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      assert.equal(result.status, 1, result.stdout);
      const error = JSON.parse(result.stdout).error;
      assert.match(error, intervening ? /partial-write/ : /rolled-back/);
      const recoveryPath =
        /Recovery: ([^.]*\.arrs\/adoption\/recovery-[^ ]+\/recovery\.json)/.exec(
          error,
        )?.[1] ??
        /Recovery: (\.arrs\/adoption\/recovery-[^ ]+\/recovery\.json)/.exec(error)?.[1];
      assert.ok(recoveryPath, error);
      const journal = readJson(root, recoveryPath);
      assert.equal(journal.status, intervening ? "partial-write" : "rolled-back");
      assert.deepEqual(
        Buffer.from(journal.operations[0].expected.bytesBase64, "base64"),
        before,
      );
      assert.deepEqual(journal.applied, ["arrs.json"]);
      assert.equal(existsSync(join(root, "docs/features/report-export.json")), false);
      if (intervening) {
        assert.equal(
          readFileSync(join(root, "arrs.json"), "utf8"),
          "intervening maintainer bytes\n",
        );
        assert.equal(journal.rollbackErrors.length, 1);
      } else {
        assert.deepEqual(readFileSync(join(root, "arrs.json")), before);
        assert.equal(journal.rollbackErrors.length, 0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (source) rmSync(source, { recursive: true, force: true });
    }
  }
});

test("adoption accepts an existing declared repository-root module without permitting root source scope", () => {
  const root = adoptionFixture();
  try {
    writeJson(root, ".agent/policies/architecture.json", {
      schemaVersion: "0.1",
      modules: [
        {
          id: "repository",
          path: ".",
          allows: [],
          public: ["src/application/main.mjs", "src/domain/greeting.mjs"],
        },
      ],
    });
    const old = readJson(root, "docs/features/greeting.json");
    old.owners = ["repository"];
    old.boundaries = ["repository"];
    writeJson(root, "docs/features/greeting.json", old);
    const input = adoptionInput();
    input.owners = ["repository"];
    input.boundaries = ["repository"];
    input.verification = { target: "greet" };
    writeJson(root, ".agent/adoption/report-export.json", input);
    const planned = adoptionPlan(root, ["--output", ".arrs/adoption/root-module"]);
    assert.equal(planned.status, 0, planned.stdout);
    const proposal = JSON.parse(planned.stdout);
    assert.equal(proposal.status, "ready-for-review", planned.stdout);
    assert.deepEqual(
      proposal.operations.map((item) => item.path),
      ["docs/features/report-export.json"],
    );
    const applied = invoke(root, ["adopt", "apply", proposal.output.proposal]);
    assert.equal(applied.status, 0, applied.stdout);
    assert.deepEqual(scanFeatures(root).errors, []);
    input.implementation = ["."];
    writeJson(root, ".agent/adoption/report-export.json", input);
    assert.equal(adoptionPlan(root).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption rejects semantically invalid proposed sensitive rules and duplicate module/rule decisions", () => {
  const root = adoptionFixture();
  try {
    for (const minimum of ["R0", "R1", "R2"]) {
      const input = adoptionInput();
      input.sensitivePaths = [
        { path: "src/application", risk: minimum, reason: "Explicit sensitive path" },
      ];
      writeJson(root, ".agent/adoption/report-export.json", input);
      const before = snapshotRepository(root),
        result = adoptionPlan(root, ["--output", `.arrs/adoption/invalid-${minimum}`]);
      assert.equal(result.status, 0, result.stdout);
      const proposal = JSON.parse(result.stdout);
      assert.equal(proposal.status, "blocked");
      assert.ok(proposal.blockers.some((item) => item.code === "invalid-sensitive-rule"));
      assert.equal(invoke(root, ["adopt", "apply", proposal.output.proposal]).status, 1);
      assert.deepEqual(snapshotRepository(root), before);
    }
    const input = adoptionInput();
    input.sensitivePaths = [
      { path: "src/application", risk: "R3", reason: "First decision" },
      { path: "./src/application", risk: "R4", reason: "Ambiguous second decision" },
    ];
    input.architecture = {
      modules: [
        {
          id: "application",
          path: "src/application",
          allows: [],
          public: ["src/application/main.mjs"],
        },
      ],
    };
    writeJson(root, ".agent/adoption/report-export.json", input);
    const proposal = JSON.parse(adoptionPlan(root).stdout);
    assert.equal(proposal.status, "blocked");
    assert.ok(proposal.blockers.some((item) => item.code === "module-conflict"));
    assert.ok(proposal.blockers.some((item) => item.code === "sensitive-conflict"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption prefix-then-throw file failures remain explicit partial writes with retained absence", () => {
  const root = adoptionFixture();
  let source;
  try {
    const prepared = prepareAdoption(root);
    source = prepared.source;
    const originalConfig = readFileSync(join(root, "arrs.json"));
    const injection = join(root, ".arrs/prefix-failure.mjs");
    writeFileSync(
      injection,
      `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.writeFileSync; fs.writeFileSync=function(path,bytes,...args) { if (String(path) === ${JSON.stringify(join(root, "docs/features/report-export.json"))}) { original.call(this,path,Buffer.from(bytes).subarray(0,12),...args); const error=new Error('prefix written then ENOSPC'); error.code='ENOSPC'; throw error; } return original.call(this,path,bytes,...args); }; syncBuiltinESMExports();\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(injection).href,
        resolve("dist/cli.js"),
        ...prepared.args,
        "--root",
        root,
        "--json",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stdout).error;
    assert.match(error, /partial-write/);
    assert.match(error, /docs\/features\/report-export.json/);
    const recoveryPath =
      /Recovery: (\.arrs\/adoption\/recovery-[^ ]+\/recovery\.json)/.exec(error)?.[1];
    const journal = readJson(root, recoveryPath);
    assert.equal(journal.status, "partial-write");
    assert.equal(journal.rollbackErrors.length, 1);
    assert.deepEqual(journal.attempted, [
      "arrs.json",
      "docs/features/report-export.json",
    ]);
    assert.equal(journal.operations[1].expected, null);
    assert.deepEqual(readFileSync(join(root, "arrs.json")), originalConfig);
    assert.equal(readFileSync(join(root, "docs/features/report-export.json")).length, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (source) rmSync(source, { recursive: true, force: true });
  }
});
