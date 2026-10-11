import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillsCommand,
  testSkillPack,
  testSkillPackDirectory,
} from "../dist/workflows/skills.js";
import { makeFixture, packageRoot, readJson, writeJson, invoke } from "./helpers.mjs";
import { checkSkills } from "../dist/core/skills-check.js";
import { doctor } from "../dist/core/doctor.js";
import { audit } from "../dist/core/audit.js";
const hash = (data) => createHash("sha256").update(data).digest("hex");
function editDocument(base, transform, refreshHash = true) {
  const pack = readJson(base, "pack.json");
  const entry = pack.skills[0];
  const file = join(base, entry.path);
  const content = transform(readFileSync(file, "utf8"));
  writeFileSync(file, content);
  if (refreshHash) entry.sha256 = hash(content);
  writeJson(base, "pack.json", pack);
}
function editMetadata(base, path, transform) {
  const value = readJson(base, path);
  transform(value);
  writeJson(base, path, value);
}
const installed = (root) => join(root, ".agent/skills");
const cleanup = (...paths) =>
  paths.forEach((path) => rmSync(path, { recursive: true, force: true }));
function candidate(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "arrs skills candidate "));
  cpSync(join(packageRoot, "upstream/mattpocock"), directory, { recursive: true });
  const manifest = readJson(directory, "manifest.json");
  manifest.revision = "a".repeat(40);
  mutate(directory, manifest);
  writeJson(directory, "manifest.json", manifest);
  return directory;
}
function change(directory, manifest, path, text) {
  mkdirSync(join(directory, "source", path, ".."), { recursive: true });
  writeFileSync(join(directory, "source", path), text);
  manifest.files[path] = hash(text);
}

test("skills CLI, doctor and audit share the strict installed pack contract", async (t) => {
  const cases = [
    ["valid offline installation", () => {}, null],
    ...["Call the Skill tool", "claude --bg", "Codex-specific"].map((text) => [
      text,
      (base) => editDocument(base, (content) => `${content}\n${text}\n`),
      /vendor-specific/,
    ]),
    [
      "modified document hash",
      (base) => editDocument(base, (text) => `${text}\nLocal change.\n`, false),
      /hash changed/,
    ],
    [
      "document below concise bound",
      (base) => editDocument(base, (text) => text.slice(0, 350)),
      /concise/,
    ],
    [
      "document above concise bound",
      (base) => editDocument(base, (text) => `${text}\n${"x".repeat(7100)}\n`),
      /concise/,
    ],
    [
      "missing frontmatter",
      (base) => editDocument(base, (text) => text.replace(/^---\n/, "")),
      /frontmatter/,
    ],
    [
      "missing heading",
      (base) =>
        editDocument(base, (text) => text.replace("## Completion", "## Outcomes")),
      /Completion/,
    ],
    [
      "missing required term",
      (base) =>
        editMetadata(base, "pack.json", (pack) =>
          pack.skills[0].requiredTerms.push("absent synthetic workflow requirement"),
        ),
      /workflow requirement/,
    ],
    [
      "empty required term",
      (base) =>
        editMetadata(base, "pack.json", (pack) => pack.skills[0].requiredTerms.push("")),
      /Invalid skill entry/,
    ],
    [
      "nonstring changes",
      (base) =>
        editMetadata(
          base,
          "provenance.json",
          (value) => (Object.values(value.adaptations)[0].changes = [17]),
        ),
      /Invalid skill adaptation/,
    ],
    [
      "array adaptations",
      (base) =>
        editMetadata(base, "provenance.json", (value) => (value.adaptations = [])),
      /Invalid skill provenance/,
    ],
    [
      "array source hashes",
      (base) =>
        editMetadata(
          base,
          "provenance.json",
          (value) => (Object.values(value.adaptations)[0].sourceHashes = []),
        ),
      /Invalid skill adaptation/,
    ],
    [
      "missing inspection date",
      (base) => editMetadata(base, "manifest.json", (value) => delete value.inspectedAt),
      /snapshot manifest/,
    ],
    [
      "missing license inventory",
      (base) =>
        editMetadata(base, "manifest.json", (value) => delete value.files.LICENSE),
      /preserve LICENSE/,
    ],
    [
      "duplicate source inventory",
      (base) =>
        editMetadata(base, "manifest.json", (value) =>
          value.skillSources.push(value.skillSources[0]),
        ),
      /inventory every/,
    ],
    [
      "stale source revision",
      (base) =>
        editMetadata(
          base,
          "provenance.json",
          (value) => (value.upstreamRevision = "a".repeat(40)),
        ),
      /revision differ/,
    ],
    [
      "stale source bundle hash",
      (base) =>
        editMetadata(base, "provenance.json", (value) => {
          const adaptation = Object.values(value.adaptations).find(
            (entry) => Object.keys(entry.sourceHashes).length,
          );
          adaptation.sourceHashes[Object.keys(adaptation.sourceHashes)[0]] = "a".repeat(
            64,
          );
        }),
      /source bundle/,
    ],
    [
      "removed attribution",
      (base) => writeFileSync(join(base, "UPSTREAM-LICENSE"), "removed"),
      /exact pinned upstream/,
    ],
    [
      "unsafe path",
      (base) =>
        editMetadata(
          base,
          "pack.json",
          (value) => (value.skills[0].path = "../../outside/SKILL.md"),
        ),
      /Invalid skill entry/,
    ],
  ];
  for (const [name, mutate, expected] of cases)
    await t.test(name, async () => {
      const root = makeFixture(4);
      try {
        mutate(installed(root));
        const core = checkSkills(root);
        const workflow = testSkillPack(root);
        assert.deepEqual(core, workflow, `${name}: helpers must report the same errors`);
        if (expected) assert.match(core.join("; "), expected);
        else assert.deepEqual(core, []);
        const cliResult = invoke(root, ["skills", "test"]);
        assert.equal(
          cliResult.status,
          expected ? 1 : 0,
          cliResult.stdout + cliResult.stderr,
        );
        const diagnostics = await doctor(root);
        assert.equal(
          diagnostics.checks.find((item) => item.id === "skills").passed,
          !expected,
        );
        const report = await audit(root);
        assert.equal(
          report.controls.find((item) => item.id === "skills").passed,
          !expected,
        );
      } finally {
        cleanup(root);
      }
    });
});

