import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../dist/core/audit.js";
import { checkCI, discoverCIWorkflow } from "../dist/core/ci.js";
import { initRepository } from "../dist/workflows/init.js";
import { readJson, writeJson } from "./helpers.mjs";

const valid = `name: qualification
on: [push, pull_request]
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - run: ./repo check
      - run: ./repo test
      - run: ./repo verify
      - run: arrs audit --execute --require-level 4
`;
const ignoredFailure = `continue-on-error:${" true"}`;

function fixture(t, workflow = valid, path = ".github/workflows/ci.yml") {
  const root = mkdtempSync(join(tmpdir(), "arrs ci "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepository(root);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, path), workflow);
  const config = readJson(root, "arrs.json");
  config.ci.workflow = path;
  writeJson(root, "arrs.json", config);
  return { root, config };
}

async function ci(root) {
  return (await audit(root)).controls.find((control) => control.id === "ci");
}

function needsWorkflow(needs, extra = "") {
  return valid.replace("    runs-on:", `${needs}\n    runs-on:`) + extra;
}

function extraJob(name, needs = "") {
  return `  ${name}:\n${needs ? `    needs: ${needs}\n` : ""}    runs-on: ubuntu-latest\n    steps:\n      - run: echo auxiliary\n`;
}

test("CI rejects malformed descendants at workflow, job and step boundaries", async (t) => {
  const workflows = [
    ...[
      "needs: absent",
      "if: false",
      "name: hidden",
      "continuation",
      "- name: hidden",
    ].map((descendant) =>
      valid.replace(
        "    runs-on: ubuntu-latest",
        `    runs-on: ubuntu-latest\n      ${descendant}`,
      ),
    ),
    valid.replace("name: qualification", "name: qualification\n  name: hidden"),
    valid.replace("name: qualification", "  name: qualification"),
    valid.replace("on: [push, pull_request]", "on: [push, pull_request]\n  - push"),
    valid.replace(
      "      - run: ./repo check",
      "      - name: check\n          if: false\n        run: ./repo check",
    ),
    valid.replace(
      "      - run: ./repo check",
      "      - name: check\n        run: ./repo check\n          name: hidden",
    ),
    valid.replace("      - run: ./repo test", "       - run: ./repo test"),
    ...["          ./repo check", "          # literal content"].map((first) =>
      valid.replace(
        "      - run: ./repo check\n      - run: ./repo test",
        `      - run: |\n${first}\n         ./repo check\n         ./repo test`,
      ),
    ),
    valid.replace(
      "on: [push, pull_request]",
      "on:\n  workflow_dispatch:\n    inputs:\n      mode:\n        type: choice\n        options:\n          - development\n            name: hidden",
    ),
    valid.replace(
      "    steps:",
      "    env:\n      MODE: test\n        name: hidden\n    steps:",
    ),
  ];
  for (const workflow of workflows) {
    const { root, config } = fixture(t, workflow);
    assert.match(
      checkCI(root, config).join(";"),
      /(?:Invalid|Unsupported) CI YAML.*\.github\/workflows\/ci\.yml:\d+/,
      workflow,
    );
    assert.equal((await ci(root)).passed, false, workflow);
  }
});

test("CI establishes literal ownership across dedented comments and leading blanks", async (t) => {
  const malformed = [
    ...[7, 8, 9].flatMap((commentIndent) =>
      [9, 10].map((contentIndent) =>
        valid.replace(
          "      - run: ./repo check\n      - run: ./repo test",
          `      - run: |\n          ./repo check\n${" ".repeat(commentIndent)}# outside literal\n${" ".repeat(contentIndent)}./repo test`,
        ),
      ),
    ),
    valid.replace(
      "      - run: ./repo check\n      - run: ./repo test",
      `      - run: |\n${" ".repeat(12)}\n          ./repo check\n          ./repo test`,
    ),
  ];
  for (const workflow of malformed) {
    const { root, config } = fixture(t, workflow);
    const errors = checkCI(root, config);
    const control = await ci(root);
    assert.deepEqual(
      {
        structural: /Unsupported CI YAML.*ci\.yml:\d+/.test(errors.join(";")),
        passed: control.passed,
      },
      { structural: true, passed: false },
      workflow,
    );
  }
  const supported = [
    ...[0, 7, 8, 9].map((commentIndent) =>
      valid.replace(
        "      - run: ./repo check",
        `      - run: |\n          ./repo check\n${" ".repeat(commentIndent)}# between steps`,
      ),
    ),
    valid.replace(
      "      - run: ./repo check",
      `      - run: |\n${" ".repeat(8)}\n          ./repo check\n${" ".repeat(12)}`,
    ),
  ];
  for (const workflow of supported) {
    const { root, config } = fixture(t, workflow);
    assert.deepEqual(checkCI(root, config), [], workflow);
    assert.equal((await ci(root)).passed, true, workflow);
  }
});

