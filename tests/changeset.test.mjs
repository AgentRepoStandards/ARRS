import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cli, invoke, makeFixture, readJson, writeJson } from "./helpers.mjs";
import { inspectChangeset, validateChangesetSnapshot } from "../dist/core/changeset.js";
import { inspectPolicyBaseline } from "../dist/core/policy-baseline.js";

// Resolve the native executable without depending on a POSIX `which` command.
const actualGit = (process.env.PATH ?? "")
  .split(delimiter)
  .map((directory) =>
    resolve(directory, process.platform === "win32" ? "git.exe" : "git"),
  )
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
assert.ok(actualGit, "Changeset fixtures require a native Git executable on PATH");
function git(root, ...args) {
  const globalConfig = join(root, ".arrs/fixture-git-config");
  if (!existsSync(globalConfig)) {
    mkdirSync(join(root, ".arrs"), { recursive: true });
    writeFileSync(globalConfig, "");
  }
  const result = spawnSync(actualGit, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_AUTHOR_NAME: "ARRS fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "ARRS fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
let fixtureSeed;
const fixtureRoots = new Set();
after(() => {
  const errors = [];
  try {
    if (fixtureSeed)
      assert.equal(
        inventory(fixtureSeed.root),
        fixtureSeed.inventory,
        "Cases must leave the pristine native Git seed unchanged",
      );
  } catch (error) {
    errors.push(error);
  }
  for (const root of fixtureRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Changeset fixture seed integrity or cleanup failed",
    );
});
function fixture() {
  if (!fixtureSeed) {
    const root = makeFixture(3);
    fixtureRoots.add(root);
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    fixtureSeed = {
      root,
      base: git(root, "rev-parse", "HEAD"),
      inventory: inventory(root),
    };
  }
  const parent = mkdtempSync(join(tmpdir(), "arrs changeset copy "));
  fixtureRoots.add(parent);
  // Keep the initialized project.name/basename relationship without rewriting
  // tracked configuration. Each case receives independent Git and source bytes.
  const root = join(parent, basename(fixtureSeed.root));
  cpSync(fixtureSeed.root, root, { recursive: true });
  assert.equal(inventory(root), fixtureSeed.inventory);
  for (const path of ["", ".git", ".git/index", "src/domain/greeting.mjs"]) {
    const copied = statSync(join(root, path), { bigint: true });
    const seed = statSync(join(fixtureSeed.root, path), { bigint: true });
    assert.notDeepEqual(
      [copied.dev, copied.ino],
      [seed.dev, seed.ino],
      `Fixture copy must have an independent filesystem identity: ${path || "."}`,
    );
  }
  return { root, base: fixtureSeed.base };
}
function report(root, args, expected = 0, env, preload) {
  const result =
    env || preload
      ? spawnSync(
          process.execPath,
          [
            ...(preload ? ["--import", pathToFileURL(preload).href] : []),
            cli,
            ...args,
            "--root",
            root,
            "--json",
          ],
          {
            encoding: "utf8",
            env,
            timeout: 120000,
          },
        )
      : invoke(root, args);
  const value = JSON.parse(result.stdout);
  assert.equal(result.status, expected, JSON.stringify(value));
  return value;
}
// Native Windows spawn cannot execute shebang files. These two synthetic Git
// cases replace only the executable at the CLI's subprocess boundary, retaining
// the collector's exact argv and sanitized options/env. Ordinary cases use real Git.
function gitFixture(root, body) {
  const wrapper = join(root, ".git/git-fixture.mjs"),
    preload = join(root, ".git/git-preload.mjs");
  writeFileSync(wrapper, body);
  writeFileSync(
    preload,
    `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const nativeSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command === 'git'
  ? nativeSpawnSync(process.execPath, [${JSON.stringify(wrapper)}, ...args], options)
  : nativeSpawnSync(command, args, options);
syncBuiltinESMExports();
`,
  );
  return preload;
}
function sentinel(root, name, marker) {
  const script = join(root, ".git", `${name}.mjs`);
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);\n`,
  );
  return script;
}
function gitShellCommand(...args) {
  // Git runs configured command strings through its bundled shell on Windows too.
  return args
    .map((value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
    .join(" ");
}
function reportedRootFixture(root, reportedRoot, identities = {}) {
  const preload = join(root, ".git", "reported-root-preload.mjs");
  const canonicalIdentities = {};
  for (const [path, values] of Object.entries(identities)) {
    const canonical = realpathSync.native(path);
    if (canonicalIdentities[canonical])
      assert.deepEqual(canonicalIdentities[canonical], values);
    canonicalIdentities[canonical] = values;
  }
  const marker = join(root, ".git", "identity-overrides-consumed.json");
  // Model Windows realpath spelling aliases without changing the native Git
  // argv, its other results, or the actual filesystem entries being compared.
  writeFileSync(
    preload,
    `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const reportedRoot = ${JSON.stringify(reportedRoot)};
const identities = ${JSON.stringify(canonicalIdentities)};
const consumed = new Set();
const nativeSpawnSync = childProcess.spawnSync;
const nativeRealpathSync = fs.realpathSync;
const nativeLstatSync = fs.lstatSync;
childProcess.spawnSync = (command, args, options) => {
  const result = nativeSpawnSync(command, args, options);
  if (command === 'git' && args.includes('--show-toplevel') && result.status === 0)
    result.stdout = Buffer.from(reportedRoot + '\\n');
  return result;
};
fs.realpathSync = (path, options) => String(path) === reportedRoot
  ? reportedRoot
  : nativeRealpathSync(path, options);
fs.realpathSync.native = nativeRealpathSync.native;
fs.lstatSync = (path, options) => {
  const result = nativeLstatSync(path, options);
  const canonical = result && Object.keys(identities).length
    ? nativeRealpathSync.native(path)
    : null;
  const values = identities[canonical];
  if (result && values) {
    consumed.add(canonical);
    for (const key of ['dev', 'ino']) {
      if (values[key] !== undefined)
        result[key] = options?.bigint ? BigInt(values[key]) : Number(values[key]);
    }
  }
  return result;
};
if (Object.keys(identities).length)
  process.on('exit', () => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    planned: Object.keys(identities).sort(), consumed: [...consumed].sort()
  }), {flag: 'wx'}));