test("reconciliation candidates validate strict metadata before semantic acceptance", async () => {
  const root = makeFixture(4);
  try {
    const base = installed(root);
    const candidate = () => ({
      pack: readJson(base, "pack.json"),
      provenance: readJson(base, "provenance.json"),
      upstream: readJson(base, "manifest.json"),
      licenseText: readFileSync(join(base, "UPSTREAM-LICENSE"), "utf8"),
    });
    assert.deepEqual(testSkillPackDirectory(base, candidate()), []);
    assert.match(testSkillPackDirectory(base, null).join("; "), /Invalid skill pack/);
    assert.match(
      testSkillPackDirectory(base, { ...candidate(), licenseText: null }).join("; "),
      /Invalid skill candidate license/,
    );
    for (const [field, expected] of [
      ["pack", /Invalid skill pack/],
      ["provenance", /Invalid skill provenance/],
      ["upstream", /snapshot manifest/],
    ]) {
      for (const invalid of [null, undefined]) {
        const value = candidate();
        value[field] = invalid;
        assert.match(testSkillPackDirectory(base, value).join("; "), expected);
      }
    }
    for (const [mutate, expected] of [
      [
        (value) => (Object.values(value.provenance.adaptations)[0].changes = [17]),
        /Invalid skill adaptation/,
      ],
      [(value) => (value.pack.skills[0].requiredTerms = [""]), /Invalid skill entry/],
      [(value) => delete value.upstream.inspectedAt, /snapshot manifest/],
    ]) {
      const value = candidate();
      mutate(value);
      assert.match(testSkillPackDirectory(base, value).join("; "), expected);
    }
  } finally {
    cleanup(root);
  }
});