test("CI accounts for legitimate nested mappings, block sequences and opaque literals", async (t) => {
  const workflow = valid
    .replace(
      "on: [push, pull_request]",
      "on:\n  workflow_dispatch:\n    inputs:\n      environment:\n        type: choice\n        options:\n          - development\n          - production\npermissions:\n  contents: read\nconcurrency:\n  group: qualification\n  cancel-in-progress: true",
    )
    .replace(
      "    runs-on:",
      "    env:\n      MODE: local\n    strategy:\n      matrix:\n        node: [22, 24]\n    container:\n      image: node:22\n      env:\n        MODE: local\n    services:\n      database:\n        image: postgres\n        ports:\n          - 5432:5432\n    runs-on:",
    )
    .replace(
      "      - run: ./repo check",
      "      - name: check\n        env:\n          MODE: local\n        run: |\n          echo needs: absent\n          echo name: metadata\n           echo deeper literal content\n          ./repo check",
    );
  const opaqueMetadata =
    workflow +
    "      - uses: actions/upload-artifact@v4\n        with:\n          -label: literal\n          description: |\n            needs: absent\n             name: opaque metadata\n            if: false\n          path: .arrs/evidence/\n";
  const { root, config } = fixture(t, opaqueMetadata);
  assert.deepEqual(checkCI(root, config), []);
  assert.equal((await ci(root)).passed, true);
});

test("CI discovery does not qualify a malformed descendant workflow", (t) => {
  const malformed = valid.replace(
    "    runs-on: ubuntu-latest",
    "    runs-on: ubuntu-latest\n      needs: absent",
  );
  const { root } = fixture(t, malformed, ".github/workflows/malformed.yml");
  writeFileSync(join(root, ".github/workflows/valid.yml"), valid);
  assert.equal(discoverCIWorkflow(root).workflow, ".github/workflows/valid.yml");
});

test("CI rejects missing and self dependencies with failed audit diagnostics", async (t) => {
  for (const needs of ["absent", "[absent]", "\n      - absent", "constructor"]) {
    const { root, config } = fixture(t, needsWorkflow(`    needs: ${needs}`));
    assert.match(
      checkCI(root, config).join(";"),
      /gates.*unknown dependency.*(?:absent|constructor)/i,
    );
    const control = await ci(root);
    assert.equal(control.passed, false);
    assert.equal(control.status, "failed");
  }
  for (const needs of ["gates", "['gates']", "\n      - gates"]) {
    const { root, config } = fixture(t, needsWorkflow(`    needs: ${needs}`));
    assert.match(checkCI(root, config).join(";"), /gates.*self-dependency/i);
    assert.equal((await ci(root)).passed, false);
  }
});

test("CI identifies dependency cycles across gates and disconnected auxiliary jobs", (t) => {
  for (const workflow of [
    needsWorkflow("    needs: build", extraJob("build", "gates")),
    valid +
      extraJob("first", "second") +
      extraJob("second", "third") +
      extraJob("third", "first"),
  ]) {
    const { root, config } = fixture(t, workflow);
    const errors = checkCI(root, config).join(";");
    assert.match(errors, /dependency cycle/i);
    assert.match(
      errors,
      workflow.includes("first:") ? /first.*second.*third.*first/ : /gates.*build.*gates/,
    );
  }
  const { root, config } = fixture(
    t,
    valid + "  delegated:\n    needs: absent\n    uses: ./other.yml\n",
  );
  assert.match(checkCI(root, config).join(";"), /delegated.*unknown dependency.*absent/i);
});

