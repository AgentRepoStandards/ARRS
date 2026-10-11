import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../dist/core/audit.js";
import { doctor } from "../dist/core/doctor.js";
import { initRepository } from "../dist/workflows/init.js";
import { makeFixture, readJson, writeJson } from "./helpers.mjs";

test("concise alternative operating rules and scoped navigation are accepted", async () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, "guides"), { recursive: true });
    writeFileSync(
      join(root, "guides/contract.md"),
      "# Operating rules\n\nUse minimal changes and correct the underlying cause. Preserve compiler checks, regression tests and acceptance verification; never disable a gate to accept a failing result. Protect credentials and explain package additions. Classify change impact using [the policy](../.agent/policies/risk.json); capture verification evidence using arrs proof commands. Locate [capability maps](../docs/features) and [module boundaries](../docs/architecture); product and decisions are configured in arrs.json.\n",
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Repository contract\n\nStart with [operating rules](guides/contract.md), then follow the map for the affected capability. Read the documents needed for the current task. The [configured command interface](arrs.json) names executable checks and verification targets; run them with ./repo.\n",
    );
    const context = (await audit(root)).controls.find(
      (control) => control.id === "context",
    );
    assert.equal(context.passed, true, context.detail);
    const agents = (await doctor(root)).checks.find((check) => check.id === "agents");
    assert.equal(agents.passed, true, agents.detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broken contextual references are rejected even when configured paths appear literally", async () => {
  const root = makeFixture();
  try {
    const text = readFileSync(join(root, "AGENTS.md"), "utf8").replace(
      "`docs/features/`",
      "[Feature Maps](docs/features/missing.md)",
    );
    writeFileSync(join(root, "AGENTS.md"), text);
    const context = (await audit(root)).controls.find(
      (control) => control.id === "context",
    );
    assert.equal(context.passed, false);
    assert.match(context.detail, /broken repository reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured knowledge and risk paths support normal Markdown navigation", async () => {
  const root = makeFixture(4);
  try {
    const config = readJson(root, "arrs.json");
    renameSync(join(root, "docs"), join(root, "guides"));
    for (const key of Object.keys(config.knowledge))
      config.knowledge[key] = config.knowledge[key].replace("docs/", "guides/");
    config.riskPolicy = ".agent/policies/impact.json";
    renameSync(join(root, ".agent/policies/risk.json"), join(root, config.riskPolicy));
    writeJson(root, "arrs.json", config);
    const text = readFileSync(join(root, "AGENTS.md"), "utf8")
      .replaceAll("docs/", "guides/")
      .replaceAll(".agent/policies/risk.json", config.riskPolicy);
    writeFileSync(join(root, "AGENTS.md"), text);
    const context = (await audit(root)).controls.find(
      (control) => control.id === "context",
    );
    assert.equal(context.passed, true, context.detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context budgets and operating obligations remain required", async () => {
  const root = makeFixture();
  try {
    const original = readFileSync(join(root, "AGENTS.md"), "utf8");
    for (const text of [
      original + "x".repeat(8001),
      "# Contract\n",
      original.replace("fix root causes", "avoid unrelated work"),
    ]) {
      writeFileSync(join(root, "AGENTS.md"), text);
      const context = (await audit(root)).controls.find(
        (control) => control.id === "context",
      );
      assert.equal(context.passed, false, context.detail);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all generated knowledge scaffolds remain unproven", async () => {
  const root = mkdtempSync(join(tmpdir(), "arrs-knowledge-scaffold-"));
  try {
    initRepository(root);
    const report = await doctor(root);
    for (const key of ["architecture", "product", "decisions"])
      assert.equal(
        report.checks.find((check) => check.id === `knowledge:${key}`).passed,
        false,
        key,
      );
    assert.equal(
      (await audit(root)).controls.find((control) => control.id === "knowledge").passed,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge with a broken relevant link remains unproven", async () => {
  const root = makeFixture();
  try {
    const file = join(root, "docs/product/README.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        "\nFollow [product acceptance](missing-acceptance.md).\n",
    );
    const knowledge = (await doctor(root)).checks.find(
      (check) => check.id === "knowledge:product",
    );
    assert.equal(knowledge.passed, false);
    assert.match(knowledge.detail, /broken repository reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("code resource names do not imply repository references", async () => {
  const root = makeFixture();
  try {
    const file = join(root, "docs/product/README.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        "\nThe delivery endpoint is `api/v1`; the displayed media type is `text/plain`.\n",
    );
    const knowledge = (await doctor(root)).checks.find(
      (check) => check.id === "knowledge:product",
    );
    assert.equal(knowledge.passed, true, knowledge.detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absolute contextual links cannot be normalized into supported local navigation", async () => {
  const root = makeFixture();
  try {
    const file = join(root, "AGENTS.md");
    const original = readFileSync(file, "utf8");
    for (const destination of [
      "/docs/features/",
      "%2Fdocs/features/",
      "file:///docs/features/",
      "C:/docs/features/",
    ]) {
      writeFileSync(file, original.replace("`docs/features/`", `[Maps](${destination})`));
      const context = (await audit(root)).controls.find(
        (control) => control.id === "context",
      );
      assert.equal(context.passed, false, destination);
      assert.match(context.detail, /invalid repository reference/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization preserves substantive existing knowledge and instructions byte-for-byte", async () => {
  const root = makeFixture();
  try {
    const files = [
      "AGENTS.md",
      "docs/product/README.md",
      "docs/architecture/README.md",
      "docs/adr/0001-domain.md",
    ];
    const before = files.map((file) => readFileSync(join(root, file)));
    initRepository(root);
    initRepository(root);
    for (const [index, file] of files.entries())
      assert.deepEqual(readFileSync(join(root, file)), before[index]);
    for (const key of ["architecture", "product", "decisions"])
      assert.equal(
        (await doctor(root)).checks.find((check) => check.id === `knowledge:${key}`)
          .passed,
        true,
        key,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
