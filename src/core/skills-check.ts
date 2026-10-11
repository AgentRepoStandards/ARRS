import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { readConfig } from "./config.js";
import { safePath } from "./files.js";

const repository = "https://github.com/mattpocock/skills";
export interface Snapshot {
  schemaVersion: "0.1";
  repository: string;
  revision: string;
  inspectedAt: string;
  license: string;
  upstreamVersion?: string;
  files: Record<string, string>;
  skillSources: string[];
}
export interface Skill {
  id: string;
  path: string;
  requiredTerms: string[];
  sources: string[];
  sha256: string;
}
export interface Pack {
  schemaVersion: "0.1";
  packVersion: string;
  skills: Skill[];
}
export interface Adaptation {
  adaptationVersion: string;
  sourceRevision: string | null;
  sourceHashes: Record<string, string>;
  changes: string[];
}
export interface Provenance {
  schemaVersion: "0.1";
  upstreamRepository: string;
  upstreamRevision: string;
  license: string;
  adaptations: Record<string, Adaptation>;
  reconciliations: unknown[];
}
const sha = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const version = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
export function parseSnapshot(directory: string, value: unknown): Snapshot {
  if (
    !object(value) ||
    value.schemaVersion !== "0.1" ||
    value.repository !== repository ||
    !revision(value.revision) ||
    value.license !== "MIT" ||
    typeof value.inspectedAt !== "string" ||
    !object(value.files) ||
    !strings(value.skillSources)
  )
    throw new Error(
      "Invalid upstream snapshot manifest; require schemaVersion 0.1, pinned full revision, MIT license and complete inventory",
    );
  const files = value.files;
  for (const [path, hash] of Object.entries(files)) {
    safePath(directory, `source/${path}`);
    if (!digest(hash)) throw new Error(`Invalid source hash: ${path}`);
  }
  const discovered = Object.keys(files)
    .filter((path) => path.endsWith("/SKILL.md"))
    .sort();
  if (
    JSON.stringify([...value.skillSources].sort()) !== JSON.stringify(discovered) ||
    new Set(value.skillSources).size !== value.skillSources.length
  )
    throw new Error(
      "Upstream skillSources must inventory every SKILL.md, including newly discovered skills",
    );
  if (!files["LICENSE"]) throw new Error("Upstream snapshot must preserve LICENSE");
  return value as unknown as Snapshot;
}

export function parsePack(directory: string, value: unknown): Pack {
  if (
    !object(value) ||
    value.schemaVersion !== "0.1" ||
    !version(value.packVersion) ||
    !Array.isArray(value.skills) ||
    value.skills.length === 0
  )
    throw new Error("Invalid skill pack manifest");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of value.skills as unknown[]) {
    if (
      !object(entry) ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
      entry.path !== `${entry.id}/SKILL.md` ||
      !digest(entry.sha256) ||
      !strings(entry.requiredTerms) ||
      entry.requiredTerms.length === 0 ||
      !entry.requiredTerms.every((term) => term.length > 0) ||
      !strings(entry.sources)
    )
      throw new Error(
        "Invalid skill entry; require unique id, matching SKILL.md path, hash and workflow contract",
      );
    safePath(directory, entry.path);
    if (ids.has(entry.id) || paths.has(entry.path))
      throw new Error(`Duplicate skill id/path: ${entry.id}`);
    ids.add(entry.id);
    paths.add(entry.path);
  }
  return value as unknown as Pack;
}

export function parseProvenance(value: unknown): Provenance {
  if (
    !object(value) ||
    value.schemaVersion !== "0.1" ||
    value.upstreamRepository !== repository ||
    !revision(value.upstreamRevision) ||
    value.license !== "MIT" ||
    !object(value.adaptations) ||
    !Array.isArray(value.reconciliations)
  )
    throw new Error("Invalid skill provenance manifest");
  for (const [id, adaptation] of Object.entries(value.adaptations)) {
    if (
      !object(adaptation) ||
      !version(adaptation.adaptationVersion) ||
      !(adaptation.sourceRevision === null || revision(adaptation.sourceRevision)) ||
      !object(adaptation.sourceHashes) ||
      !strings(adaptation.changes) ||
      adaptation.changes.length === 0 ||
      !Object.values(adaptation.sourceHashes).every(digest)
    )
      throw new Error(`Invalid skill adaptation provenance: ${id}`);
  }
  return value as unknown as Provenance;
}
export function packAt(directory: string): Pack {
  return parsePack(directory, json(safePath(directory, "pack.json")));
}
export function provenanceAt(directory: string): Provenance {
  return parseProvenance(json(safePath(directory, "provenance.json")));
}
export function snapshotMetadata(directory: string): Snapshot {
  return parseSnapshot(directory, json(safePath(directory, "manifest.json")));
}

