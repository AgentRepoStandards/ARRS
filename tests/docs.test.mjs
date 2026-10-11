import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { audit } from "../dist/core/audit.js";
import { validate } from "../dist/core/schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(path)
      : entry.name.endsWith(".md")
        ? [path]
        : [];
  });
}

test("repository guidance has no broken relative file links", () => {
  const files = [
    ...["README.md", "AGENTS.md", "CONTRIBUTING.md", "GLOSSARY.md"].map((path) =>
      join(root, path),
    ),
    ...markdownFiles(join(root, "docs")),
    ...markdownFiles(join(root, "templates")),
  ];
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.ok(
        existsSync(resolve(dirname(file), decodeURIComponent(target))),
        `${file} links to missing ${target}`,
      );
    }
  }
});

test("draft contract examples match the shipped schema shapes", () => {
  assert.deepEqual(validate("work-item", json("templates/work-item.json")), []);
  assert.deepEqual(validate("proof-plan", json("templates/proof-plan.json")), []);
  const states = json("schemas/work-item.schema.json").properties.state.enum;
  assert.deepEqual(
    Object.keys(json("templates/work-labels.json").states).sort(),
    [...states].sort(),
  );
});

test("normative maturity matrix enumerates the reference audit controls", async () => {
  const report = await audit(root);
  const documented = [
    ...read("docs/spec/0.1.md").matchAll(/^\|\s*[1234][^|\n]*\|\s*`([a-z-]+)`\s*\|/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    documented.sort(),
    report.controls.map((control) => control.id).sort(),
  );
});