test("CI supports literal forward scalar and sequence dependency graphs", async (t) => {
  for (const needs of [
    "build",
    "'build' # comment",
    '"build" # comment',
    "[build, constructor] # comment",
    "['build', \"constructor\"]",
    "\n      - build # comment\n      - 'constructor'",
    "[] # no dependencies",
  ]) {
    const { root, config } = fixture(
      t,
      needsWorkflow(
        `    needs: ${needs}`,
        extraJob("build", "constructor") + extraJob("constructor"),
      ),
    );
    assert.deepEqual(checkCI(root, config), [], needs);
    assert.equal((await ci(root)).passed, true);
  }
  const { root, config } = fixture(
    t,
    needsWorkflow(
      "    needs: ['true', 'null', '__proto__']",
      extraJob("true") + extraJob("null") + extraJob("__proto__"),
    ),
  );
  assert.deepEqual(checkCI(root, config), []);
});

test("CI unsupported dependency syntax cannot earn capability", async (t) => {
  for (const needs of [
    "${{ matrix.job }}",
    "{job: build}",
    "*jobs",
    "&jobs build",
    "!tag build",
    "null",
    "Null",
    "~",
    "true",
    "FALSE",
    "",
    "[build,]",
    "[,build]",
    "[build,,build]",
    "[build",
    "build]",
    "[build, [build]]",
    "[build, ${{ matrix.job }}]",
    "'build # hidden'",
    '"build # hidden"',
    "build\n      continuation",
    "|\n      build",
    ">\n      build",
    "[build]\n      - build",
    "\n      job: build",
    "\n      - build\n        nested: value",
    "\n      -",
    "\n      - build\n       - build",
  ]) {
    const { root, config } = fixture(
      t,
      needsWorkflow(`    needs: ${needs}`, extraJob("build")),
    );
    assert.match(checkCI(root, config).join(";"), /Unsupported CI needs.*gates/, needs);
    const control = await ci(root);
    assert.equal(control.passed, false, needs);
    assert.equal(control.status, "unsupported", needs);
  }
});

test("CI dependency traversal stays bounded without recursive stack growth", (t) => {
  const count = 1500;
  let workflow = needsWorkflow("    needs: job0");
  for (let index = 0; index < count; index++)
    workflow += extraJob(`job${index}`, index + 1 < count ? `job${index + 1}` : "");
  assert.ok(workflow.length < 256_000);
  const { root, config } = fixture(t, workflow);
  assert.deepEqual(checkCI(root, config), []);
  writeFileSync(
    join(root, config.ci.workflow),
    workflow.replace(`  job${count - 1}:\n`, `  job${count - 1}:\n    needs: job0\n`),
  );
  assert.match(checkCI(root, config).join(";"), /dependency cycle.*job0.*job1499.*job0/i);
});

test("CI respects explicitly configured alternative workflow filenames", async (t) => {
  const { root } = fixture(t, valid, ".github/workflows/quality.yaml");
  assert.equal((await ci(root)).passed, true);
});

for (const [name, workflow] of [
  [
    "expression-based ignored failures",
    valid.replace(
      "      - run: ./repo check",
      "      - run: ./repo check\n        continue-on-error: ${{ true }}",
    ),
  ],
  [
    "folded run scalars",
    valid.replace(
      "      - run: ./repo check\n      - run: ./repo test\n      - run: ./repo verify",
      "      - run: >\n          ./repo check\n          ./repo test\n          ./repo verify",
    ),
  ],
  [
    "run-looking metadata",
    valid.replace(
      "      - run: ./repo check\n      - run: ./repo test\n      - run: ./repo verify",
      "      - name: misleading description\n        description: |\n          run: ./repo check\n          run: ./repo test\n          run: ./repo verify",
    ),
  ],
  ["unresolved reusable jobs", valid + "  outsourced:\n    uses: ./other.yml\n"],
]) {
  test(`CI does not award capability from ${name}`, async (t) => {
    const { root } = fixture(t, workflow);
    assert.equal((await ci(root)).passed, false);
  });
}

test("npm audit must invoke the audit, rather than echo its flags", async (t) => {
  const { root } = fixture(
    t,
    valid.replace("arrs audit --execute --require-level 4", "npm run audit"),
  );
  writeJson(root, "package.json", {
    scripts: { audit: "echo --execute --require-level 4" },
  });
  assert.equal((await ci(root)).passed, false);
});