export function hashesFor(sources: string[], upstream: Snapshot): Record<string, string> {
  return Object.fromEntries(
    Object.entries(upstream.files).filter(([path]) =>
      sources.some((source) =>
        path.startsWith(`${dirname(source).replaceAll("\\", "/")}/`),
      ),
    ),
  );
}

/** Structural contract tests; model behavior itself remains subject to task proof and review. */
export function testSkillPackDirectory(
  directory: string,
  override?: {
    pack: Pack;
    provenance: Provenance;
    upstream: Snapshot;
    licenseText?: string;
  },
): string[] {
  try {
    const pack = parsePack(
      directory,
      override === undefined ? json(safePath(directory, "pack.json")) : override?.pack,
    );
    const provenance = parseProvenance(
      override === undefined
        ? json(safePath(directory, "provenance.json"))
        : override?.provenance,
    );
    const upstream = parseSnapshot(
      directory,
      override === undefined
        ? json(safePath(directory, "manifest.json"))
        : override?.upstream,
    );
    const errors: string[] = [];
    if (provenance.upstreamRevision !== upstream.revision)
      errors.push("Pack provenance and pinned upstream manifest revision differ");
    const license =
      override?.licenseText === undefined
        ? readFileSync(safePath(directory, "UPSTREAM-LICENSE"), "utf8")
        : override.licenseText;
    if (typeof license !== "string")
      throw new Error("Invalid skill candidate license; require text");
    if (
      !license.includes("MIT License") ||
      !license.includes("Matt Pocock") ||
      sha(license) !== upstream.files["LICENSE"] ||
      !license.includes("Permission is hereby granted")
    )
      errors.push(
        "Installed skill pack must retain the exact pinned upstream MIT license and attribution",
      );
    for (const skill of pack.skills) {
      const content = readFileSync(safePath(directory, skill.path), "utf8");
      const adaptation = provenance.adaptations[skill.id];
      if (sha(content) !== skill.sha256)
        errors.push(
          `${skill.id}: adaptation hash changed; reconcile deliberately with an adaptation version`,
        );
      if (
        !content.startsWith(`---\nname: ${skill.id}\n`) ||
        !/^description: .+/m.test(content.split("---")[1] ?? "")
      )
        errors.push(`${skill.id}: invalid discoverable skill frontmatter`);
      for (const heading of ["Inputs", "Workflow", "Completion"])
        if (!content.includes(`## ${heading}`))
          errors.push(`${skill.id}: missing ${heading} contract`);
      for (const term of skill.requiredTerms)
        if (!content.toLowerCase().includes(term.toLowerCase()))
          errors.push(`${skill.id}: missing workflow requirement ${term}`);
      if (content.length > 7000 || content.length < 400)
        errors.push(
          `${skill.id}: invocation must be concise and substantive (400–7000 characters)`,
        );
      if (/Call the Skill tool|claude --bg|Codex-specific/i.test(content))
        errors.push(`${skill.id}: vendor-specific invocation`);
      if (!adaptation) {
        errors.push(`${skill.id}: missing adaptation provenance`);
        continue;
      }
      if (adaptation.sourceRevision !== (skill.sources.length ? upstream.revision : null))
        errors.push(`${skill.id}: source revision is stale`);
      for (const source of skill.sources)
        if (!upstream.skillSources.includes(source))
          errors.push(`${skill.id}: missing upstream source ${source}`);
      if (
        JSON.stringify(Object.entries(adaptation.sourceHashes).sort()) !==
        JSON.stringify(Object.entries(hashesFor(skill.sources, upstream)).sort())
      )
        errors.push(
          `${skill.id}: source bundle provenance hashes do not match pinned inventory`,
        );
    }
    for (const id of Object.keys(provenance.adaptations))
      if (!pack.skills.some((skill) => skill.id === id))
        errors.push(`Orphan adaptation provenance: ${id}`);
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
export function installedSkillsDirectory(root: string): string {
  const directory = safePath(root, readConfig(root).skills.path);
  const generated = safePath(root, ".arrs");
  if (directory === generated || directory.startsWith(generated + sep))
    throw new Error(
      "skills.path must be outside reserved .arrs output/cache paths; preserve adaptations in a versioned source directory such as .agent/skills",
    );
  return directory;
}
/** Assess installed packs against their own pinned inventory, including reconciled versions. */
export function checkSkills(root: string): string[] {
  try {
    return testSkillPackDirectory(installedSkillsDirectory(root));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