syncBuiltinESMExports();
`,
  );
  return preload;
}
function assertRootIdentityOverridesConsumed(root) {
  const marker = readJson(root, ".git/identity-overrides-consumed.json");
  assert.deepEqual(marker.consumed, marker.planned);
}
function snapshot(root, base) {
  return report(root, ["scope", "inspect", "--base", base]);
}
function file(root, name, text = "changed\n") {
  mkdirSync(join(root, name, ".."), { recursive: true });
  writeFileSync(join(root, name), text);
}
function inventory(root) {
  const hash = createHash("sha256");
  function visit(dir, prefix = "") {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = prefix + name.name;
      hash.update(path + "\0");
      if (name.isDirectory()) visit(join(dir, name.name), path + "/");
      else if (name.isFile()) hash.update(readFileSync(join(dir, name.name)));
    }
  }
  visit(root);
  return hash.digest("hex");
}

test("Git worktree root accepts a different spelling of the same directory", () => {
  const { root, base } = fixture();
  const alias = `${root}/.arrs/..`;
  const rootIdentity = statSync(root, { bigint: true });
  const aliasIdentity = statSync(alias, { bigint: true });
  assert.equal(aliasIdentity.dev, rootIdentity.dev);
  assert.equal(aliasIdentity.ino, rootIdentity.ino);
  const preload = reportedRootFixture(root, alias);
  const before = inventory(root);
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    0,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "git-complete");
  assert.equal(result.base, base);
  assert.deepEqual(result.layers, []);
  assert.equal(inventory(root), before);
});

test("Git worktree root rejects a genuine nested directory", () => {
  const { root, base } = fixture();
  const nested = join(root, "src");
  assert.notEqual(
    statSync(nested, { bigint: true }).ino,
    statSync(root, { bigint: true }).ino,
  );
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    reportedRootFixture(root, nested),
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
});

test("Git worktree root rejects a genuine sibling directory", () => {
  const { root, base } = fixture();
  const sibling = mkdtempSync(join(tmpdir(), "arrs-sibling-"));
  assert.notEqual(
    statSync(sibling, { bigint: true }).ino,
    statSync(root, { bigint: true }).ino,
  );
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    reportedRootFixture(root, sibling),
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
});

test("Git worktree root keeps adjacent large inode identities distinct", () => {
  const { root, base } = fixture();
  const sibling = mkdtempSync(join(tmpdir(), "arrs-large-inode-sibling-"));
  const preload = reportedRootFixture(root, sibling, {
    [root]: { dev: "7", ino: "9007199254740992" },
    [sibling]: { dev: "7", ino: "9007199254740993" },
  });
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
  assertRootIdentityOverridesConsumed(root);
});

test("Git worktree root rejects an alternate spelling when identity is unavailable", () => {
  const { root, base } = fixture();
  const alias = `${root}/.arrs/..`;
  const preload = reportedRootFixture(root, alias, {
    [root]: { dev: "0", ino: "0" },
    [alias]: { dev: "0", ino: "0" },
  });
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
  assertRootIdentityOverridesConsumed(root);
});

test("Git worktree root preserves exact-path admission when identity is unavailable", () => {
  const { root, base } = fixture();
  const preload = reportedRootFixture(root, root, {
    [root]: { dev: "0", ino: "0" },
  });
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    0,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "git-complete");
  assertRootIdentityOverridesConsumed(root);
});

test("Git worktree root rejects matching inode numbers on different devices", () => {
  const { root, base } = fixture();
  const sibling = mkdtempSync(join(tmpdir(), "arrs-other-device-sibling-"));
  const preload = reportedRootFixture(root, sibling, {
    [root]: { dev: "7", ino: "13" },
    [sibling]: { dev: "8", ino: "13" },
  });
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
  assertRootIdentityOverridesConsumed(root);
});

for (const [name, identity] of [
  ["device", { dev: "0", ino: "13" }],
  ["inode", { dev: "7", ino: "0" }],
]) {
  test(`Git worktree root rejects alternate spelling with only a zero ${name}`, () => {
    const { root, base } = fixture();
    const alias = `${root}/.arrs/..`;
    const preload = reportedRootFixture(root, alias, {
      [root]: identity,
      [alias]: identity,
    });
    const result = report(
      root,
      ["scope", "inspect", "--base", base],
      1,
      process.env,
      preload,
    );
    assert.equal(result.assurance, "unestablished");
    assert.match(
      result.diagnostics.join(";"),
      /Scope root must be the Git worktree root/,
    );
    assertRootIdentityOverridesConsumed(root);
  });
}

test("Git worktree root rejects a file even when reported identity matches", () => {
  const { root, base } = fixture();
  const sourceFile = join(root, "arrs.json");
  assert.equal(statSync(sourceFile).isDirectory(), false);
  const preload = reportedRootFixture(root, sourceFile, {
    [root]: { dev: "7", ino: "13" },
    [sourceFile]: { dev: "7", ino: "13" },
  });
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    preload,
  );
  assert.equal(result.assurance, "unestablished");
  assert.match(result.diagnostics.join(";"), /Scope root must be the Git worktree root/);
  assertRootIdentityOverridesConsumed(root);
});

test("explicit committed scope passes with pinned base/HEAD and no writes", () => {
  const { root, base } = fixture();
  file(
    root,
    "src/domain/greeting.mjs",
    "export const greeting = name => `Hi ${name.trim()}!`;\n",
  );
  git(root, "add", "src/domain/greeting.mjs");
  git(root, "commit", "-qm", "greeting update");
  const before = inventory(root),
    result = report(root, ["scope", "check", "proof-plan.json", "--base", base]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.covered, ["src/domain/greeting.mjs"]);
  assert.equal(result.inventory.base, base);
  assert.equal(result.inventory.head, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(snapshot(root, base), result.inventory);
  assert.equal(inventory(root), before);
});

test("committed, staged, unstaged and untracked paths all remain uncovered", () => {
  const { root, base } = fixture();
  file(root, "committed.txt");
  git(root, "add", "committed.txt");
  git(root, "commit", "-qm", "committed");
  file(root, "staged.txt");
  git(root, "add", "staged.txt");
  rmSync(join(root, "staged.txt"));
  file(root, "test.mjs", readFileSync(join(root, "test.mjs"), "utf8") + "// unstaged\n");
  file(root, "untracked.txt");
  const result = report(root, ["scope", "check", "proof-plan.json", "--base", base], 1);
  assert.deepEqual(result.uncovered, [
    "committed.txt",
    "staged.txt",
    "test.mjs",
    "untracked.txt",
  ]);
  assert.deepEqual(
    result.inventory.layers
      .filter((row) => row.paths.includes("staged.txt"))
      .map((row) => [row.layer, row.status]),
    [
      ["staged", "added"],
      ["unstaged", "deleted"],
    ],
  );
  const plan = readJson(root, "proof-plan.json");
  plan.scope = [
    "src",
    "committed.txt",
    "staged.txt",
    "test.mjs",
    "untracked.txt",
    "proof-plan.json",
  ];
  writeJson(root, "proof-plan.json", plan);
  assert.equal(
    report(root, ["scope", "check", "proof-plan.json", "--base", base]).passed,
    true,
  );
});

test("deleted sensitive source and rename endpoints preserve historical floors and targets", () => {
  const { root } = fixture();
  file(root, "src/domain/authorization.mjs", "export const allowed = true;\n");
  const config = readJson(root, "arrs.json"),
    policy = readJson(root, config.riskPolicy);
  policy.sensitivePaths.push({
    path: "src/domain/authorization.mjs",
    risk: "R3",
    reason: "Authorization boundary",
  });
  writeJson(root, config.riskPolicy, policy);
  const map = readJson(root, "docs/features/greeting.json");
  map.id = "authorization";
  map.risk = "R3";
  map.implementation = ["src/domain/authorization.mjs"];
  map.entryPoints = ["src/domain/authorization.mjs"];
  writeJson(root, "docs/features/authorization.json", map);
  git(root, "add", ".");
  git(root, "commit", "-qm", "sensitive baseline");
  const base = git(root, "rev-parse", "HEAD");
  renameSync(
    join(root, "src/domain/authorization.mjs"),
    join(root, "src/domain/public.mjs"),
  );
  rmSync(join(root, "docs/features/authorization.json"));
  policy.sensitivePaths = policy.sensitivePaths.filter(
    (item) => item.path !== "src/domain/authorization.mjs",
  );
  writeJson(root, config.riskPolicy, policy);
  git(root, "add", ".");
  const result = report(root, ["scope", "check", "proof-plan.json", "--base", base], 1);
  assert.equal(result.effectiveRisk, "R3", result.diagnostics.join(";"));
  assert.ok(result.verificationTargets.includes("greet"));
  assert.ok(
    result.features.some(
      (item) => item.id === "authorization" && item.provenance === "comparison-base",
    ),
  );
  const rename = result.inventory.layers.find((item) => item.status === "renamed");
  assert.deepEqual(rename.paths, [
    "src/domain/authorization.mjs",
    "src/domain/public.mjs",
  ]);
  const deletion = result.inventory.endpoints.find(
    (item) => item.path === "src/domain/authorization.mjs",
  );
  assert.ok(deletion.before.object);
  assert.equal(deletion.after, null);
  git(root, "config", "diff.renames", "false");
  assert.equal(
    report(root, ["scope", "check", "proof-plan.json", "--base", base], 1).effectiveRisk,
    "R3",
  );
});

test("deletion proof negotiates coverage, preserves absence and rejects restoration/state drift", () => {
  const { root } = fixture();
  file(root, "src/domain/obsolete.mjs", "export const obsolete = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "obsolete baseline");
  const base = git(root, "rev-parse", "HEAD");
  rmSync(join(root, "src/domain/obsolete.mjs"));
  const plan = readJson(root, "proof-plan.json");
  plan.scope.push("src/domain/obsolete.mjs", "proof-plan.json");
  plan.changeset = { version: "1", mode: "git", base };
  writeJson(root, "proof-plan.json", plan);
  const result = report(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(result.manifest.status, "passed");
  assert.equal(result.manifest.changesetSnapshot.assurance, "git-complete");
  assert.equal(report(root, ["proof", "validate", result.path]).valid, true);
  const before = inventory(root);
  const stale = structuredClone(result.manifest);
  stale.changesetSnapshot.head = "0".repeat(40);
  writeJson(root, ".arrs/tampered.json", stale);
  assert.equal(
    report(root, ["proof", "validate", ".arrs/tampered.json"], 1).valid,
    false,
  );
  rmSync(join(root, ".arrs/tampered.json"));
  assert.equal(inventory(root), before);
  file(root, "src/domain/obsolete.mjs", "export const obsolete = 1;\n");
  assert.match(
    report(root, ["proof", "validate", result.path], 1).errors.join(";"),
    /drifted|scope changed/,
  );
  rmSync(join(root, "src/domain/obsolete.mjs"));
  file(root, "new-untracked.txt");
  assert.equal(report(root, ["proof", "validate", result.path], 1).valid, false);
  rmSync(join(root, "new-untracked.txt"));
  git(root, "add", "src/domain/obsolete.mjs");
  assert.equal(report(root, ["proof", "validate", result.path], 1).valid, false);
});

test("uncovered deletion rejects before repository command or evidence effects", () => {
  const { root } = fixture();
  file(root, "authorization.txt");
  git(root, "add", ".");
  git(root, "commit", "-qm", "before deletion");
  const base = git(root, "rev-parse", "HEAD");
  rmSync(join(root, "authorization.txt"));
  const plan = readJson(root, "proof-plan.json");
  plan.changeset = { version: "1", mode: "git", base };
  plan.scope.push("proof-plan.json");
  writeJson(root, "proof-plan.json", plan);
  const before = inventory(root);
  const result = report(root, ["proof", "run", "proof-plan.json", "--execute"], 1);
  assert.match(result.error, /Uncovered changed paths.*authorization.txt/);
  assert.equal(inventory(root), before);
});

test("spaces, Unicode and leading dashes round trip through native NUL paths", () => {
  const { root, base } = fixture();
  const names = ["src/domain/space name", "src/domain/文.txt", "-leading-dash"];
  for (const name of names) file(root, name);
  git(root, "add", "--", ...names);
  const result = snapshot(root, base);
  assert.deepEqual(new Set(result.endpoints.map((item) => item.path)), new Set(names));
  assert.equal(result.layers.length, names.length);
});

test(
  "spaces, Unicode, tabs, newlines and leading dashes round trip through NUL paths",
  {
    skip:
      process.platform === "win32" &&
      "NTFS forbids tab/newline filenames; native representable paths are tested separately",
  },
  () => {
    const { root, base } = fixture();
    const names = [
      "src/domain/space name",
      "src/domain/文.txt",
      "src/domain/tab\tname",
      "src/domain/line\nname",
      "-leading-dash",
    ];
    for (const name of names) file(root, name);
    git(root, "add", "--", ...names);
    const result = snapshot(root, base);
    assert.deepEqual(new Set(result.endpoints.map((item) => item.path)), new Set(names));
    assert.equal(result.layers.length, names.length);
  },
);

test("source symlinks/traversal fail, root exclusions remain explicit and nested names remain source", () => {
  const { root, base } = fixture();
  file(root, "nested/node_modules/source.txt");
  file(root, "nested/.arrs/source.txt");
  git(root, "add", "-f", "nested/node_modules/source.txt", "nested/.arrs/source.txt");
  file(root, ".arrs/excluded.txt");
  git(root, "add", "-f", ".arrs/excluded.txt");
  let result = snapshot(root, base);
  assert.ok(result.endpoints.find((item) => item.path === ".arrs/excluded.txt").excluded);
  assert.ok(
    result.endpoints.find(
      (item) => item.path === "nested/.arrs/source.txt" && !item.excluded,
    ),
  );
  const link = join(root, "src/domain/escape");
  symlinkSync(tmpdir(), link, process.platform === "win32" ? "junction" : "dir");
  assert.match(
    report(root, ["scope", "inspect", "--base", base], 1).diagnostics.join(";"),
    /Symlink/,
  );
  rmSync(link, { recursive: process.platform === "win32" });
  const plan = readJson(root, "proof-plan.json");
  plan.scope = ["../escape"];
  writeJson(root, "proof-plan.json", plan);
  assert.match(
    report(
      root,
      ["scope", "check", "proof-plan.json", "--base", base],
      1,
    ).diagnostics.join(";"),
    /cannot contain/,
  );
});

test("hostile fsmonitor/diff/textconv/clean-filter/config injection invoke no sentinel and write no index", () => {
  const { root, base } = fixture();
  const marker = join(root, ".git/EXECUTED"),
    script = sentinel(root, "hostile", marker),
    hook = gitShellCommand(process.execPath, script);
  // Prove the sentinel can execute before testing that collection suppresses it.
  assert.equal(spawnSync(process.execPath, [script]).status, 1);
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  git(root, "config", "core.fsmonitor", hook);
  git(root, "config", "diff.external", hook);
  git(root, "config", "diff.hostile.textconv", hook);
  git(root, "config", "filter.hostile.clean", hook);
  file(root, ".gitattributes", "* diff=hostile filter=hostile\n");
  file(root, "src/domain/greeting.mjs", "changed raw bytes\n");
  const control = spawnSync(
    actualGit,
    [
      "-C",
      root,
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--ext-diff",
      "--",
      "src/domain/greeting.mjs",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, ".arrs/fixture-git-config"),
      },
      timeout: 10000,
    },
  );
  assert.notEqual(control.status, 0, control.stderr);
  assert.equal(
    existsSync(marker),
    true,
    "The configured Git helper sentinel must be runnable",
  );
  rmSync(marker);
  const before = inventory(root),
    env = {
      ...process.env,
      GIT_EXTERNAL_DIFF: hook,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: hook,
    };
  const result = report(root, ["scope", "inspect", "--base", base], 0, env);
  assert.equal(result.status, "complete");
  assert.equal(existsSync(marker), false);
  assert.equal(inventory(root), before);
});

test("missing Git and unqualified Git versions fail explicitly before collection", () => {
  const { root, base } = fixture();
  const empty = join(root, ".git/empty-bin");
  mkdirSync(empty);
  assert.equal(
    report(root, ["scope", "inspect", "--base", base], 1, { ...process.env, PATH: empty })
      .status,
    "unsupported",
  );
  const preload = gitFixture(root, "process.stdout.write('git version 2.40.0\\n');\n");
  assert.match(
    report(
      root,
      ["scope", "inspect", "--base", base],
      1,
      {
        ...process.env,
        PATH: empty,
      },
      preload,
    ).diagnostics.join(";"),
    /Unsupported Git version/,
  );
});

test("unborn HEAD/unresolved base and missing local promisor objects are incomplete without fetching", () => {
  const { root, base } = fixture();
  assert.equal(
    report(root, ["scope", "inspect", "--base", "no-such-commit"], 1).status,
    "incomplete",
  );
  const object = git(root, "rev-parse", "HEAD:src/domain/greeting.mjs"),
    marker = join(root, ".git/FETCHED"),
    trap = sentinel(root, "fetch", marker);
  // remote-ext escapes spaces with "% ", rather than shell quotes.
  const transport = [process.execPath, trap]
    .map((value) =>
      value.replaceAll("\\", "/").replaceAll("%", "%%").replaceAll(" ", "% "),
    )
    .join(" ");
  git(root, "config", "remote.origin.url", `ext::${transport}`);
  git(root, "config", "remote.origin.promisor", "true");
  git(root, "config", "extensions.partialClone", "origin");
  git(root, "config", "protocol.ext.allow", "always");
  const control = spawnSync(actualGit, ["-C", root, "fetch", "origin"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, ".arrs/fixture-git-config"),
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 10000,
  });
  assert.equal(control.status, 128, control.stderr);
  assert.equal(
    existsSync(marker),
    true,
    "The configured transport sentinel must be runnable",
  );
  rmSync(marker);
  rmSync(join(root, ".git/objects", object.slice(0, 2), object.slice(2)));
  assert.equal(
    report(root, ["scope", "inspect", "--base", base], 1).status,
    "incomplete",
  );
  assert.equal(existsSync(marker), false);
  const unborn = makeFixture(3);
  git(unborn, "init", "-q");
  assert.equal(
    report(unborn, ["scope", "inspect", "--base", base], 1).status,
    "incomplete",
  );
});

test("unsupported submodules/unmerged/skip-worktree index states cannot claim complete coverage", () => {
  const { root, base } = fixture();
  git(root, "update-index", "--add", "--cacheinfo", `160000,${base},submodule`);
  assert.notEqual(
    report(root, ["scope", "inspect", "--base", base], 1).status,
    "complete",
  );
  git(root, "update-index", "--force-remove", "submodule");
  git(root, "update-index", "--skip-worktree", "src/domain/greeting.mjs");
  assert.equal(
    report(root, ["scope", "inspect", "--base", base], 1).status,
    "unsupported",
  );
});

test("assume-unchanged cannot hide raw tracked edits and tracked ignore rules cannot exclude changes", () => {
  const { root, base } = fixture();
  git(root, "update-index", "--assume-unchanged", "src/domain/greeting.mjs");
  file(root, "src/domain/greeting.mjs", "hidden change\n");
  file(root, ".gitignore", "src/domain/greeting.mjs\nignored.txt\n");
  file(root, "ignored.txt");
  const result = snapshot(root, base);
  assert.ok(
    result.layers.some(
      (item) =>
        item.layer === "unstaged" && item.paths.includes("src/domain/greeting.mjs"),
    ),
  );
  assert.ok(!result.endpoints.some((item) => item.path === "ignored.txt"));
});

test("concurrent index and working drift are rejected by agreeing observations", () => {
  const { root, base } = fixture(),
    count = join(root, ".git/count"),
    source = join(root, "src/domain/greeting.mjs");
  const preload = gitFixture(
    root,
    `
