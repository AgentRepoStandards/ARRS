import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  readdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { makeFixture, writeJson, readJson, invoke, cli } from "./helpers.mjs";
import {
  queryCapabilityGraph,
  renderCapabilityGraph,
  capabilityGraphHtml,
} from "../dist/core/capability-graph.js";
import { validate } from "../dist/core/schema.js";
function report(root, args, expected = 0) {
  const r = invoke(root, args);
  const v = JSON.parse(r.stdout);
  assert.equal(r.status, expected, JSON.stringify(v));
  return v;
}
function git(root, ...args) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Graph fixture",
      GIT_AUTHOR_EMAIL: "graph@example.invalid",
      GIT_COMMITTER_NAME: "Graph fixture",
      GIT_COMMITTER_EMAIL: "graph@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function baseline(root) {
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return git(root, "rev-parse", "HEAD");
}
function inventory(root) {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .sort((a, b) => (join(a.parentPath, a.name) < join(b.parentPath, b.name) ? -1 : 1))) {
    const path = join(entry.parentPath, entry.name);
    hash.update(path + "\0").update(readFileSync(path));
  }
  return hash.digest("hex");
}
function addMap(root, id, overrides = {}) {
  const map = { ...readJson(root, "docs/features/greeting.json"), id, ...overrides };
  writeJson(root, `docs/features/${id}.json`, map);
  return map;
}
function work(root, proof, overrides = {}) {
  writeJson(root, ".agent/work-items/graph.json", {
    schemaVersion: "0.1",
    id: "graph-task",
    title: "Graph selected greeting work",
    state: "needs-triage",
    risk: "R2",
    category: "feature",
    featureIds: ["greeting"],
    acceptance: ["Greets a trimmed name"],
    context: ["src/domain", "src/application"],
    verificationTargets: ["greet"],
    dependencies: [],
    decisions: [],
    ...(proof ? { proof } : {}),
    ...overrides,
  });
}
function capture(root, task = "graph-task", expected = 0) {
  const plan = readJson(root, "proof-plan.json");
  plan.task = task;
  plan.risk = "R2";
  plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
  writeJson(root, ".arrs/graph-plan.json", plan);
  return report(root, ["proof", "run", ".arrs/graph-plan.json", "--execute"], expected)
    .path;
}

