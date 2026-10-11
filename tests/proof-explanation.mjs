import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  makeFixture,
  invoke,
  readJson,
  writeJson,
  cli,
  makePolicyTransitionFixture,
} from "./helpers.mjs";
import { explainProof, proofHistory } from "../dist/core/proof-explanation.js";
import { validateEvidence, validateAcceptedEvidence } from "../dist/core/evidence.js";
import { audit } from "../dist/core/audit.js";
import { validate } from "../dist/core/schema.js";

const criterion =
  '<script>window.pwned=true</script><img src="https://example.invalid/" onerror="window.pwned=true">\u001b[31m';
function proof(root, risk = "R1", hostile = false) {
  const plan = readJson(root, "proof-plan.json");
  plan.risk = risk;
  if (risk >= "R2")
    plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
  if (risk >= "R3")
    plan.authorization = {
      humanApproval: "Fixture authorization for local execution; not final acceptance",
    };
  if (hostile) {
    plan.task = criterion;
    plan.acceptance = [criterion];
    plan.steps.find((s) => s.criterion).criterion = criterion;
    const config = readJson(root, "arrs.json");
    config.commands.verify = config.verifyTargets.greet = {
      argv: [
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(criterion + " token=privatevalue Bearer privatebearer " + "x".repeat(15000))})`,
      ],
    };
    writeJson(root, "arrs.json", config);
  }
  writeJson(root, "proof-plan.json", plan);
  const result = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).path;
}
function snapshot(root, path = ".arrs/evidence") {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        files[file] = createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex");
    }
  };
  visit(path);
  return files;
}

test("public explanation links exact criteria/checks and is read-only in JSON and terminal", () => {
  const root = makeFixture();
  try {
    const path = proof(root);
    const before = snapshot(root);
    const result = invoke(root, ["proof", "explain", path]);
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(validate("proof-explanation", report), []);
    assert.equal(report.technical.valid, true);
    assert.equal(report.review.accepted, true);
    assert.deepEqual(report.acceptance[0].resultIndices, [4]);
    assert.equal(report.acceptance[0].satisfied, true);
    assert.deepEqual(
      report.scope.map((s) => s.path),
      ["src/domain", "src/application"],
    );
    assert.deepEqual(report.requiredChecks, ["check", "test", "build"]);
    assert.ok(report.limitations.some((l) => /declared scope/.test(l)));
    const terminal = spawnSync(
      process.execPath,
      [cli, "proof", "explain", path, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.match(
      terminal.stdout,
      /Acceptance verified: Greets a trimmed name; result\(s\) 4/,
    );
    assert.equal(invoke(root, ["proof", "history"]).status, 0);
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3 technical success remains ready-for-review until actual bound records; invalid review remains visible", () => {
  const root = makeFixture();
  try {
    const path = proof(root, "R3");
    const report = explainProof(root, path);
    assert.equal(report.technical.valid, true);
    assert.equal(report.review.status, "ready-for-review");
    assert.equal(report.review.accepted, false);
    assert.deepEqual(report.review.required, { independent: true, humanApproval: true });
    writeJson(root, ".agent/review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Test fixture independent reviewer assertion",
      humanApproval: "Test fixture human implementation approval assertion",
    });
    const review = invoke(root, ["proof", "review", path, ".agent/review.json"]);
    assert.equal(review.status, 0, review.stdout);
    assert.equal(explainProof(root, path).review.accepted, true);
    const binding = JSON.parse(review.stdout).path;
    const value = readJson(root, binding);
    value.proofId = randomUUID();
    writeJson(root, binding, value);
    const invalid = explainProof(root, path);
    assert.equal(invalid.technical.valid, true);
    assert.equal(invalid.review.accepted, false);
    assert.equal(invalid.review.attachments[0].valid, false);
    assert.match(invalid.review.attachments[0].errors.join(" "), /does not bind/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope, argv, manifest and log changes agree with shared validators; foreign review never accepts", () => {
  const root = makeFixture();
  try {
    const path = proof(root, "R3");
    const original = readFileSync(join(root, path));
    const log = readJson(root, path).results[0].log;
    const originalLog = readFileSync(join(root, log));
    for (const mutate of [
      () =>
        writeFileSync(
          join(root, "src/domain/greeting.mjs"),
          "export const greeting = () => 'stale';\n",
        ),
      () => {
        const c = readJson(root, "arrs.json");
        c.commands.test.argv.push("--test-only");
        writeJson(root, "arrs.json", c);
      },
      () => writeFileSync(join(root, log), "tampered"),
    ]) {
      const source = readFileSync(join(root, "src/domain/greeting.mjs"));
      const config = readFileSync(join(root, "arrs.json"));
      mutate();
      const explanation = explainProof(root, path);
      assert.equal(
        explanation.technical.valid,
        validateEvidence(root, readJson(root, path)).length === 0,
      );
      assert.equal(explanation.technical.valid, false);
      assert.equal(
        explanation.review.accepted,
        validateAcceptedEvidence(root, path).length === 0,
      );
      writeFileSync(join(root, "src/domain/greeting.mjs"), source);
      writeFileSync(join(root, "arrs.json"), config);
      writeFileSync(join(root, log), originalLog);
    }
    writeJson(root, ".agent/review.json", {
      schemaVersion: "0.1",
      stage: "implementation",
      independent: "Fixture distinct reviewer assertion",
      humanApproval: "Fixture final approval assertion",
    });
    const reviewed = JSON.parse(
      invoke(root, ["proof", "review", path, ".agent/review.json"]).stdout,
    ).path;
    writeFileSync(join(root, path), Buffer.concat([original, Buffer.from("\n")]));
    assert.equal(explainProof(root, path).technical.valid, true);
    assert.equal(explainProof(root, path).review.accepted, false);
    writeFileSync(join(root, path), original);
    const another = proof(root, "R3");
    copyFileSync(
      join(root, reviewed),
      join(root, another, "..", reviewed.split("/").at(-1)),
    );
    assert.equal(explainProof(root, another).review.accepted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained failed retry, passing retry and interrupted history survive malformed siblings and untrusted provenance", () => {
  const root = makeFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.category = "bug";
    plan.steps.unshift({
      phase: "before",
      command: "verify",
      target: "greet",
      expectExitCode: 1,
    });
    plan.steps.at(-1).phase = "after";
    writeJson(root, "proof-plan.json", plan);
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => `Hello, ${name}!`;\n",
    );
    const session = JSON.parse(
      invoke(root, ["proof", "start", "proof-plan.json", "--execute"]).stdout,
    ).session;
    const failed = JSON.parse(
      invoke(root, ["proof", "finish", session, "--execute"]).stdout,
    ).path;
    writeFileSync(
      join(root, "src/domain/greeting.mjs"),
      "export const greeting = name => `Hello, ${name.trim()}!`;\n",
    );
    const passed = JSON.parse(
      invoke(root, ["proof", "finish", session, "--execute"]).stdout,
    ).path;
    const success = explainProof(root, passed);
    assert.equal(success.technical.valid, true);
    assert.equal(success.baseline[0].identicalArgv, true);
    const interrupted = randomUUID();
    const logOnly = randomUUID();
    writeJson(root, `.arrs/evidence/${logOnly}/000-check.json`, {
      untrusted: "retained incomplete capture",
    });
    writeJson(root, `.arrs/evidence/${interrupted}/attempt.json`, {
      schemaVersion: "0.1",
      session: "outside/secret.json",
    });
    const malformed = randomUUID();
    mkdirSync(join(root, `.arrs/evidence/${malformed}`));
    writeFileSync(join(root, `.arrs/evidence/${malformed}/proof.json`), "{broken");
    symlinkSync(join(root, "src"), join(root, ".arrs/evidence/symlink"));
    const before = snapshot(root);
    const history = JSON.parse(
      invoke(root, ["proof", "history", "--selected", passed]).stdout,
    );
    assert.deepEqual(validate("proof-history", history), []);
    assert.equal(history.entries[0].path, passed);
    assert.equal(history.entries.find((e) => e.path === failed).status, "failed");
    assert.equal(history.entries.find((e) => e.id === interrupted).status, "interrupted");
    assert.ok(
      history.entries
        .find((e) => e.id === interrupted)
        .diagnostics.some((d) => /hint.*outside/.test(d)),
    );
    assert.equal(history.entries.find((e) => e.id === malformed).status, "invalid");
    assert.equal(history.entries.find((e) => e.id === "symlink").status, "invalid");
    assert.equal(history.summary.accepted, 1);
    assert.equal(
      history.entries.find((entry) => entry.id === logOnly).status,
      "interrupted",
    );
    for (const selected of [
      session,
      `.arrs/evidence/${interrupted}/attempt.json`,
      `.arrs/evidence/${logOnly}`,
    ]) {
      const selectedHistory = proofHistory(root, undefined, selected);
      assert.equal(selectedHistory.entries[0].path, selected);
      assert.equal(selectedHistory.entries[0].selected, true);
    }
    assert.deepEqual(snapshot(root), before);
    const manifest = readJson(root, passed);
    manifest.results[0].argv.push("different");
    writeJson(root, passed, manifest);
    assert.equal(explainProof(root, passed).technical.valid, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTML exports escape hostile titles, criteria and argv; default excludes raw log text and preserves evidence", () => {
  const root = makeFixture();
  try {
    const path = proof(root, "R1", true);
    const before = snapshot(root);
    const exported = invoke(root, [
      "proof",
      "report",
      path,
      "--output",
      ".arrs/reports/private-preview",
    ]);
    assert.equal(exported.status, 0, exported.stdout);
    const html = readFileSync(join(root, JSON.parse(exported.stdout).path), "utf8");
    assert.match(html, /&lt;script&gt;window.pwned=true&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script|<img|<iframe|onerror="/i);
    assert.doesNotMatch(html, /\u001b/);
    // argv is intentional evidence metadata; raw log repetition is omitted.
    assert.match(html, /Raw logs omitted/);
    assert.match(html, /default-src 'none'/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(
      invoke(root, ["proof", "report", path, "--output", ".arrs/reports/private-preview"])
        .status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit excerpts verify original bytes, redact/truncate content, and label original/export hashes", () => {
  const root = makeFixture();
  try {
    const path = proof(root);
    const manifest = readJson(root, path);
    const result = manifest.results.at(-1);
    const log = readJson(root, result.log);
    log.stdout =
      "token=privatevalue Bearer privatebearer\n-----BEGIN " +
      "PRIVATE KEY-----\nprivatekey\n-----END PRIVATE KEY-----\n" +
      "🚀".repeat(6000);
    writeJson(root, result.log, log);
    result.sha256 = createHash("sha256")
      .update(readFileSync(join(root, result.log)))
      .digest("hex");
    writeJson(root, path, manifest);
    const before = snapshot(root);
    const exported = invoke(root, [
      "proof",
      "report",
      path,
      "--output",
      ".arrs/reports/redacted",
      "--excerpts",
    ]);
    assert.equal(exported.status, 0, exported.stdout);
    const html = readFileSync(join(root, JSON.parse(exported.stdout).path), "utf8");
    assert.doesNotMatch(html, /privatevalue|privatebearer|privatekey/);
    assert.match(html, /\[REDACTED\]/);
    assert.match(html, /truncated: true/);
    assert.match(html, new RegExp(result.sha256));
    assert.match(html, /Exported excerpt SHA-256/);
    for (const match of html.matchAll(/<pre>([^]*?)<\/pre>/g))
      assert.ok(
        Buffer.byteLength(match[1], "utf8") <= 8192,
        "Unicode exported excerpt exceeds 8192 bytes",
      );
    assert.deepEqual(snapshot(root), before);
    const raw = invoke(root, [
      "proof",
      "report",
      path,
      "--output",
      ".arrs/reports/unredacted",
      "--excerpts",
      "--redaction",
      "none",
    ]);
    assert.equal(raw.status, 0, raw.stdout);
    assert.match(
      readFileSync(join(root, JSON.parse(raw.stdout).path), "utf8"),
      /privatevalue/,
    );
    assert.equal(
      invoke(root, [
        "proof",
        "report",
        path,
        "--output",
        ".arrs/reports/no-choice",
        "--redaction",
        "none",
      ]).status,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe outputs/log references and unprotected report directories reject before writes", () => {
  const root = makeFixture();
  try {
    const path = proof(root);
    for (const output of [
      "../escape",
      "src/report",
      ".arrs/evidence/new",
      ".arrs/reports",
      ".arrs/reports/../escape",
    ]) {
      const result = invoke(root, ["proof", "report", path, "--output", output]);
      assert.equal(result.status, 1, result.stdout);
    }
    mkdirSync(join(root, ".arrs/reports"));
    symlinkSync(join(root, "src"), join(root, ".arrs/reports/alias"));
    assert.equal(
      invoke(root, ["proof", "report", path, "--output", ".arrs/reports/alias/new"])
        .status,
      1,
    );
    assert.equal(existsSync(join(root, "src/new")), false);
    const manifest = readJson(root, path);
    manifest.results[0].log = "src/domain/greeting.mjs";
    writeJson(root, path, manifest);
    assert.equal(
      invoke(root, ["proof", "report", path, "--output", ".arrs/reports/log-escape"])
        .status,
      1,
    );
    assert.equal(existsSync(join(root, ".arrs/reports/log-escape")), false);
    const root2 = makeFixture();
    try {
      const path2 = proof(root2);
      rmSync(join(root2, ".arrs/.gitignore"));
      assert.equal(
        invoke(root2, ["proof", "report", path2, "--output", ".arrs/reports/unprotected"])
          .status,
        1,
      );
      assert.equal(existsSync(join(root2, ".arrs/reports/unprotected")), false);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and oversized input produce bounded failure; unsupported flags execute no commands", () => {
  const root = makeFixture();
  try {
    const path = proof(root);
    writeFileSync(join(root, path), "{malformed");
    assert.equal(invoke(root, ["proof", "explain", path]).status, 1);
    assert.equal(explainProof(root, path).technical.valid, false);
    writeFileSync(join(root, path), "x".repeat(1024 * 1024 + 1));
    assert.match(explainProof(root, path).technical.errors.join(" "), /at most 1 MiB/);
    assert.equal(invoke(root, ["proof", "history", "--execute"]).status, 1);
    assert.equal(
      invoke(root, ["proof", "explain", path, "--output", ".arrs/reports/reject"]).status,
      1,
    );
    assert.equal(existsSync(join(root, ".arrs/reports/reject")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized review attachments cannot trigger an unbounded accepted-validator reread", () => {
  const root = makeFixture();
  try {
    const path = proof(root, "R3");
    const manifest = readJson(root, path);
    // This would satisfy shared acceptance if fully read; the bounded observer
    // must instead expose its limit without making a partial acceptance claim.
    const review = {
      schemaVersion: "0.1",
      stage: "implementation",
      proofId: manifest.id,
      manifestSha256: createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
      scopeHashes: manifest.scopeHashes,
      createdAt: new Date().toISOString(),
      independent: "Fixture separate reviewer " + "x".repeat(1024 * 1024),
      humanApproval: "Fixture acceptance assertion only",
    };
    writeJson(root, `${path.slice(0, -10)}review-${randomUUID()}.json`, review);
    const explanation = explainProof(root, path);
    assert.equal(explanation.technical.valid, true);
    assert.equal(explanation.review.status, "ready-for-review");
    assert.equal(explanation.review.accepted, false);
    assert.match(explanation.review.errors.join(" "), /Observer limit/);
    assert.match(explanation.review.attachments[0].errors.join(" "), /1 MiB read limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected evidence needs supplied retained baseline; legacy evidence remains explicitly limited", () => {
  const { root, source, flags } = makePolicyTransitionFixture();
  try {
    const plan = readJson(root, "proof-plan.json");
    plan.risk = "R3";
    plan.authorization = {
      humanApproval: "Fixture authorization for protected capture only",
    };
    plan.steps.push({ phase: "behavior", command: "verify", expectExitCode: 0 });
    writeJson(root, "proof-plan.json", plan);
    const capture = invoke(root, [
      "proof",
      "run",
      "proof-plan.json",
      "--execute",
      ...flags,
    ]);
    assert.equal(capture.status, 0, capture.stdout);
    const path = JSON.parse(capture.stdout).path;
    assert.equal(invoke(root, ["proof", "explain", path, ...flags]).status, 0);
    const missing = JSON.parse(invoke(root, ["proof", "explain", path]).stdout);
    assert.equal(missing.technical.valid, false);
    assert.equal(missing.review.accepted, false);
    assert.match(missing.technical.errors.join(" "), /independently supplied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("audit warning condensation retains detailed rejected history without changing accepted-evidence credit", async () => {
  const root = makeFixture();
  try {
    proof(root);
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      writeJson(root, `.arrs/evidence/${id}/proof.json`, {
        schemaVersion: "0.1",
        task: "invalid history",
      });
    }
    const result = await audit(root);
    assert.equal(result.proofHistoryWarnings.length, 4);
    assert.ok(result.warnings.some((w) => /4 historical proof warnings/.test(w)));
    assert.equal(result.controls.find((c) => c.id === "proof-evidence").passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Chromium renders hostile report text inert and makes no page network requests",
  { timeout: 30000 },
  async (t) => {
    const executable =
      process.env.ARRS_REPORT_BROWSER ??
      (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)
        ? process.env.CHROME_BIN
        : "/usr/bin/chromium");
    if (!existsSync(executable))
      return t.skip("Chromium is unavailable; browser verification remains explicit");
    const root = makeFixture();
    let browser;
    let browserClosed;
    let browserStartedAt;
    let browserError;
    let stderrBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let socket;
    const browserDiagnostic = (reason, error = browserError) =>
      JSON.stringify({
        reason,
        executable,
        pid: browser?.pid ?? null,
        elapsedMs:
          browserStartedAt === undefined
            ? null
            : Math.round(performance.now() - browserStartedAt),
        startupTimeoutMs: 10000,
        exitCode: browser?.exitCode ?? null,
        signalCode: browser?.signalCode ?? null,
        error: error
          ? {
              name: error.name,
              message: error.message,
              code: error.code,
              errno: error.errno,
              syscall: error.syscall,
            }
          : null,
        stderrBytes,
        stderrTail: stderrTail.toString("utf8"),
        devToolsActivePortPresent: existsSync(
          join(root, ".arrs/browser-profile/DevToolsActivePort"),
        ),
      });
    const waitForBrowserClose = async (timeoutMs) => {
      let timer;
      try {
        return await Promise.race([
          browserClosed.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const path = proof(root, "R1", true);
      const exported = invoke(root, [
        "proof",
        "report",
        path,
        "--output",
        ".arrs/reports/browser",
      ]);
      assert.equal(exported.status, 0, exported.stdout);
      const html = join(root, JSON.parse(exported.stdout).path);
      browserStartedAt = performance.now();
      browser = spawn(
        executable,
        [
          "--headless",
          "--no-sandbox",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--no-first-run",
          "--remote-debugging-port=0",
          `--user-data-dir=${join(root, ".arrs/browser-profile")}`,
          "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      browserClosed = new Promise((resolve) => browser.once("close", resolve));
      browser.on("error", (error) => {
        browserError = error;
      });
      const endpoint = await new Promise((resolve, reject) => {
        let settled = false;
        const clear = () => {
          clearTimeout(timer);
          browser.off("error", onError);
          browser.off("exit", onExit);
          browser.stderr.off("data", onData);
          browser.stderr.resume();
        };
        const fail = (reason, error) => {
          if (settled) return;
          settled = true;
          clear();
          reject(new Error(`Browser did not start: ${browserDiagnostic(reason, error)}`));
        };
        const onError = (error) => fail("spawn error", error);
        const onExit = () => fail("early exit");
        const onData = (chunk) => {
          stderrBytes += chunk.length;
          const observed = Buffer.concat([stderrTail, chunk]);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(
            observed.toString("utf8"),
          );
          stderrTail = observed.subarray(-8192);
          if (match && !settled) {
            settled = true;
            clear();
            resolve(match[1]);
          }
        };
        const timer = setTimeout(() => fail("startup timeout"), 10000);
        browser.once("error", onError);
        browser.once("exit", onExit);
        browser.stderr.on("data", onData);
      });
      t.diagnostic(
        JSON.stringify({
          status: "ready",
          executable,
          pid: browser.pid,
          elapsedMs: Math.round(performance.now() - browserStartedAt),
          startupTimeoutMs: 10000,
        }),
      );
      const url = new URL(endpoint);
      const targets = await (await fetch(`http://${url.host}/json/list`)).json();
      socket = new WebSocket(
        targets.find((target) => target.type === "page").webSocketDebuggerUrl,
      );
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const pending = new Map();
      const requests = [];
      let next = 1;
      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) {
          const p = pending.get(message.id);
          if (p) {
            pending.delete(message.id);
            message.error
              ? p.reject(new Error(JSON.stringify(message.error)))
              : p.resolve(message.result);
          }
        }
        if (message.method === "Network.requestWillBeSent")
          requests.push(message.params.request.url);
      });
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      await send("Network.enable");
      await send("Page.enable");
      // Managed browsers can prohibit file: navigation. Feed the exact generated
      // bytes to Chromium's document renderer, without adding an HTTP server.
      const tree = await send("Page.getFrameTree");
      await send("Page.setDocumentContent", {
        frameId: tree.frameTree.frame.id,
        html: readFileSync(html, "utf8"),
      });
      const dom = await send("Runtime.evaluate", {
        expression:
          "JSON.stringify({url:location.href,pwned: window.pwned === true, active: document.querySelectorAll('script,img,iframe,object,embed,form').length, activeHtml: [...document.querySelectorAll('script,img,iframe,object,embed,form')].map(e=>e.outerHTML.slice(0,200)), text: document.body.innerText, links: [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))})",
        returnByValue: true,
      });
      const result = JSON.parse(dom.result.value);
      assert.equal(result.pwned, false);
      assert.equal(
        result.active,
        0,
        JSON.stringify({
          url: result.url,
          activeHtml: result.activeHtml,
          text: result.text.slice(0, 1000),
        }),
      );
      assert.ok(result.text.includes("<script>window.pwned=true</script>"));
      assert.ok(
        result.links.every((link) => link.startsWith("#") || link === "explanation.json"),
      );
      assert.equal(
        requests.filter((request) => /^https?:/.test(request)).length,
        0,
        JSON.stringify(requests),
      );
      assert.equal(requests.length, 0, JSON.stringify(requests));
    } finally {
      try {
        socket?.close();
        if (browser && browser.exitCode === null && browser.signalCode === null) {
          browser.kill("SIGTERM");
          if (!(await waitForBrowserClose(1000))) {
            browser.kill("SIGKILL");
            if (!(await waitForBrowserClose(1000)))
              throw new Error(
                `Browser did not stop: ${browserDiagnostic("cleanup timeout")}`,
              );
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
