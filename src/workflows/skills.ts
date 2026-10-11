import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../core/config.js";
import { safePath, walkFiles } from "../core/files.js";
import {
  type Snapshot,
  installedSkillsDirectory as installedDirectory,
  packAt,
  provenanceAt,
  snapshotMetadata,
  hashesFor,
  testSkillPackDirectory,
} from "../core/skills-check.js";

export { testSkillPackDirectory };

const packagedRoot = fileURLToPath(new URL("../../", import.meta.url));
const repository = "https://github.com/mattpocock/skills";
const run = promisify(execFile);
const dispositions = ["ADOPT", "ADAPT", "WRAP", "REPLACE", "EXCLUDE"];
const sha = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const version = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
function record(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Exact inert blob representations for paths npm omits from published tarballs. */
function packagingBlobs(directory: string, manifest: Snapshot): Record<string, Buffer> {
  const path = safePath(directory, "packaging-blobs.json");
  if (!existsSync(path)) return {};
  const value = json(path);
  if (!object(value) || value.schemaVersion !== "0.1" || !object(value.files))
    throw new Error("Invalid packaging blob metadata");
  const blobs: Record<string, Buffer> = {};
  for (const [source, entry] of Object.entries(value.files)) {
    safePath(directory, `source/${source}`);
    if (
      !object(entry) ||
      !digest(entry.sha256) ||
      typeof entry.base64 !== "string" ||
      entry.base64.length > 7_000_000
    )
      throw new Error(`Invalid packaging blob: ${source}`);
    const bytes = Buffer.from(entry.base64, "base64");
    if (
      bytes.toString("base64") !== entry.base64 ||
      sha(bytes) !== entry.sha256 ||
      entry.sha256 !== manifest.files[source]
    )
      throw new Error(`Packaging blob hash/inventory mismatch: ${source}`);
    blobs[source] = bytes;
  }
  return blobs;
}

function sourceBytes(
  directory: string,
  path: string,
  manifest: Snapshot,
  blobs = packagingBlobs(directory, manifest),
): Buffer {
  const physical = safePath(directory, `source/${path}`);
  if (existsSync(physical)) return readFileSync(physical);
  const fallback = blobs[path];
  if (fallback) return fallback;
  throw new Error(`Missing pinned upstream source: ${path}`);
}

function snapshot(directory: string, verifySource = true): Snapshot {
  const value = snapshotMetadata(directory);
  const files = value.files;
  if (verifySource) {
    const manifest = value as unknown as Snapshot;
    const blobs = packagingBlobs(directory, manifest);
    const physical = walkFiles(directory, "source", {
      includeIgnored: true,
      maxFiles: 20_000,
    }).map((path) => path.slice("source/".length));
    const actual = [...new Set([...physical, ...Object.keys(blobs)])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(Object.keys(files).sort()))
      throw new Error(
        "Upstream snapshot source inventory mismatch (new, missing or untracked file)",
      );
    let bytes = 0;
    for (const [path, hash] of Object.entries(files)) {
      const content = sourceBytes(directory, path, manifest, blobs);
      bytes += content.length;
      if (bytes > 20_000_000)
        throw new Error("Upstream source snapshot exceeds 20 MB limit");
      if (sha(content) !== hash)
        throw new Error(`Upstream source hash mismatch: ${path}`);
    }
    const license = sourceBytes(directory, "LICENSE", manifest, blobs).toString("utf8");
    if (
      !license.includes("MIT License") ||
      !license.includes("Permission is hereby granted") ||
      !license.includes("Matt Pocock")
    )
      throw new Error("Upstream license changed; review license manually before staging");
  }
  return value as unknown as Snapshot;
}

export function testSkillPack(root: string): string[] {
  try {
    return testSkillPackDirectory(installedDirectory(root));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function copySnapshot(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  const manifest = snapshot(source);
  const blobs = packagingBlobs(source, manifest);
  for (const path of Object.keys(manifest.files)) {
    const destination = safePath(target, `source/${path}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, sourceBytes(source, path, manifest, blobs));
  }
  record(safePath(target, "manifest.json"), manifest);
}
function install(root: string): unknown {
  const target = installedDirectory(root);
  mkdirSync(target, { recursive: true });
  const bundled = join(packagedRoot, "skills");
  const upstream = join(packagedRoot, "upstream/mattpocock");
  snapshot(upstream);
  const installed: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const files = [...walkFiles(bundled), "manifest.json"];
  for (const path of files) {
    const content = readFileSync(
      path === "manifest.json" ? join(upstream, path) : safePath(bundled, path),
    );
    const destination = safePath(target, path);
    if (existsSync(destination)) {
      (sha(readFileSync(destination)) === sha(content) ? unchanged : conflicts).push(
        path,
      );
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: "wx" });
    installed.push(path);
  }
  return {
    action: "install",
    path: readConfig(root).skills.path,
    installed,
    unchanged,
    conflicts,
    passed: conflicts.length === 0 && testSkillPackDirectory(target).length === 0,
  };
}
function stagePath(root: string): string {
  return safePath(root, ".arrs/skills/staged");
}
function baselinePath(root: string, manifest: Snapshot): string | undefined {
  const local = safePath(root, ".arrs/skills/base");
  if (
    existsSync(join(local, "manifest.json")) &&
    snapshot(local).revision === manifest.revision
  )
    return local;
  const bundled = join(packagedRoot, "upstream/mattpocock");
  if (snapshot(bundled).revision === manifest.revision) return bundled;
  return undefined;
}
function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
function pairs(args: string[], flag: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === flag) {
      const pair = args[++i];
      const equal = pair?.indexOf("=") ?? -1;
      if (!pair || equal < 1 || equal === pair.length - 1)
        throw new Error(`${flag} requires name=value`);
      const key = pair.slice(0, equal);
      if (Object.hasOwn(values, key)) throw new Error(`Duplicate ${flag}: ${key}`);
      values[key] = pair.slice(equal + 1);
    }
  return values;
}
function keepIds(args: string[]): string[] {
  return args.flatMap((value, i) => (value === "--keep" ? [args[i + 1] ?? ""] : []));
}
function changes(
  before: Snapshot,
  after: Snapshot,
): { path: string; change: string; before: string | null; after: string | null }[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .sort()
    .filter((path) => before.files[path] !== after.files[path])
    .map((path) => ({
      path,
      change: !before.files[path] ? "added" : !after.files[path] ? "deleted" : "modified",
      before: before.files[path] ?? null,
      after: after.files[path] ?? null,
    }));
}
function sourceAffected(source: string, changed: { path: string }[]): boolean {
  return changed.some((entry) =>
    entry.path.startsWith(`${dirname(source).replaceAll("\\", "/")}/`),
  );
}
function excerpt(directory: string | undefined, path: string): string | null {
  if (!directory) return null;
  const manifest = snapshot(directory, false);
  if (!manifest.files[path]) return null;
  const bytes = sourceBytes(directory, path, manifest);
  return bytes.toString("utf8").slice(0, 12_000);
}
function status(root: string, includeDiff: boolean): unknown {
  const directory = installedDirectory(root);
  if (!existsSync(join(directory, "pack.json")))
    return {
      installed: false,
      upstreamRevision: snapshot(join(packagedRoot, "upstream/mattpocock")).revision,
      stagedRevision: null,
    };
  const pack = packAt(directory);
  const base = snapshot(directory, false);
  const provenance = provenanceAt(directory);
  const staged = stagePath(root);
  const next = existsSync(join(staged, "manifest.json")) ? snapshot(staged) : undefined;
  const changed = next ? changes(base, next) : [];
  const affected = pack.skills.filter((skill) =>
    skill.sources.some((source) => sourceAffected(source, changed)),
  );
  return {
    installed: true,
    packVersion: pack.packVersion,
    upstreamRevision: base.revision,
    provenanceRevision: provenance.upstreamRevision,
    stagedRevision: next?.revision ?? null,
    offline: true,
    integrityErrors: testSkillPackDirectory(directory),
    sourceChanges: includeDiff
      ? changed.map((entry) => ({
          ...entry,
          beforeText: excerpt(baselinePath(root, base), entry.path),
          afterText: excerpt(staged, entry.path),
          textLimit: 12_000,
        }))
      : changed,
    changedSourceSkills: [
      ...new Set([...base.skillSources, ...(next?.skillSources ?? [])]),
    ].filter((source) => sourceAffected(source, changed)),
    newSkills:
      next?.skillSources.filter((source) => !base.skillSources.includes(source)) ?? [],
    deletedSkills: base.skillSources.filter(
      (source) => next && !next.skillSources.includes(source),
    ),
    adaptations: pack.skills.map((skill) => ({
      id: skill.id,
      path: skill.path,
      sourceRevision: provenance.adaptations[skill.id]?.sourceRevision,
      upstreamChanged: affected.includes(skill),
      localModified: sha(readFileSync(safePath(directory, skill.path))) !== skill.sha256,
      ...(includeDiff && affected.includes(skill)
        ? { adaptedText: readFileSync(safePath(directory, skill.path), "utf8") }
        : {}),
    })),
  };
}
async function fetchSnapshot(args: string[]): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "arrs-skills-fetch-"));
  const checkout = join(directory, "checkout");
  const target = join(directory, "snapshot");
  try {
    await run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        "--depth=1",
        `${repository}.git`,
        checkout,
      ],
      { timeout: 60_000, maxBuffer: 2_000_000 },
    );
    const requested = option(args, "--revision");
    if (requested && !revision(requested))
      throw new Error("--revision requires a full 40-character commit SHA");
    if (requested)
      await run("git", ["-C", checkout, "fetch", "--depth=1", "origin", requested], {
        timeout: 60_000,
        maxBuffer: 2_000_000,
      });
    const ref = requested ? "FETCH_HEAD" : "HEAD";
    const commit = (
      await run("git", ["-C", checkout, "rev-parse", ref], { timeout: 10_000 })
    ).stdout.trim();
    const tree = (
      await run("git", ["-C", checkout, "ls-tree", "-r", "-z", commit], {
        timeout: 10_000,
        maxBuffer: 2_000_000,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    const gitModes: Record<string, string> = {};
    const paths = tree.map((entry) => {
      const tab = entry.indexOf("\t"),
        mode = entry.slice(0, tab).split(" ")[0];
      const path = entry.slice(tab + 1);
      if (tab < 0 || !mode || !["100644", "100755", "120000"].includes(mode))
        throw new Error(
          "Unsupported git source entry; submodules require a reviewed snapshot adapter",
        );
      gitModes[path] = mode;
      return path;
    });
    mkdirSync(join(target, "source"), { recursive: true });
    const files: Record<string, string> = {};
    let total = 0;
    for (const path of paths) {
      const content = (
        await run("git", ["-C", checkout, "show", `${commit}:${path}`], {
          timeout: 10_000,
          encoding: "buffer",
          maxBuffer: 5_000_000,
        })
      ).stdout;
      total += content.length;
      if (total > 20_000_000 || paths.length > 20_000)
        throw new Error("Fetched source exceeds inventory limits");
      const destination = safePath(target, `source/${path}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      files[path] = sha(content);
    }
    record(join(target, "manifest.json"), {
      schemaVersion: "0.1",
      repository,
      revision: commit,
      inspectedAt: new Date().toISOString().slice(0, 10),
      license: "MIT",
      gitModes,
      files,
      skillSources: paths.filter((path) => path.endsWith("/SKILL.md")).sort(),
    });
    snapshot(target);
    return target;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
async function sync(root: string, args: string[]): Promise<unknown> {
  const source = option(args, "--source");
  const fetch = args.includes("--fetch");
  if (source && fetch)
    throw new Error(
      "Choose --source for an offline snapshot or --fetch for explicit network access",
    );
  if (!source && !fetch)
    return {
      action: "sync",
      staged: false,
      reason:
        "Offline by default. Supply --source <snapshot-directory> or --fetch to inspect upstream changes.",
    };
  const directory = source ? resolve(source) : await fetchSnapshot(args);
  try {
    const candidate = snapshot(directory);
    const staged = stagePath(root);
    if (existsSync(join(staged, "manifest.json"))) {
      const current = snapshot(staged);
      if (
        current.revision !== candidate.revision ||
        JSON.stringify(current.files) !== JSON.stringify(candidate.files)
      )
        throw new Error(
          "A different upstream snapshot is already staged; reconcile it or explicitly remove .arrs/skills/staged before staging another",
        );
    } else copySnapshot(directory, staged);
    return {
      action: "sync",
      staged: true,
      revision: candidate.revision,
      adaptationsOverwritten: false,
      status: status(root, false),
    };
  } finally {
    if (fetch) rmSync(dirname(directory), { recursive: true, force: true });
  }
}
function reconcile(root: string, args: string[]): unknown {
  const rationale = option(args, "--rationale");
  if (!rationale?.trim() || rationale.trim().length < 12)
    throw new Error(
      "Reconciliation requires --rationale with the deliberate review decision (at least 12 characters)",
    );
  const staged = stagePath(root);
  const candidate = snapshot(staged);
  const directory = installedDirectory(root);
  const pack = packAt(directory);
  const provenance = provenanceAt(directory);
  const baseline = snapshot(directory, false);
  if (
    candidate.revision === baseline.revision &&
    JSON.stringify(candidate.files) !== JSON.stringify(baseline.files)
  )
    throw new Error(
      "Source contents changed at the same pinned revision; provide a new revision",
    );
  const changed = changes(baseline, candidate);
  const candidateLicense = readFileSync(safePath(staged, "source/LICENSE"), "utf8");
  if (
    baseline.files["LICENSE"] !== candidate.files["LICENSE"] &&
    !args.includes("--license-reviewed")
  )
    throw new Error(
      "Upstream LICENSE changed; review the exact license diff, then explicitly supply --license-reviewed with the reconciliation rationale",
    );
  const adapted = pairs(args, "--adaptation");
  const keep = keepIds(args);
  const decisions = pairs(args, "--disposition");
  const mappings = pairs(args, "--map-source");
  for (const id of [...Object.keys(adapted), ...keep])
    if (!pack.skills.some((skill) => skill.id === id))
      throw new Error(`Unknown adaptation: ${id}`);
  for (const [path, disposition] of Object.entries(decisions))
    if (
      !dispositions.includes(disposition) ||
      ![...baseline.skillSources, ...candidate.skillSources].includes(path)
    )
      throw new Error(`Invalid upstream disposition: ${path}=${disposition}`);
  const newSources = candidate.skillSources.filter(
    (source) => !baseline.skillSources.includes(source),
  );
  for (const source of newSources) {
    const decision = decisions[source];
    if (!decision)
      throw new Error(
        `New upstream skill requires explicit --disposition ${source}=ADAPT|EXCLUDE (or another disposition)`,
      );
    if (decision !== "EXCLUDE") {
      const target = pack.skills.find((skill) => skill.id === mappings[source]);
      if (!target)
        throw new Error(
          `Selected new skill requires --map-source ${source}=<existing-pack-id>; author new entries deliberately first`,
        );
      if (!target.sources.includes(source)) target.sources.push(source);
    }
  }
  for (const skill of pack.skills) {
    const adaptation = provenance.adaptations[skill.id];
    if (!adaptation) throw new Error(`Missing provenance: ${skill.id}`);
    const actual = sha(readFileSync(safePath(directory, skill.path)));
    const affected = skill.sources.some((source) => sourceAffected(source, changed));
    if (affected && !adapted[skill.id] && !keep.includes(skill.id))
      throw new Error(
        `Review affected adaptation explicitly: --keep ${skill.id} or --adaptation ${skill.id}=<new-version>`,
      );
    if (actual !== skill.sha256 && !adapted[skill.id])
      throw new Error(
        `Modified adaptation requires a deliberate version: --adaptation ${skill.id}=<new-version>`,
      );
    if (adapted[skill.id]) {
      const nextVersion = adapted[skill.id];
      if (!version(nextVersion) || nextVersion === adaptation.adaptationVersion)
        throw new Error(`Adaptation requires a new semantic version: ${skill.id}`);
      adaptation.adaptationVersion = nextVersion;
      skill.sha256 = actual;
      adaptation.changes.push(rationale);
    }
    for (const source of [...skill.sources])
      if (!candidate.skillSources.includes(source)) {
        if (decisions[source] !== "EXCLUDE")
          throw new Error(
            `Removed source requires explicit --disposition ${source}=EXCLUDE`,
          );
        skill.sources = skill.sources.filter((entry) => entry !== source);
      }
    adaptation.sourceRevision = skill.sources.length ? candidate.revision : null;
    adaptation.sourceHashes = hashesFor(skill.sources, candidate);
  }
  provenance.upstreamRevision = candidate.revision;
  provenance.reconciliations.push({
    from: baseline.revision,
    to: candidate.revision,
    date: new Date().toISOString(),
    rationale,
    adapted,
    retained: keep,
    licenseReviewed: args.includes("--license-reviewed"),
    dispositions: decisions,
    sourceMappings: mappings,
    changedFiles: changed.map((entry) => entry.path),
  });
  const errors = testSkillPackDirectory(directory, {
    pack,
    provenance,
    upstream: candidate,
    licenseText: candidateLicense,
  });
  if (errors.length)
    throw new Error(
      `Adapted pack tests failed; provenance unchanged: ${errors.join("; ")}`,
    );
  const base = safePath(root, ".arrs/skills/base");
  if (existsSync(base)) rmSync(base, { recursive: true });
  copySnapshot(staged, base);
  writeFileSync(safePath(directory, "UPSTREAM-LICENSE"), candidateLicense);
  record(safePath(directory, "pack.json"), pack);
  record(safePath(directory, "provenance.json"), provenance);
  record(safePath(directory, "manifest.json"), candidate);
  rmSync(staged, { recursive: true });
  return {
    action: "reconcile",
    revision: candidate.revision,
    rationale,
    adaptationsOverwritten: false,
    packTestsPassed: true,
    changedSourceFiles: changed.map((entry) => entry.path),
    status: status(root, false),
  };
}

function validateArgs(action: string, args: string[]): void {
  const allowed: Record<string, string[]> = {
    install: [],
    test: [],
    status: ["--fetch", "--revision"],
    diff: ["--fetch", "--revision"],
    sync: ["--source", "--fetch", "--revision"],
    reconcile: [
      "--rationale",
      "--keep",
      "--adaptation",
      "--disposition",
      "--map-source",
      "--license-reviewed",
    ],
  };
  const flags = allowed[action];
  if (!flags) return;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!flags.includes(flag))
      throw new Error(`Unknown skills ${action} option: ${flag}`);
    if (flag !== "--fetch" && flag !== "--license-reviewed") {
      if (!args[i + 1] || args[i + 1]!.startsWith("--"))
        throw new Error(`${flag} requires a value`);
      i++;
    }
  }
  if (args.includes("--revision") && !args.includes("--fetch"))
    throw new Error("--revision requires explicit --fetch");
}
export async function skillsCommand(
  root: string,
  action: string,
  args: string[],
): Promise<unknown> {
  validateArgs(action, args);
  installedDirectory(root);
  if (action === "install") return install(root);
  if (action === "test") {
    const errors = testSkillPack(root);
    if (errors.length) throw new Error(`Skill pack tests failed: ${errors.join("; ")}`);
    return {
      passed: true,
      skills: packAt(installedDirectory(root)).skills.length,
    };
  }
  if (action === "sync") return sync(root, args);
  if (action === "reconcile") return reconcile(root, args);
  if (action === "status" || action === "diff") {
    if (args.includes("--fetch")) await sync(root, args);
    return status(root, action === "diff");
  }
  throw new Error(
    "Skills commands: install | test | status [--fetch] | diff [--fetch] | sync (--source <snapshot-dir> | --fetch [--revision <full-sha>]) | reconcile --rationale <decision> [--keep <id>] [--adaptation <id>=<new-version>] [--disposition <source>=EXCLUDE|ADAPT] [--map-source <source>=<id>] [--license-reviewed]",
  );
}