test("public source impact retains all overlapping floors/targets and maintained provenance without effects", async () => {
  const root = makeFixture(3);
  try {
    const config = readJson(root, "arrs.json");
    config.verifyTargets.bill = {
      argv: ["sentinel-command", "literal ; $(not-a-shell)"],
      timeoutSeconds: 17,
    };
    writeJson(root, "arrs.json", config);
    addMap(root, "billing", {
      implementation: ["src/domain/greeting.mjs"],
      entryPoints: ["src/domain/greeting.mjs"],
      sensitivity: "sensitive",
      risk: "R3",
      verification: { target: "bill" },
      related: ["docs/adr/0001-domain.md"],
    });
    const before = inventory(root);
    const result = report(root, ["impact", "src/domain/greeting.mjs"]);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.affectedFeatureIds, ["billing", "greeting"]);
    assert.equal(result.effectiveRisk, "R3");
    assert.deepEqual(result.verificationTargets, ["bill", "greet"]);
    assert.ok(result.nodes.some((n) => n.kind === "decision"));
    assert.ok(
      result.edges.every((e) =>
        e.sources.every((s) => s.path && s.pointer !== undefined && s.sha256),
      ),
    );
    assert.deepEqual(validate("capability-graph", result), []);
    assert.deepEqual(
      result,
      await queryCapabilityGraph(root, { paths: ["src/domain/greeting.mjs"] }),
    );
    assert.equal(inventory(root), before);
    assert.equal(result.analysis.status, "not-evaluated");
    assert.match(result.analysis.gaps.join(" "), /runtime|semantic/);
    const feature = report(root, ["context", "feature", "greeting"]);
    assert.equal(feature.effectiveRisk, "R3");
    assert.deepEqual(feature.verificationTargets, ["bill", "greet"]);
    assert.ok(feature.nodes.some((n) => n.kind === "feature" && n.label === "billing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete named-base impact preserves added deleted renamed and unmapped endpoints plus comparison-side obligations", () => {
  const root = makeFixture(3);
  try {
    const config = readJson(root, "arrs.json");
    config.verifyTargets.legacy = { argv: [process.execPath, "verify.mjs"] };
    writeJson(root, "arrs.json", config);
    addMap(root, "legacy", {
      entryPoints: ["src/domain/greeting.mjs"],
      implementation: ["src/domain/greeting.mjs"],
      risk: "R3",
      sensitivity: "sensitive",
      verification: { target: "legacy" },
    });
    const base = baseline(root);
    renameSync(
      join(root, "src/domain/greeting.mjs"),
      join(root, "src/domain/renamed greeting.mjs"),
    );
    const architecture = readJson(root, ".agent/policies/architecture.json");
    architecture.modules[0].public = ["src/domain/renamed greeting.mjs"];
    writeJson(root, ".agent/policies/architecture.json", architecture);
    writeFileSync(
      join(root, "src/application/main.mjs"),
      readFileSync(join(root, "src/application/main.mjs"), "utf8").replace(
        "greeting.mjs",
        "renamed greeting.mjs",
      ),
    );
    const map = readJson(root, "docs/features/greeting.json");
    map.implementation = ["src/application", "src/domain/renamed greeting.mjs"];
    writeJson(root, "docs/features/greeting.json", map);
    rmSync(join(root, "docs/features/legacy.json"));
    delete config.verifyTargets.legacy;
    writeJson(root, "arrs.json", config);
    writeFileSync(join(root, "unmapped.txt"), "unmapped source\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "rename and removal");
    const result = report(root, ["impact", "--base", base]);
    assert.equal(result.effectiveRisk, "R3");
    assert.ok(result.verificationTargets.includes("legacy"));
    assert.ok(
      result.changeset.layers.some(
        (l) =>
          l.paths.includes("src/domain/greeting.mjs") &&
          l.paths.includes("src/domain/renamed greeting.mjs"),
      ),
    );
    assert.ok(
      result.nodes.some((n) => n.kind === "source" && n.label === "unmapped.txt"),
    );
    assert.ok(
      result.nodes.some(
        (n) =>
          n.kind === "feature" &&
          n.label === "legacy" &&
          n.sources.some((s) => s.revision === base),
      ),
    );
    assert.ok(result.drift.some((d) => d.featureId === "legacy" && d.after === null));
    assert.ok(
      result.scope.features.some(
        (f) => f.id === "legacy" && f.provenance === "comparison-base",
      ),
    );
    assert.deepEqual(validate("capability-graph", result), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drift reports exact invariant criterion and target changes but source-only edits do not imply semantic prose staleness", () => {
  const root = makeFixture(3);
  try {
    const base = baseline(root);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") + "// changed code\n",
    );
    let result = report(root, ["context", "drift", "--base", base]);
    assert.deepEqual(result.drift, []);
    const map = readJson(root, "docs/features/greeting.json");
    map.invariants.push("Case is preserved.");
    map.acceptance.push("Greets a case-sensitive name");
    writeJson(root, "docs/features/greeting.json", map);
    const config = readJson(root, "arrs.json");
    config.verifyTargets.greet.timeoutSeconds = 29;
    writeJson(root, "arrs.json", config);
    result = report(root, ["context", "drift", "--base", base]);
    for (const field of ["invariants", "acceptance", "verifyTargets/greet"])
      assert.ok(
        result.drift.some((d) => d.field === field),
        field,
      );
    assert.ok(
      result.drift.every(
        (d) =>
          d.sources.some((s) => s.revision === base && s.sha256) &&
          d.sources.some((s) => s.revision === null && s.sha256),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated selected proof never qualifies; exact technical, accepted, stale and recorded-failed evidence remain distinct", () => {
  const root = makeFixture(3);
  try {
    const unrelated = capture(root, "unrelated-task");
    work(root, unrelated);
    let result = report(root, ["context", "feature", "greeting"]);
    assert.equal(result.criteria[0].status, "unrelated");
    assert.equal(result.criteria[0].qualifies, false);
    const proof = capture(root);
    work(root, proof);
    result = report(root, ["context", "feature", "greeting"]);
    assert.equal(result.criteria[0].status, "technical");
    assert.equal(result.criteria[0].assurance, "declared-only");
    assert.equal(result.criteria[0].qualifies, true);
    writeJson(root, ".arrs/graph-review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Independent fixture review of this exact immutable attempt",
    });
    report(root, ["proof", "review", proof, ".arrs/graph-review.json"]);
    result = report(root, ["context", "feature", "greeting"]);
    assert.equal(result.criteria[0].status, "accepted");
    assert.ok(result.nodes.some((n) => n.kind === "review"));
    const old = readFileSync(join(root, "src/domain/greeting.mjs"), "utf8");
    writeFileSync(join(root, "src/domain/greeting.mjs"), old + "// proof is stale\n");
    result = report(root, ["context", "feature", "greeting"]);
    assert.equal(result.criteria[0].status, "stale");
    assert.equal(result.criteria[0].qualifies, false);
    writeFileSync(join(root, "src/domain/greeting.mjs"), old);
    const config = readJson(root, "arrs.json");
    config.commands.test = { argv: [process.execPath, "-e", "process.exit(7)"] };
    writeJson(root, "arrs.json", config);
    const failed = capture(root, "graph-task", 1);
    work(root, failed);
    result = report(root, ["context", "feature", "greeting"]);
    assert.equal(result.criteria[0].status, "failed");
    assert.equal(result.criteria[0].qualifies, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("criterion coincidence and shared paths do not credit a feature absent from explicit work membership", () => {
  const root = makeFixture(3);
  try {
    addMap(root, "coincidence");
    const proof = capture(root);
    work(root, proof);
    const result = report(root, ["context", "feature", "coincidence"]);
    assert.equal(result.criteria[0].status, "missing");
    assert.equal(result.criteria[0].qualifies, false);
    assert.ok(!result.nodes.some((n) => n.kind === "proof"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured custom locations and dependencies work; unsupported work provider is explicit incomplete", () => {
  const root = makeFixture(3);
  try {
    const config = readJson(root, "arrs.json");
    renameSync(join(root, "docs/features"), join(root, "docs/custom-maps"));
    config.knowledge.features = "docs/custom-maps";
    config.work = { provider: "local", path: "local/tasks" };
    writeJson(root, "arrs.json", config);
    const map = readJson(root, "docs/custom-maps/greeting.json");
    writeJson(root, "docs/custom-maps/context.json", { ...map, id: "context" });
    map.dependencies = ["context"];
    writeJson(root, "docs/custom-maps/greeting.json", map);
    work(root);
    mkdirSync(join(root, "local"), { recursive: true });
    renameSync(join(root, ".agent/work-items"), join(root, "local/tasks"));
    let result = report(root, ["context", "feature", "greeting"]);
    assert.ok(result.nodes.some((n) => n.kind === "work"));
    assert.ok(result.edges.some((e) => e.relation === "dependency"));
    config.work.provider = "remote";
    writeJson(root, "arrs.json", config);
    result = report(root, ["context", "feature", "greeting"], 1);
    assert.match(result.diagnostics.join(" "), /Unsupported work provider remote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown versions malformed maps duplicate identities dependency cycles and unsafe symlink references fail incomplete", () => {
  for (const fault of [
    "version",
    "duplicate",
    "cycle",
    "malformed",
    "symlink",
    "traversal",
  ]) {
    const root = makeFixture(3);
    try {
      const map = readJson(root, "docs/features/greeting.json");
      if (fault === "version") {
        map.schemaVersion = "9";
        writeJson(root, "docs/features/greeting.json", map);
      }
      if (fault === "duplicate") writeJson(root, "docs/features/duplicate.json", map);
      if (fault === "cycle") {
        map.dependencies = ["second"];
        writeJson(root, "docs/features/greeting.json", map);
        addMap(root, "second", { dependencies: ["greeting"] });
      }
      if (fault === "malformed")
        writeFileSync(join(root, "docs/features/broken.json"), "{");
      if (fault === "symlink") {
        symlinkSync(join(root, "src/domain"), join(root, "shortcut"));
        map.implementation = ["shortcut"];
        writeJson(root, "docs/features/greeting.json", map);
      }
      if (fault === "traversal") {
        map.related = ["../outside"];
        writeJson(root, "docs/features/greeting.json", map);
      }
      const result = report(root, ["impact", "src/domain/greeting.mjs"], 1);
      assert.equal(result.status, "incomplete", fault);
      assert.ok(result.diagnostics.length, fault);
      assert.deepEqual(validate("capability-graph", result), [], fault);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("page cursors are deterministic bounded and reject changed inputs; criterion identity survives text reorder", () => {
  const root = makeFixture(3);
  try {
    const map = readJson(root, "docs/features/greeting.json");
    map.acceptance.push("Handles Unicode names");
    writeJson(root, "docs/features/greeting.json", map);
    const all = report(root, ["context", "feature", "greeting", "--limit", "1000"]);
    let result = report(root, ["context", "feature", "greeting", "--limit", "2"]);
    assert.equal(result.nodes.length, 2);
    const ids = [];
    while (true) {
      ids.push(...result.nodes.map((n) => n.id));
      if (!result.page.nextCursor) break;
      result = report(root, [
        "context",
        "feature",
        "greeting",
        "--limit",
        "2",
        "--cursor",
        result.page.nextCursor,
      ]);
      assert.equal(result.identity, all.identity);
    }
    assert.deepEqual(
      ids,
      all.nodes.map((n) => n.id),
    );
    const before = all.nodes
      .filter((n) => n.kind === "criterion")
      .map((n) => n.id)
      .sort();
    const cursor = report(root, ["context", "feature", "greeting", "--limit", "2"]).page
      .nextCursor;
    map.acceptance.reverse();
    writeJson(root, "docs/features/greeting.json", map);
    const reordered = report(root, ["context", "feature", "greeting", "--limit", "1000"]);
    assert.deepEqual(
      reordered.nodes
        .filter((n) => n.kind === "criterion")
        .map((n) => n.id)
        .sort(),
      before,
    );
    assert.match(
      report(
        root,
        ["context", "feature", "greeting", "--cursor", cursor],
        1,
      ).diagnostics.join(" "),
      /stale/,
    );
    assert.ok(validate("capability-graph", { ...all, schemaVersion: "2" }).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal and local HTML render the same factual result, escape payloads and perform no configured command or writes", async () => {
  const root = makeFixture(3);
  try {
    const map = readJson(root, "docs/features/greeting.json");
    map.goal = '<script>alert("graph")</script> operator greeting\u001b[2J';
    writeJson(root, "docs/features/greeting.json", map);
    const config = readJson(root, "arrs.json");
    for (const c of Object.values(config.commands))
      c.argv = [process.execPath, "-e", "require('fs').writeFileSync('EXECUTED','bad')"];
    config.verifyTargets.greet.argv = [
      process.execPath,
      "-e",
      "require('fs').writeFileSync('EXECUTED','bad')",
    ];
    writeJson(root, "arrs.json", config);
    work(root);
    const before = inventory(root);
    const result = await queryCapabilityGraph(root, { feature: "greeting" });
    assert.equal(result.status, "complete");
    const text = renderCapabilityGraph(result),
      html = capabilityGraphHtml(result);
    assert.ok(!text.includes("\u001b"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.match(html, /default-src 'none'/);
    const r = spawnSync(
      process.execPath,
      [cli, "context", "feature", "greeting", "--root", root, "--html"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, html);
    assert.equal(inventory(root), before);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic 200-feature graph has bounded pages and stable cached-free identity", async () => {
  const root = makeFixture(3);
  try {
    for (let i = 0; i < 199; i++)
      addMap(root, "capability-" + String(i).padStart(3, "0"), {
        implementation: ["src/domain/greeting.mjs"],
        entryPoints: ["src/domain/greeting.mjs"],
      });
    const start = performance.now(),
      result = await queryCapabilityGraph(root, {
        paths: ["src/domain/greeting.mjs"],
        limit: 25,
      }),
      duration = performance.now() - start;
    assert.equal(result.status, "complete", result.diagnostics.join("; "));
    assert.equal(result.affectedFeatureIds.length, 200);
    assert.equal(result.nodes.length, 25);
    assert.ok(result.page.totalNodes > 600);
    assert.ok(result.page.nextCursor);
    assert.equal(result.limits.features, 2000);
    assert.equal(
      (
        await queryCapabilityGraph(root, {
          paths: ["src/domain/greeting.mjs"],
          limit: 25,
        })
      ).identity,
      result.identity,
    );
    console.log(
      JSON.stringify({
        benchmark: "200 features, no selected work evidence",
        durationMs: Math.round(duration),
        totalNodes: result.page.totalNodes,
        edges: result.edges.length,
        pageBytes: Buffer.byteLength(JSON.stringify(result)),
        cache: false,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removed maintained decision reference has explicit before/after presence drift and incomplete diagnostics", () => {
  const root = makeFixture(3);
  try {
    const map = readJson(root, "docs/features/greeting.json");
    map.related.push("docs/adr/0001-domain.md");
    writeJson(root, "docs/features/greeting.json", map);
    const base = baseline(root);
    rmSync(join(root, "docs/adr/0001-domain.md"));
    const result = report(root, ["context", "drift", "--base", base], 1);
    assert.match(
      result.diagnostics.join(" "),
      /Broken maintained reference|Referenced path does not exist/,
    );
    const drift = result.drift.find(
      (d) => d.field === "reference-presence/docs/adr/0001-domain.md",
    );
    assert.equal(drift.before.present, true);
    assert.equal(drift.after.present, false);
    assert.equal(drift.sources[0].revision, base);
    assert.ok(drift.before.blob.object);
    assert.match(
      renderCapabilityGraph(result),
      /reference-presence\/docs\/adr\/0001-domain.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent oversized replacement at final graph re-read fails before body allocation/read", () => {
  const root = makeFixture(3);
  try {
    const target = join(root, "src/domain/greeting.mjs"),
      preload = join(root, "graph-reader-trap.mjs");
    writeFileSync(
      preload,
      `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const target=${JSON.stringify(target)},originalOpen=fs.openSync,originalRead=fs.readSync;let reads=0;const trapped=new Set();fs.openSync=function(path,...args){if(String(path)===target&&++reads===2)fs.writeFileSync(target,Buffer.alloc(1024*1024+1));const fd=originalOpen.call(this,path,...args);if(String(path)===target&&reads>=2)trapped.add(fd);return fd;};fs.readSync=function(fd,...args){if(trapped.has(fd))throw Error('UNBOUNDED_FINAL_BODY_READ');return originalRead.call(this,fd,...args);};syncBuiltinESMExports();`,
    );
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        cli,
        "impact",
        "src/domain/greeting.mjs",
        "--root",
        root,
        "--json",
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(r.status, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, "incomplete");
    assert.match(result.diagnostics.join(" "), /at most 1 MiB/);
    assert.ok(!result.diagnostics.join(" ").includes("UNBOUNDED_FINAL_BODY_READ"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit-base criterion qualification retains historical targets without upgrading legacy captured assurance", () => {
  const root = makeFixture(3);
  try {
    const config = readJson(root, "arrs.json");
    config.work = { provider: "local", path: "graph-work" };
    writeJson(root, "arrs.json", config);
    writeFileSync(
      join(root, ".gitignore"),
      readFileSync(join(root, ".gitignore"), "utf8") + "\n/graph-work/\n",
    );
    const base = baseline(root);
    config.verifyTargets.newGreeting = config.verifyTargets.greet;
    writeJson(root, "arrs.json", config);
    const map = readJson(root, "docs/features/greeting.json");
    map.verification.target = "newGreeting";
    writeJson(root, "docs/features/greeting.json", map);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") +
        "// actual source change\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "new target");
    const scope = [
        "src/domain",
        "src/application",
        "arrs.json",
        "docs/features/greeting.json",
      ],
      plan = readJson(root, "proof-plan.json");
    Object.assign(plan, {
      task: "graph-task",
      risk: "R3",
      scope,
      authorization: {
        humanApproval: "Actual fixture permission for local proof execution only",
      },
    });
    plan.steps[3].target = "newGreeting";
    plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
    writeJson(root, ".arrs/graph-plan.json", plan);
    const proof = report(root, [
      "proof",
      "run",
      ".arrs/graph-plan.json",
      "--execute",
    ]).path;
    work(root, proof, {
      risk: "R3",
      context: scope,
      verificationTargets: ["newGreeting"],
      authorization: {
        humanApproval: "Actual fixture permission for human-controlled execution",
      },
    });
    writeJson(
      root,
      "graph-work/task.json",
      readJson(root, ".agent/work-items/graph.json"),
    );
    rmSync(join(root, ".agent/work-items"), { recursive: true, force: true });
    assert.equal(
      report(root, ["context", "feature", "greeting"]).criteria[0].status,
      "technical",
    );
    const result = report(root, ["impact", "--base", base]);
    assert.deepEqual(result.verificationTargets, ["greet", "newGreeting"]);
    assert.equal(result.criteria[0].qualifies, false);
    assert.equal(result.criteria[0].status, "invalid");
    assert.equal(result.criteria[0].assurance, "declared-only");
    assert.match(result.criteria[0].diagnostics.join(" "), /comparison-base.*greet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed selected proof remains incomplete with diagnostics and never qualifies", () => {
  const root = makeFixture(3);
  try {
    writeJson(root, ".arrs/bad-proof.json", { schemaVersion: "99", task: "graph-task" });
    work(root, ".arrs/bad-proof.json");
    const result = report(root, ["context", "feature", "greeting"], 1);
    assert.match(result.diagnostics.join(" "), /Malformed selected proof/);
    assert.ok(result.criteria.every((c) => !c.qualifies));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large repeated criterion records fail the explicit output quota without returning partial success", async () => {
  const root = makeFixture(3);
  try {
    const acceptance = Array.from(
      { length: 30 },
      (_, i) => "Criterion " + i + " " + "x".repeat(32000),
    );
    for (let i = 0; i < 20; i++) addMap(root, "bounded-" + i, { acceptance });
    const result = await queryCapabilityGraph(root, {
      paths: ["src/domain/greeting.mjs"],
    });
    assert.equal(result.status, "incomplete");
    assert.match(result.diagnostics.join(" "), /16 MiB output/);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.criteria, []);
    assert.equal(result.page.nextCursor, null);
    assert.deepEqual(validate("capability-graph", result), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical malformed dependency cycles fail closed with comparison diagnostics", () => {
  const root = makeFixture(3);
  try {
    const map = readJson(root, "docs/features/greeting.json");
    map.dependencies = ["greeting"];
    writeJson(root, "docs/features/greeting.json", map);
    const base = baseline(root);
    map.dependencies = [];
    writeJson(root, "docs/features/greeting.json", map);
    const result = report(root, ["context", "drift", "--base", base], 1);
    assert.equal(result.status, "incomplete");
    assert.match(result.diagnostics.join(" "), /Comparison-base.*cycle/);
    assert.ok(result.criteria.every((c) => !c.qualifies));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested ignored-basename map retains its floor targets and semantic diagnostics without false evidence credit", () => {
  const root = makeFixture(3);
  try {
    const config = readJson(root, "arrs.json");
    config.verifyTargets.nested = { argv: [process.execPath, "verify.mjs"] };
    writeJson(root, "arrs.json", config);
    const nested = {
      ...readJson(root, "docs/features/greeting.json"),
      id: "nested-sensitive",
      risk: "R3",
      sensitivity: "sensitive",
      verification: { target: "nested" },
    };
    writeJson(root, "docs/features/vendor/nested.json", nested);
    let result = report(root, ["impact", "src/domain/greeting.mjs"]);
    assert.equal(result.effectiveRisk, "R3");
    assert.deepEqual(result.affectedFeatureIds, ["greeting", "nested-sensitive"]);
    assert.deepEqual(result.verificationTargets, ["greet", "nested"]);
    const proof = capture(root);
    work(root, proof);
    result = report(root, ["impact", "src/domain/greeting.mjs"]);
    const evidence = result.criteria.find(
      (criterion) => criterion.featureId === "greeting",
    );
    assert.equal(evidence.qualifies, false);
    assert.equal(evidence.status, "invalid");
    assert.match(
      evidence.diagnostics.join(" "),
      /full map inventory requires R3|full graph inventory target nested/,
    );
    delete config.verifyTargets.nested;
    writeJson(root, "arrs.json", config);
    result = report(root, ["impact", "src/domain/greeting.mjs"], 1);
    assert.match(result.diagnostics.join(" "), /unconfigured verification target nested/);
    assert.equal(result.status, "incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete duplicate work inventory withholds criterion credit while preserving raw accepted proof facts", () => {
  const root = makeFixture(3);
  try {
    const proof = capture(root);
    work(root, proof);
    writeJson(root, ".arrs/graph-review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Independent fixture review of the exact graph-work proof",
    });
    report(root, ["proof", "review", proof, ".arrs/graph-review.json"]);
    writeJson(
      root,
      ".agent/work-items/duplicate.json",
      readJson(root, ".agent/work-items/graph.json"),
    );
    const result = report(root, ["context", "feature", "greeting"], 1);
    assert.match(result.diagnostics.join(" "), /Duplicate work identity/);
    assert.ok(result.criteria.length);
    assert.ok(result.criteria.every((c) => !c.qualifies && c.status !== "accepted"));
    assert.ok(
      result.nodes.some(
        (n) =>
          n.kind === "proof" &&
          n.facts.some((f) => f.name === "accepted" && f.value === true),
      ),
    );
    assert.match(result.criteria[0].diagnostics.join(" "), /collection is incomplete/);
    assert.equal(result.page.nextCursor, null);
    assert.ok(
      !result.edges.some((edge) => edge.relation === "current-criterion-evidence"),
    );
    const repeat = report(root, ["context", "feature", "greeting"], 1);
    assert.equal(repeat.identity, result.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