import {spawnSync} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {constants} from 'node:os';
const args = process.argv.slice(2);
if (args.includes('ls-tree')) {
  const count = ${JSON.stringify(count)};
  const n = (existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0) + 1;
  writeFileSync(count, String(n));
  if (n === 3) {
    appendFileSync(${JSON.stringify(source)}, 'drift');
    const mutation = spawnSync(${JSON.stringify(actualGit)}, ['-C', ${JSON.stringify(root)}, 'add', 'src/domain/greeting.mjs'], {stdio:'inherit'});
    if (mutation.error || mutation.status !== 0) throw mutation.error ?? new Error('Drift fixture could not stage its source mutation');
  }
}
const result = spawnSync(${JSON.stringify(actualGit)}, args, {stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 128 + (constants.signals[result.signal] ?? 1);
`,
  );
  const result = report(
    root,
    ["scope", "inspect", "--base", base],
    1,
    process.env,
    preload,
  );
  assert.match(result.diagnostics.join(";"), /drifted/);
  assert.ok(Number(readFileSync(count, "utf8")) >= 3);
  assert.ok(readFileSync(source, "utf8").endsWith("drift"));
  assert.equal(
    git(root, "show", ":src/domain/greeting.mjs"),
    readFileSync(source, "utf8").trim(),
  );
});

test("manual mode stays declared-only and legacy proof cannot acquire a fabricated snapshot", () => {
  const { root, base } = fixture();
  const result = report(root, ["scope", "check", "proof-plan.json", "--manual"]);
  assert.equal(result.inventory.assurance, "declared-only");
  assert.match(result.diagnostics.join(";"), /unknown/);
  const plan = readJson(root, "proof-plan.json");
  assert.match(
    validateChangesetSnapshot(root, plan, inspectChangeset(root, base)).join(";"),
    /lacks explicit/,
  );
  assert.equal(
    report(root, ["scope", "inspect", "--manual", "src/domain"]).assurance,
    "declared-only",
  );
  assert.match(
    report(root, ["scope", "inspect", "--base", base, "--manual"], 1).error,
    /exactly one/,
  );
});

test("a comparison base cannot supply independently selected protected policy context", () => {
  const { root } = fixture();
  const config = readJson(root, "arrs.json"),
    policy = readJson(root, config.riskPolicy);
  policy.sensitivePaths.push({
    path: "arrs.json",
    risk: "R3",
    reason: "Governing command and policy configuration",
  });
  writeJson(root, config.riskPolicy, policy);
  const weak = structuredClone(policy);
  weak.sensitivePaths = [];
  weak.classes.R3.humanApproval = false;
  weak.classes.R3.autonomy = "review";
  writeJson(root, "controls/weak.json", weak);
  git(root, "add", ".");
  git(root, "commit", "-qm", "pre-change controls");
  const base = git(root, "rev-parse", "HEAD");
  const source = mkdtempSync(join(tmpdir(), "arrs changeset baseline "));
  cpSync(root, source, { recursive: true });
  const baseline = inspectPolicyBaseline(root, source);
  config.riskPolicy = "controls/weak.json";
  writeJson(root, "arrs.json", config);
  const plan = readJson(root, "proof-plan.json");
  plan.scope = ["arrs.json", "proof-plan.json"];
  plan.risk = "R3";
  plan.changeset = { version: "1", mode: "git", base };
  writeJson(root, "proof-plan.json", plan);
  const flags = ["--baseline", source, "--baseline-sha256", baseline.sha256],
    before = inventory(root);
  assert.match(
    report(root, ["proof", "run", "proof-plan.json", "--execute", ...flags], 1).error,
    /human approval authorization/,
  );
  assert.equal(inventory(root), before);
  plan.authorization = {
    humanApproval:
      "Fixture user authorized controlled local execution under the retained policy",
  };
  writeJson(root, "proof-plan.json", plan);
  const result = report(root, ["proof", "run", "proof-plan.json", "--execute", ...flags]);
  assert.match(
    report(root, ["proof", "validate", result.path], 1).errors.join(";"),
    /independently supplied/,
  );
  assert.equal(report(root, ["proof", "validate", result.path, ...flags]).valid, true);
});

test("negotiated bug proof preserves before evidence and immutable finish retries", () => {
  const { root } = fixture();
  const source = "src/domain/greeting.mjs",
    correct = readFileSync(join(root, source), "utf8");
  file(root, source, correct.replace("name.trim()", "name"));
  git(root, "add", source);
  git(root, "commit", "-qm", "faulty before endpoint");
  const base = git(root, "rev-parse", "HEAD"),
    plan = readJson(root, "proof-plan.json");
  plan.category = "bug";
  plan.scope.push("proof-plan.json");
  plan.changeset = { version: "1", mode: "git", base };
  plan.steps = [
    { phase: "before", command: "verify", target: "greet", expectExitCode: 1 },
    ...plan.steps.map((step) =>
      step.phase === "behavior" ? { ...step, phase: "after" } : step,
    ),
  ];
  writeJson(root, "proof-plan.json", plan);
  const start = report(root, ["proof", "start", "proof-plan.json", "--execute"]),
    before = readFileSync(join(root, start.session));
  file(root, source, correct);
  const first = report(root, ["proof", "finish", start.session, "--execute"]),
    firstBytes = readFileSync(join(root, first.path));
  const second = report(root, ["proof", "finish", start.session, "--execute"]);
  assert.notEqual(first.manifest.id, second.manifest.id);
  assert.deepEqual(readFileSync(join(root, start.session)), before);
  assert.deepEqual(readFileSync(join(root, first.path)), firstBytes);
  assert.equal(report(root, ["proof", "validate", first.path]).valid, true);
  assert.equal(report(root, ["proof", "validate", second.path]).valid, true);
});

test("source changes during execution preserve a failed attempt rather than stale success", () => {
  const { root, base } = fixture(),
    config = readJson(root, "arrs.json"),
    plan = readJson(root, "proof-plan.json");
  file(
    root,
    "mutating-verifier.mjs",
    "import {writeFileSync} from 'node:fs'; writeFileSync('outside-scope.txt', 'effect'); console.log('executed');\n",
  );
  config.verifyTargets.greet = { argv: [process.execPath, "mutating-verifier.mjs"] };
  writeJson(root, "arrs.json", config);
  plan.scope.push("arrs.json", "proof-plan.json", "mutating-verifier.mjs");
  plan.changeset = { version: "1", mode: "git", base };
  writeJson(root, "proof-plan.json", plan);
  const result = report(root, ["proof", "run", "proof-plan.json", "--execute"], 1);
  assert.equal(result.manifest.status, "failed");
  assert.ok(existsSync(join(root, result.path)));
  assert.ok(existsSync(join(root, "outside-scope.txt")));
  assert.match(result.errors.join(";"), /Uncovered|drifted/);
});