test("current upstream snapshot and compatibility matrix cover every discovered source with full hashes", () => {
  const root = join(packageRoot, "upstream/mattpocock");
  const manifest = readJson(root, "manifest.json"),
    matrix = readJson(root, "compatibility.json");
  assert.equal(manifest.revision.length, 40);
  assert.equal(manifest.license, "MIT");
  assert.equal(matrix.revision, manifest.revision);
  assert.deepEqual(
    matrix.skills.map((row) => row.source).sort(),
    [...manifest.skillSources].sort(),
  );
  for (const [path, digest] of Object.entries(manifest.files))
    assert.equal(hash(readFileSync(join(root, "source", path))), digest, path);
  for (const row of matrix.skills) {
    assert.ok(["ADOPT", "ADAPT", "WRAP", "REPLACE", "EXCLUDE"].includes(row.disposition));
    for (const field of [
      "purpose",
      "invocation",
      "inputs",
      "outputs",
      "dependencies",
      "assumptions",
      "repositoryAssumptions",
      "trackerAssumptions",
      "minimalContext",
      "riskCompatibility",
      "proofCompatibility",
      "architectureAndVerification",
      "rationale",
    ])
      assert.ok(row[field]?.length > 3, `${row.source}: ${field}`);
  }
});
test("pack installation works offline, validates provenance and is idempotent", async () => {
  const root = makeFixture();
  try {
    const first = await skillsCommand(root, "install", []);
    assert.equal(first.passed, true);
    assert.ok(first.installed.length > 10);
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
    const second = await skillsCommand(root, "install", []);
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.conflicts, []);
    const status = await skillsCommand(root, "status", []);
    assert.equal(status.offline, true);
    assert.equal(status.stagedRevision, null);
    assert.deepEqual(status.integrityErrors, []);
    assert.match(
      readFileSync(join(installed(root), "UPSTREAM-LICENSE"), "utf8"),
      /Copyright \(c\) 2026 Matt Pocock/,
    );
  } finally {
    cleanup(root);
  }
});
test("existing adaptations and existing metadata are never overwritten by installation", async () => {
  const root = makeFixture();
  try {
    mkdirSync(join(installed(root), "arrs-debug"), { recursive: true });
    writeFileSync(
      join(installed(root), "arrs-debug/SKILL.md"),
      "our independently edited workflow",
    );
    const result = await skillsCommand(root, "install", []);
    assert.ok(result.conflicts.includes("arrs-debug/SKILL.md"));
    assert.equal(result.passed, false);
    assert.equal(
      readFileSync(join(installed(root), "arrs-debug/SKILL.md"), "utf8"),
      "our independently edited workflow",
    );
    const manifest = readFileSync(join(installed(root), "pack.json"));
    await skillsCommand(root, "install", []);
    assert.deepEqual(readFileSync(join(installed(root), "pack.json")), manifest);
  } finally {
    cleanup(root);
  }
});
test("source sync detects changes to supporting references and preserves every adaptation", async () => {
  const root = makeFixture(),
    source = candidate((directory, manifest) =>
      change(
        directory,
        manifest,
        "skills/engineering/tdd/tests.md",
        "# Refreshed observable testing guidance\n",
      ),
    );
  try {
    await skillsCommand(root, "install", []);
    const text = readFileSync(join(installed(root), "arrs-tdd/SKILL.md"));
    const offline = await skillsCommand(root, "sync", []);
    assert.equal(offline.staged, false);
    const synced = await skillsCommand(root, "sync", ["--source", source]);
    assert.equal(synced.adaptationsOverwritten, false);
    const diff = await skillsCommand(root, "diff", []);
    assert.equal(diff.sourceChanges[0].path, "skills/engineering/tdd/tests.md");
    assert.equal(diff.changedSourceSkills[0], "skills/engineering/tdd/SKILL.md");
    assert.match(diff.sourceChanges[0].afterText, /Refreshed observable/);
    assert.ok(
      diff.adaptations
        .find((entry) => entry.id === "arrs-tdd")
        .adaptedText.includes("Proof Contract"),
    );
    assert.deepEqual(readFileSync(join(installed(root), "arrs-tdd/SKILL.md")), text);
    assert.equal(
      readJson(installed(root), "provenance.json").upstreamRevision,
      readJson(packageRoot, "upstream/mattpocock/manifest.json").revision,
    );
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Reviewed the upstream testing change.",
      ]),
      /Review affected adaptation/,
    );
    const result = await skillsCommand(root, "reconcile", [
      "--rationale",
      "ARRS already covers observable interface testing.",
      "--keep",
      "arrs-tdd",
    ]);
    assert.equal(result.packTestsPassed, true);
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
    assert.deepEqual(readFileSync(join(installed(root), "arrs-tdd/SKILL.md")), text);
    assert.equal(
      readJson(installed(root), "provenance.json").upstreamRevision,
      "a".repeat(40),
    );
    assert.equal((await skillsCommand(root, "status", [])).stagedRevision, null);
  } finally {
    cleanup(root, source);
  }
});
test("deliberate adaptation changes require a new version and pass contracts before provenance advances", async () => {
  const root = makeFixture(),
    source = candidate((directory, manifest) =>
      change(
        directory,
        manifest,
        "skills/engineering/tdd/tests.md",
        "# Updated behavior testing\n",
      ),
    );
  try {
    await skillsCommand(root, "install", []);
    await skillsCommand(root, "sync", ["--source", source]);
    const file = join(installed(root), "arrs-tdd/SKILL.md"),
      initial = readFileSync(file, "utf8");
    writeFileSync(
      file,
      `${initial}\nKeep acceptance scenarios stable during red and green runs.\n`,
    );
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Reviewed the source and updated the workflow.",
        "--keep",
        "arrs-tdd",
      ]),
      /Modified adaptation requires/,
    );
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Reviewed the source and updated the workflow.",
        "--adaptation",
        "arrs-tdd=0.1.0",
      ]),
      /new semantic version/,
    );
    writeFileSync(
      file,
      initial
        .replaceAll("public interface", "private collaborator")
        .replaceAll("public seam", "private seam"),
    );
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Reviewed the source and updated the workflow.",
        "--adaptation",
        "arrs-tdd=0.1.1",
      ]),
      /tests failed/,
    );
    assert.notEqual(
      readJson(installed(root), "provenance.json").upstreamRevision,
      "a".repeat(40),
    );
    writeFileSync(
      file,
      `${initial}\nKeep acceptance scenarios stable during red and green runs.\n`,
    );
    await skillsCommand(root, "reconcile", [
      "--rationale",
      "Keep original acceptance scenarios stable; upstream tests clarify this.",
      "--adaptation",
      "arrs-tdd=0.1.1",
    ]);
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
    assert.equal(
      readJson(installed(root), "provenance.json").adaptations["arrs-tdd"]
        .adaptationVersion,
      "0.1.1",
    );
    assert.match(readFileSync(file, "utf8"), /Keep acceptance scenarios stable/);
  } finally {
    cleanup(root, source);
  }
});
test("new upstream workflows require an explicit disposition and are detected without a hard-coded list", async () => {
  const path = "skills/engineering/new-workflow/SKILL.md";
  const root = makeFixture(),
    source = candidate((directory, manifest) => {
      change(
        directory,
        manifest,
        path,
        "---\nname: new-workflow\ndescription: An upstream addition.\n---\n",
      );
      manifest.skillSources.push(path);
    });
  try {
    await skillsCommand(root, "install", []);
    await skillsCommand(root, "sync", ["--source", source]);
    assert.deepEqual((await skillsCommand(root, "status", [])).newSkills, [path]);
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "The new source is not needed by ARRS.",
      ]),
      /New upstream skill requires explicit/,
    );
    await skillsCommand(root, "reconcile", [
      "--rationale",
      "Exclude the new source pending compatibility assessment.",
      "--disposition",
      `${path}=EXCLUDE`,
    ]);
    const provenance = readJson(installed(root), "provenance.json");
    assert.equal(provenance.reconciliations[0].dispositions[path], "EXCLUDE");
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
  } finally {
    cleanup(root, source);
  }
});
test("deleted selected source requires explicit removal while its adaptation survives", async () => {
  const path = "skills/engineering/tdd/SKILL.md";
  const root = makeFixture(),
    source = candidate((directory, manifest) => {
      rmSync(join(directory, "source", path));
      delete manifest.files[path];
      manifest.skillSources = manifest.skillSources.filter((entry) => entry !== path);
    });
  try {
    await skillsCommand(root, "install", []);
    const before = readFileSync(join(installed(root), "arrs-tdd/SKILL.md"));
    await skillsCommand(root, "sync", ["--source", source]);
    assert.deepEqual((await skillsCommand(root, "diff", [])).deletedSkills, [path]);
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Keep our testing discipline after upstream deletion.",
        "--keep",
        "arrs-tdd",
      ]),
      /Removed source requires/,
    );
    await skillsCommand(root, "reconcile", [
      "--rationale",
      "Keep the existing ARRS workflow as a native retained discipline.",
      "--keep",
      "arrs-tdd",
      "--disposition",
      `${path}=EXCLUDE`,
    ]);
    assert.deepEqual(readFileSync(join(installed(root), "arrs-tdd/SKILL.md")), before);
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
    assert.equal(
      readJson(installed(root), "provenance.json").adaptations["arrs-tdd"].sourceRevision,
      null,
    );
  } finally {
    cleanup(root, source);
  }
});
test("malformed inventories, missing source hashes and forged same revision are rejected", async () => {
  const root = makeFixture(),
    malformed = candidate((directory, manifest) => {
      change(directory, manifest, "skills/engineering/tdd/SKILL.md", "tampered");
      manifest.files["skills/engineering/tdd/SKILL.md"] = "0".repeat(64);
    });
  const forged = candidate((directory, manifest) => {
    manifest.revision = readJson(
      packageRoot,
      "upstream/mattpocock/manifest.json",
    ).revision;
    change(
      directory,
      manifest,
      "skills/engineering/tdd/tests.md",
      "same revision changed",
    );
  });
  try {
    await skillsCommand(root, "install", []);
    await assert.rejects(
      skillsCommand(root, "sync", ["--source", malformed]),
      /hash mismatch/,
    );
    await skillsCommand(root, "sync", ["--source", forged]);
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "This source cannot change at the same commit.",
        "--keep",
        "arrs-tdd",
      ]),
      /same pinned revision/,
    );
  } finally {
    cleanup(root, malformed, forged);
  }
});
test("pack rejects broken contracts, missing attribution and traversal paths", async () => {
  const root = makeFixture();
  try {
    await skillsCommand(root, "install", []);
    writeFileSync(join(installed(root), "UPSTREAM-LICENSE"), "removed");
    assert.ok(testSkillPack(root).some((error) => error.includes("MIT")));
    const pack = readJson(installed(root), "pack.json");
    pack.skills[0].path = "../../outside/SKILL.md";
    writeJson(installed(root), "pack.json", pack);
    assert.ok(testSkillPack(root).some((error) => error.includes("Invalid skill entry")));
  } finally {
    cleanup(root);
  }
});
test(
  "installer refuses symlink destinations without writing outside repository",
  { skip: process.platform === "win32" },
  async () => {
    const root = makeFixture(),
      outside = mkdtempSync(join(tmpdir(), "arrs-skills-outside-"));
    try {
      mkdirSync(installed(root), { recursive: true });
      symlinkSync(outside, join(installed(root), "arrs-debug"), "dir");
      await assert.rejects(skillsCommand(root, "install", []), /Symlink/);
      assert.ok(!existsSync(join(outside, "SKILL.md")));
    } finally {
      cleanup(root, outside);
    }
  },
);
test("CLI skill options retain failures and malformed flags fail closed", () => {
  const root = makeFixture();
  try {
    assert.equal(invoke(root, ["skills", "install"]).status, 0);
    assert.equal(invoke(root, ["skills", "test"]).status, 0);
    assert.equal(invoke(root, ["skills", "sync", "--fecth"]).status, 1);
    assert.equal(invoke(root, ["skills", "sync", "--source"]).status, 1);
    writeFileSync(join(installed(root), "arrs-debug/SKILL.md"), "broken");
    assert.equal(invoke(root, ["skills", "test"]).status, 1);
  } finally {
    cleanup(root);
  }
});