test("CI recognizes literal blocks, quoted commands and artifact always conditions", (t) => {
  const workflow =
    valid
      .replace(
        "      - run: ./repo check\n      - run: ./repo test",
        "      - name: check and test\n        run: |\n          # A shell comment does not invoke a gate.\n          ./repo check\n          ./repo test",
      )
      .replace("run: ./repo verify", "run: './repo verify'") +
    "      - name: evidence\n        if: ${{ always() }}\n        uses: actions/upload-artifact@v4\n        with:\n          path: .arrs/evidence/\n";
  const { root, config } = fixture(t, workflow);
  assert.deepEqual(checkCI(root, config), []);
});

test("CI accepts a direct npm audit script and ignores commented failure settings", (t) => {
  const { root, config } = fixture(
    t,
    valid.replace("arrs audit --execute --require-level 4", "npm run audit") +
      `# ${ignoredFailure}\n`,
  );
  writeJson(root, "package.json", {
    scripts: { audit: "node dist/cli.js audit --execute --require-level 4 --json" },
  });
  assert.deepEqual(checkCI(root, config), []);
});

test("CI recognizes valid CLI run and npm script argv", (t) => {
  for (const command of [
    "node dist/cli.js run",
    "arrs run",
    "npx arrs run",
    "node repo",
    "npm run",
  ]) {
    const { root, config } = fixture(t, valid.replaceAll("./repo", command));
    writeJson(root, "package.json", {
      scripts: {
        check: "node checks.mjs",
        test: "node --test tests.mjs",
        verify: "node verify.mjs",
      },
    });
    assert.deepEqual(checkCI(root, config), [], command);
  }
  const { root, config } = fixture(t, valid.replace("./repo test", "npm test"));
  writeJson(root, "package.json", { scripts: { test: "node --test tests.mjs" } });
  assert.deepEqual(checkCI(root, config), []);
});

test("CI requires named npm gate scripts to exist", (t) => {
  const { root, config } = fixture(t, valid.replaceAll("./repo", "npm run"));
  writeJson(root, "package.json", { scripts: { check: "", test: "node --test" } });
  assert.match(checkCI(root, config).join(";"), /actual check gate/);
  assert.match(checkCI(root, config).join(";"), /actual verify gate/);
});

test("bounded CI trigger inspection supports explicit push, pull_request and dispatch declarations", (t) => {
  for (const declaration of [
    "on: push",
    "on: ['push', 'pull_request']",
    "on:\n  push:\n  pull_request:",
    "on:\n  workflow_dispatch:\n    inputs:\n      name:\n        type: string",
  ]) {
    const { root, config } = fixture(
      t,
      valid.replace("on: [push, pull_request]", declaration),
    );
    assert.deepEqual(checkCI(root, config), [], declaration);
  }
});

test("unestablished CI event syntax/names and unknown top fields stay unsupported", (t) => {
  for (const declaration of [
    "on: [never]",
    "on: [schedule]",
    "on: {push: null}",
    "on:\n  workflow_call:",
    "on: [push, pull_request]\nunknown-field: value",
  ]) {
    const { root, config } = fixture(
      t,
      valid.replace("on: [push, pull_request]", declaration),
    );
    assert.match(checkCI(root, config).join(";"), /Unsupported CI/, declaration);
  }
});

test("nonempty block trigger scalars remain unsupported instead of earning CI capability", (t) => {
  for (const declaration of [
    "on:\n  push: false",
    "on:\n  pull_request: true",
    "on:\n  workflow_dispatch: unknown",
    "on:\n  push: ${{ github.event.enabled }}",
  ]) {
    const { root, config } = fixture(
      t,
      valid.replace("on: [push, pull_request]", declaration),
    );
    assert.match(checkCI(root, config).join(";"), /Unsupported CI block event trigger/);
  }
  const { root, config } = fixture(
    t,
    valid.replace("on: [push, pull_request]", "on:\n  push: null\n  pull_request: {}"),
  );
  assert.deepEqual(checkCI(root, config), []);
});

test("CI accepts nonempty literal matrix dimensions and leaves disabled/unresolved matrices unproven", (t) => {
  for (const [strategy, passed] of [
    [
      "    strategy:\n      matrix:\n        node: [22, 24]\n        os: [ubuntu-latest, windows-latest]\n",
      true,
    ],
    ["    strategy:\n      matrix:\n        node: []\n", false],
    [
      "    strategy:\n      matrix: ${{ fromJSON(needs.discover.outputs.matrix) }}\n",
      false,
    ],
    [
      "    strategy:\n      matrix:\n        node: [22]\n        exclude:\n          - node: 22\n",
      false,
    ],
  ]) {
    const { root, config } = fixture(
      t,
      valid.replace("    runs-on:", strategy + "    runs-on:"),
    );
    assert.equal(checkCI(root, config).length === 0, passed, strategy);
  }
});

