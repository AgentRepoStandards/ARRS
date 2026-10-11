import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { packageRoot, makeFixture, writeJson, readJson } from "./helpers.mjs";

function npmProcessDiagnostic(stage, result, startedAt) {
  return JSON.stringify(
    {
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      timeoutMs: 60000,
      status: result.status,
      signal: result.signal,
      error: result.error
        ? {
            name: result.error.name,
            message: result.error.message,
            code: result.error.code,
            errno: result.error.errno,
            syscall: result.error.syscall,
          }
        : null,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  );
}

test("packed install excludes development dependencies and retains executable schemas, docs, local MCP and offline skills", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "arrs-package-"));
  try {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "Run package integration through npm test so npm_cli is known");
    const packStartedAt = performance.now();
    const pack = spawnSync(
      process.execPath,
      [npmCli, "pack", "--ignore-scripts", "--pack-destination", root, "--json"],
      { cwd: packageRoot, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(pack.status, 0, npmProcessDiagnostic("npm pack", pack, packStartedAt));
    const packed = JSON.parse(pack.stdout)[0];
    const tarball = join(root, packed.filename);
    const installed = join(root, "installation");
    const manifest = readJson(packageRoot, "package.json");
    const qualifiedLock = readJson(packageRoot, "package-lock.json");
    assert.equal(qualifiedLock.lockfileVersion, 3);
    const declaredFields = [
      "name",
      "version",
      "license",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "engines",
      "bin",
    ];
    const lockedRoot = qualifiedLock.packages[""];
    for (const field of declaredFields)
      assert.deepEqual(
        lockedRoot[field],
        manifest[field],
        `Qualified root field: ${field}`,
      );
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    assert.ok(!manifest.workspaces && !manifest.overrides);
    assert.ok(!manifest.bundleDependencies && !manifest.bundledDependencies);
    const runtimeEntries = Object.entries(qualifiedLock.packages).filter(
      ([location, entry]) => location && !entry.dev,
    );
    for (const [location, entry] of runtimeEntries) {
      assert.ok(
        location.startsWith("node_modules/") && !location.split("/").includes(".."),
      );
      assert.ok(
        !entry.link &&
          !entry.inBundle &&
          !entry.optional &&
          !entry.devOptional &&
          !entry.os &&
          !entry.cpu &&
          !entry.libc,
        `Locked consumer requires an unconditional registry graph: ${location}`,
      );
      for (const field of ["version", "resolved", "integrity"])
        assert.equal(typeof entry[field], "string", `Qualified ${location} ${field}`);
    }
    const integrity = `sha512-${createHash("sha512")
      .update(readFileSync(tarball))
      .digest("base64")}`;
    assert.equal(integrity, packed.integrity);
    const tarballSpec = `file:${relative(installed, tarball).split(sep).join("/")}`;
    const consumer = {
      name: "arrs-packed-consumer",
      version: "0.0.0",
      private: true,
      dependencies: { [manifest.name]: tarballSpec },
    };
    const packedEntry = structuredClone(lockedRoot);
    delete packedEntry.name;
    delete packedEntry.devDependencies;
    const packages = {
      "": {
        name: consumer.name,
        version: consumer.version,
        dependencies: consumer.dependencies,
      },
      ...Object.fromEntries(runtimeEntries),
    };
    const packedLocation = `node_modules/${manifest.name}`;
    assert.equal(packages[packedLocation], undefined);
    packages[packedLocation] = {
      ...packedEntry,
      resolved: tarballSpec,
      integrity,
    };
    // Qualify the real tarball at the repository's locked production versions.
    // Fresh latest-range registry resolution is outside this consumer fixture.
    writeJson(installed, "package.json", consumer);
    writeJson(installed, "package-lock.json", {
      name: consumer.name,
      version: consumer.version,
      lockfileVersion: qualifiedLock.lockfileVersion,
      requires: true,
      packages,
    });
    const installEnv = { ...process.env };
    for (const key of Object.keys(installEnv))
      if (["npm_config_offline", "npm_config_prefer_offline"].includes(key.toLowerCase()))
        delete installEnv[key];
    installEnv.npm_config_offline = "true";
    const installStartedAt = performance.now();
    const install = spawnSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        installed,
        tarball,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        // Missing or corrupt qualified cache data must fail the native install.
        env: installEnv,
      },
    );
    assert.equal(
      install.status,
      0,
      npmProcessDiagnostic("npm install", install, installStartedAt),
    );
    t.diagnostic(
      JSON.stringify({
        stage: "npm install",
        elapsedMs: Math.round(performance.now() - installStartedAt),
        timeoutMs: 60000,
        offline: true,
        status: install.status,
      }),
    );
    const distribution = join(installed, "node_modules/@arrs/cli"),
      executable = join(distribution, "dist/cli.js");
    const installedManifest = readJson(distribution, "package.json");
    for (const field of declaredFields)
      assert.deepEqual(
        installedManifest[field],
        manifest[field],
        `Packed declaration must match its qualified source: ${field}`,
      );
    const installedLock = readJson(installed, "package-lock.json");
    assert.equal(installedLock.lockfileVersion, qualifiedLock.lockfileVersion);
    assert.deepEqual(
      Object.keys(installedLock.packages).sort(),
      Object.keys(packages).sort(),
    );
    assert.deepEqual(installedLock.packages[""].dependencies, consumer.dependencies);
    for (const [location, entry] of Object.entries(packages)) {
      if (!location) continue;
      for (const field of ["version", "resolved", "integrity"])
        assert.equal(
          installedLock.packages[location][field],
          entry[field],
          `Native install must retain qualified ${location} ${field}`,
        );
      const actual = readJson(installed, `${location}/package.json`);
      assert.equal(actual.version, entry.version, `Installed version: ${location}`);
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "peerDependenciesMeta",
      ])
        assert.deepEqual(
          actual[field] ?? {},
          entry[field] ?? {},
          `Installed declaration: ${location} ${field}`,
        );
    }
    assert.ok(
      existsSync(join(installed, "node_modules/typescript")),
      "Scanner dependency is shipped for consumers",
    );
    assert.ok(
      !existsSync(join(installed, "node_modules/prettier")),
      "Development tools are not runtime dependencies",
    );
    assert.ok(existsSync(join(distribution, "docs/adoption.md")));
    assert.ok(existsSync(join(distribution, "templates/proof-plan.json")));
    assert.ok(existsSync(join(distribution, "docs/task-preparation.md")));
    assert.ok(existsSync(join(distribution, "schemas/prepared-task.schema.json")));
    assert.ok(existsSync(join(distribution, "schemas/mcp-inspection.schema.json")));
    assert.ok(existsSync(join(distribution, "docs/mcp.md")));
    const preparationFixture = makeFixture(3);
    try {
      writeJson(preparationFixture, "task.json", {
        schemaVersion: "0.1",
        id: "packed-preparation",
        title: "Prepare an installed CLI task",
        state: "needs-triage",
        risk: "R1",
        category: "feature",
        featureIds: ["greeting"],
        acceptance: ["Greets a trimmed name"],
        context: ["src/domain/greeting.mjs"],
        verificationTargets: ["greet"],
        dependencies: [],
        decisions: [],
      });
      const prepared = spawnSync(
        process.execPath,
        [executable, "prepare", "task.json", "--root", preparationFixture, "--json"],
        { encoding: "utf8", timeout: 20000 },
      );
      assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
      assert.equal(JSON.parse(prepared.stdout).kind, "prepared-task");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } =
        await import("@modelcontextprotocol/sdk/client/stdio.js");
      const client = new Client(
        { name: "packed-arrs-consumer", version: "1.32.1" },
        { capabilities: {} },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [executable, "mcp", "--stdio", "--root", preparationFixture],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "arrs.task_prepare"));
        const result = await client.callTool({
          name: "arrs.task_prepare",
          arguments: { work: "task.json" },
        });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(result.structuredContent.kind, "mcp-inspection");
        assert.equal(result.structuredContent.data.id, JSON.parse(prepared.stdout).id);
        assert.equal(
          result.structuredContent.data.status,
          JSON.parse(prepared.stdout).status,
        );
      } finally {
        await client.close();
      }
    } finally {
      rmSync(preparationFixture, { recursive: true, force: true });
    }
    const target = join(root, "consumer");
    const invoke = (args) =>
      spawnSync(process.execPath, [executable, ...args, "--root", target, "--json"], {
        encoding: "utf8",
        timeout: 20000,
      });
    assert.equal(invoke(["init"]).status, 0);
    const configBytes = readFileSync(join(target, "arrs.json"));
    assert.equal(invoke(["init", "--dry-run"]).status, 0);
    assert.equal(invoke(["init"]).status, 0);
    assert.deepEqual(readFileSync(join(target, "arrs.json")), configBytes);
    const diagnostic = invoke(["doctor"]);
    assert.equal(
      diagnostic.status,
      1,
      "Incomplete consumer setup remains diagnostic failure",
    );
    const architecture = JSON.parse(diagnostic.stdout).checks.find(
      (item) => item.id === "architecture",
    );
    assert.equal(architecture.status, "incomplete");
    assert.match(architecture.detail, /unconfigured/);
    assert.doesNotMatch(architecture.detail, /Invalid architecture/);
    const skills = invoke(["skills", "install"]);
    assert.equal(skills.status, 0, skills.stdout + skills.stderr);
    assert.equal(invoke(["skills", "test"]).status, 0);
    const assessment = JSON.parse(invoke(["audit"]).stdout);
    assert.equal(assessment.level, 0, "Unconfigured consumer is honestly unmanaged");
    assert.equal(
      assessment.controls.find((item) => item.id === "architecture-guard").status,
      "blocked",
    );
    const adopter = makeFixture(3);
    try {
      const packedInvoke = (args) =>
        spawnSync(process.execPath, [executable, ...args, "--root", adopter, "--json"], {
          encoding: "utf8",
          timeout: 20000,
        });
      const map = readJson(adopter, "docs/features/greeting.json");
      map.id = "greeting-export";
      map.verification = {
        target: "greeting-export",
        command: { argv: [process.execPath, "verify.mjs"] },
      };
      map.tests = ["test.mjs"];
      writeJson(adopter, ".agent/adoption/input.json", map);
      const instructions = readFileSync(join(adopter, "AGENTS.md"));
      assert.equal(packedInvoke(["init"]).status, 0);
      assert.deepEqual(readFileSync(join(adopter, "AGENTS.md")), instructions);
      const retained = join(root, "adopter-baseline");
      cpSync(adopter, retained, { recursive: true });
      const baselineResult = packedInvoke(["baseline", "inspect", retained]);
      assert.equal(baselineResult.status, 0, baselineResult.stdout);
      const baseline = JSON.parse(baselineResult.stdout).selection;
      const plannedResult = packedInvoke([
        "adopt",
        "plan",
        ".agent/adoption/input.json",
        "--output",
        ".arrs/adoption/greeting-export",
      ]);
      assert.equal(plannedResult.status, 0, plannedResult.stdout);
      const planned = JSON.parse(plannedResult.stdout);
      assert.equal(planned.status, "ready-for-review", plannedResult.stdout);
      writeJson(adopter, ".agent/adoption/authorization.json", {
        schemaVersion: "0.1",
        proposalSha256: planned.output.sha256,
        humanApproval:
          "Packaged fixture maintainer authorizes these reviewed bytes for execution; human implementation acceptance is pending.",
      });
      const appliedResult = packedInvoke([
        "adopt",
        "apply",
        planned.output.proposal,
        "--authorization",
        ".agent/adoption/authorization.json",
        "--baseline",
        baseline.root,
        "--baseline-sha256",
        baseline.sha256,
      ]);
      assert.equal(appliedResult.status, 0, appliedResult.stdout);
      assert.equal(JSON.parse(appliedResult.stdout).status, "configured");
      assert.equal(JSON.parse(appliedResult.stdout).accepted, false);
      assert.equal(
        readJson(adopter, "docs/features/greeting-export.json").verification.target,
        "greeting-export",
      );
      assert.deepEqual(readFileSync(join(adopter, "AGENTS.md")), instructions);
      assert.ok(existsSync(join(distribution, "schemas/adoption-proposal.schema.json")));
      assert.ok(existsSync(join(distribution, "templates/adoption-input.json")));
    } finally {
      rmSync(adopter, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