test("reserved cache locations cannot be configured as adaptation destinations or deleted on reconcile", async () => {
  for (const path of [
    ".arrs/skills/base",
    ".arrs/skills/staged",
    "./.arrs/skills/base",
    ".arrs",
  ]) {
    const root = makeFixture();
    try {
      const config = readJson(root, "arrs.json");
      config.skills.path = path;
      writeJson(root, "arrs.json", config);
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(
        join(root, path, "original.txt"),
        "User-authored adaptation must survive.",
      );
      assert.deepEqual(checkSkills(root), testSkillPack(root));
      assert.match(checkSkills(root).join("; "), /reserved \.arrs/);
      for (const action of ["install", "status", "diff", "sync", "reconcile", "test"]) {
        await assert.rejects(
          skillsCommand(
            root,
            action,
            action === "reconcile"
              ? ["--rationale", "Keep these authored adaptations safe."]
              : [],
          ),
          /reserved \.arrs/,
        );
        assert.equal(
          readFileSync(join(root, path, "original.txt"), "utf8"),
          "User-authored adaptation must survive.",
        );
      }
    } finally {
      cleanup(root);
    }
  }
});

test("changed upstream MIT notice requires explicit license review and is preserved in full", async () => {
  const root = makeFixture(),
    source = candidate((directory, manifest) =>
      change(
        directory,
        manifest,
        "LICENSE",
        readFileSync(join(directory, "source/LICENSE"), "utf8") +
          "\nAdditional copyright notice from the upstream maintainer.\n",
      ),
    );
  try {
    await skillsCommand(root, "install", []);
    await skillsCommand(root, "sync", ["--source", source]);
    await assert.rejects(
      skillsCommand(root, "reconcile", [
        "--rationale",
        "Reviewed the updated upstream MIT notice.",
      ]),
      /LICENSE changed/,
    );
    await skillsCommand(root, "reconcile", [
      "--rationale",
      "Reviewed and retained the complete upstream MIT notice.",
      "--license-reviewed",
    ]);
    assert.deepEqual(
      readFileSync(join(installed(root), "UPSTREAM-LICENSE")),
      readFileSync(join(source, "source/LICENSE")),
    );
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
  } finally {
    cleanup(root, source);
  }
});