test("literal multiline gates require an established POSIX runner default shell", (t) => {
  const block = valid.replace(
    "      - run: ./repo check\n      - run: ./repo test",
    "      - run: |\n          ./repo check\n          ./repo test",
  );
  for (const runner of ["windows-latest", "${{ matrix.os }}", "[self-hosted, linux]"]) {
    const { root, config } = fixture(t, block.replace("ubuntu-latest", runner));
    assert.match(
      checkCI(root, config).join(";"),
      /Unsupported CI multiline.*exit status/,
    );
  }
});

test("shell function shadowing cannot convert failing npm gates to a passing static claim", (t) => {
  const workflow = `name: functions
on: push
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - run: |
          npm() {
            true
          }
          arrs() {
            true
          }
          npm run check
          npm run test
          npm run verify
          arrs audit --execute --require-level 4
`;
  const { root, config } = fixture(t, workflow);
  writeJson(root, "package.json", {
    scripts: {
      check: "node failing-gate.mjs",
      test: "node failing-gate.mjs",
      verify: "node failing-gate.mjs",
    },
  });
  writeFileSync(join(root, "failing-gate.mjs"), "process.exit(37);\n");
  assert.match(checkCI(root, config).join(";"), /Unsupported CI shell control/);
});

for (const [name, workflow] of [
  [
    "commented gates",
    valid.replace("      - run: ./repo check", "      # - run: ./repo check"),
  ],
  ["disabled job", valid.replace("    runs-on:", "    if: false\n    runs-on:")],
  [
    "conditional gate",
    valid.replace(
      "      - run: ./repo check",
      "      - run: ./repo check\n        if: ${{ success() }}",
    ),
  ],
  [
    "explicit ignored failure",
    valid.replace(
      "      - run: ./repo check",
      `      - run: ./repo check\n        ${ignoredFailure}`,
    ),
  ],
  [
    "shell failure suppression",
    valid.replace("run: ./repo check", "run: ./repo check || true"),
  ],
  [
    "disabled shell failure handling",
    valid.replace(
      "run: ./repo check",
      "run: |\n          set +e\n          ./repo check",
    ),
  ],
  [
    "conditional shell gate",
    valid.replace(
      "run: ./repo check",
      "run: |\n          if false; then\n            ./repo check\n          fi",
    ),
  ],
  [
    "gate text inside heredoc",
    valid.replace(
      "run: ./repo check",
      "run: |\n          cat <<'DOC'\n          ./repo check\n          DOC",
    ),
  ],
  [
    "gate text inside multiline string",
    valid.replace(
      "run: ./repo check",
      'run: |\n          echo "\n          ./repo check\n          "',
    ),
  ],
  [
    "gate command after directory change",
    valid.replace(
      "run: ./repo check",
      "run: |\n          cd another\n          ./repo check",
    ),
  ],
  [
    "missing npm script allowed",
    valid.replace("run: ./repo check", "run: npm run check --if-present"),
  ],
  ["invalid npm gate argv", valid.replaceAll("./repo", "npm")],
  ["invalid direct CLI gate argv", valid.replaceAll("./repo", "node dist/cli.js")],
  [
    "invalid standalone assets gate argv",
    valid.replaceAll("./repo", "node assets/repo.cjs"),
  ],
  [
    "unsupported audit equals option",
    valid.replace("--require-level 4", "--require-level=4"),
  ],
  [
    "shell alias replaces apparent gate executable",
    valid.replace(
      "run: ./repo check",
      "run: |\n          shopt -s expand_aliases\n          alias npm=true\n          npm run check",
    ),
  ],
  [
    "shell function replaces apparent gate executable",
    valid.replace(
      "run: ./repo check",
      "run: |\n          npm() {\n            true\n          }\n          npm run check",
    ),
  ],
  [
    "gate help instead of execution",
    valid.replace("run: ./repo check", "run: ./repo check --help"),
  ],
  [
    "plain scalar continuation hides help",
    valid.replace("run: ./repo check", "run: ./repo check\n          --help"),
  ],
  [
    "audit help instead of execution",
    valid.replace(
      "audit --execute --require-level 4",
      "audit --execute --require-level 4 --help",
    ),
  ],
  [
    "audit targets another repository",
    valid.replace(
      "audit --execute --require-level 4",
      "audit --execute --require-level 4 --root other",
    ),
  ],
  [
    "custom shell status handling",
    valid.replace(
      "      - run: ./repo check",
      "      - run: ./repo check\n        shell: bash {0}",
    ),
  ],
  [
    "inherited shell defaults",
    valid.replace("jobs:", "defaults:\n  run:\n    shell: bash {0}\njobs:"),
  ],
  [
    "flow-style steps",
    valid.replace(
      "    steps:\n      - run: ./repo check",
      "    steps:\n      - { run: './repo check' }",
    ),
  ],
  ["no triggers", valid.replace("on: [push, pull_request]", "on: []")],
  [
    "unknown job field",
    valid.replace("    runs-on:", "    unknown-job-field: true\n    runs-on:"),
  ],
  [
    "duplicate run field",
    valid.replace(
      "      - run: ./repo check",
      "      - run: echo harmless\n        run: ./repo check",
    ),
  ],
]) {
  test(`CI rejects or reports unsupported ${name}`, (t) => {
    const { root, config } = fixture(t, workflow);
    assert.ok(checkCI(root, config).length > 0);
  });
}