test("npm-omitted source blobs validate and materialize offline without modifying the package snapshot", async () => {
  const root = makeFixture(),
    source = candidate();
  try {
    const fallback = readJson(source, "packaging-blobs.json");
    const expected = readFileSync(join(source, "source/.gitignore"));
    assert.equal(fallback.files[".gitignore"].sha256, hash(expected));
    rmSync(join(source, "source/.gitignore"));
    await skillsCommand(root, "install", []);
    const result = await skillsCommand(root, "sync", ["--source", source]);
    assert.equal(result.staged, true);
    assert.equal(result.status.sourceChanges.length, 0);
    assert.deepEqual(
      readFileSync(join(root, ".arrs/skills/staged/source/.gitignore")),
      expected,
    );
    assert.equal(existsSync(join(source, "source/.gitignore")), false);
    await skillsCommand(root, "reconcile", [
      "--rationale",
      "Verified package-safe source inventory preserves every original git blob.",
    ]);
    assert.deepEqual(
      readFileSync(join(root, ".arrs/skills/base/source/.gitignore")),
      expected,
    );
    assert.deepEqual(testSkillPack(root), []);
    assert.deepEqual(checkSkills(root), []);
  } finally {
    cleanup(root, source);
  }
});

test("packaging fallbacks cannot bypass pinned hashes or hide a corrupted physical source", async () => {
  const root = makeFixture(),
    source = candidate();
  try {
    await skillsCommand(root, "install", []);
    const metadata = readJson(source, "packaging-blobs.json");
    const corrupt = Buffer.from("changed source bytes");
    metadata.files[".gitignore"] = {
      sha256: hash(corrupt),
      base64: corrupt.toString("base64"),
    };
    writeJson(source, "packaging-blobs.json", metadata);
    rmSync(join(source, "source/.gitignore"));
    await assert.rejects(
      skillsCommand(root, "sync", ["--source", source]),
      /Packaging blob hash\/inventory mismatch/,
    );
    writeJson(
      source,
      "packaging-blobs.json",
      readJson(packageRoot, "upstream/mattpocock/packaging-blobs.json"),
    );
    writeFileSync(join(source, "source/.gitignore"), "corrupt physical bytes");
    await assert.rejects(
      skillsCommand(root, "sync", ["--source", source]),
      /Upstream source hash mismatch/,
    );
    assert.equal(existsSync(join(root, ".arrs/skills/staged")), false);
  } finally {
    cleanup(root, source);
  }
});