test("CI separates missing workflows from unsupported providers without fallback", (t) => {
  const { root, config } = fixture(t);
  config.ci.workflow = ".github/workflows/absent.yml";
  assert.match(
    checkCI(root, config).join(";"),
    /Missing CI workflow.*configure ci.workflow/,
  );
  config.ci.workflow = ".gitlab-ci.yml";
  writeFileSync(join(root, ".gitlab-ci.yml"), valid);
  assert.match(checkCI(root, config).join(";"), /Unsupported CI provider/);
});

test("bounded discovery selects a sole workflow independently of gate qualification", (t) => {
  const { root } = fixture(
    t,
    "name: incomplete\non: [push]\njobs: {}\n",
    ".github/workflows/quality.yaml",
  );
  assert.deepEqual(discoverCIWorkflow(root), {
    workflow: ".github/workflows/quality.yaml",
    warnings: [],
  });
  assert.ok(
    checkCI(root, { ci: { workflow: ".github/workflows/quality.yaml" } }).length > 0,
  );
});

test("bounded discovery selects one fully inspected candidate and reports ambiguity", (t) => {
  const { root } = fixture(t, valid, ".github/workflows/quality.yaml");
  writeFileSync(
    join(root, ".github/workflows/docs.yml"),
    "name: docs\non: [push]\njobs: {}\n",
  );
  assert.deepEqual(discoverCIWorkflow(root), {
    workflow: ".github/workflows/quality.yaml",
    warnings: [],
  });
  writeFileSync(join(root, ".github/workflows/second.yml"), valid);
  assert.equal(discoverCIWorkflow(root).workflow, ".github/workflows/ci.yml");
  assert.match(
    discoverCIWorkflow(root).warnings.join(";"),
    /Multiple.*configure ci.workflow/,
  );
});

test("CI discovery is bounded and missing capability remains an adoption requirement", (t) => {
  const { root } = fixture(t);
  assert.match(
    discoverCIWorkflow(join(root, "not-created")).warnings.join(";"),
    /Configure ci.workflow/,
  );
  rmSync(join(root, ".github"), { recursive: true });
  assert.match(discoverCIWorkflow(root).warnings.join(";"), /Configure ci.workflow/);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (let index = 0; index < 101; index++)
    writeFileSync(join(root, `.github/workflows/${index}.yml`), valid);
  assert.match(discoverCIWorkflow(root).warnings.join(";"), /limited to 100/);
});

test("CI discovery ignores YAML-named directories and symlinks", (t) => {
  const { root } = fixture(t);
  rmSync(join(root, ".github/workflows/ci.yml"));
  mkdirSync(join(root, ".github/workflows/directory.yml"));
  writeFileSync(join(root, "outside.yml"), valid);
  if (process.platform === "win32")
    symlinkSync(
      join(root, ".github/workflows/directory.yml"),
      join(root, ".github/workflows/linked.yml"),
      "junction",
    );
  else symlinkSync(join(root, "outside.yml"), join(root, ".github/workflows/linked.yml"));
  assert.match(discoverCIWorkflow(root).warnings.join(";"), /Configure ci.workflow/);
});
