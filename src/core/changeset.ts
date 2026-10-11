import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  classifyRisk,
  pathsOverlap,
  readConfig,
  readRiskPolicy,
  repositoryPathsOverlap,
  scanFeatures,
} from "./config.js";
import { hashScope, safePath } from "./files.js";
import { validate } from "./schema.js";
import type { ArrsConfig, FeatureMap, ProofPlan, Risk, RiskPolicy } from "./types.js";

export interface ChangesetCapability {
  version: "1";
  mode: "git";
  base: string;
}
export interface ChangeEndpoint {
  path: string;
  excluded: boolean;
  before: { object: string; mode: string } | null;
  after: { sha256: string; mode: string } | null;
}
export interface ChangeLayer {
  layer: "committed" | "staged" | "unstaged" | "untracked";
  status: "added" | "modified" | "deleted" | "type-changed" | "renamed";
  paths: string[];
  similarity?: number;
}
export interface ChangesetSnapshot {
  schemaVersion: "1";
  assurance: "git-complete";
  status: "complete";
  base: string;
  head: string;
  gitVersion: string;
  repository: {
    root: string;
    gitDirectory: string;
    commonDirectory: string;
    identity: string;
  };
  indexSha256: string;
  workingSha256: string;
  layers: ChangeLayer[];
  endpoints: ChangeEndpoint[];
  exclusions: string[];
  fingerprint: string;
}
export interface ChangesetFailure {
  schemaVersion: "1";
  assurance: "unestablished";
  status: "incomplete" | "unsupported";
  diagnostics: string[];
}
export interface ManualScope {
  schemaVersion: "1";
  assurance: "declared-only";
  status: "complete";
  scope: string[];
  diagnostics: string[];
}
export interface ScopeCheck {
  schemaVersion: "1";
  passed: boolean;
  inventory: ChangesetSnapshot | ChangesetFailure | ManualScope;
  covered: string[];
  uncovered: string[];
  excluded: string[];
  effectiveRisk: Risk;
  verificationTargets: string[];
  features: Array<{
    id: string;
    target: string;
    risk: Risk;
    provenance: "current" | "comparison-base";
  }>;
  diagnostics: string[];
}
const exclusions = [".git", ".arrs", "node_modules"];
const maxEntries = 30_000,
  maxFileBytes = 64 * 1024 * 1024;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
class CollectionError extends Error {
  constructor(
    message: string,
    readonly status: "incomplete" | "unsupported" = "incomplete",
  ) {
    super(message);
  }
}
function environment(): NodeJS.ProcessEnv {
  // Never inherit Git config injection, index selection, helpers, replace objects,
  // transport/proxy configuration or repository selection from the caller.
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
}
function git(root: string, args: string[], input?: string): Buffer {
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-c",
      "credential.helper=",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.external=",
      "-c",
      "core.quotePath=false",
      ...args,
    ],
    {
      cwd: root,
      env: environment(),
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    },
  );
  if (result.error || result.status !== 0)
    throw new CollectionError(
      `Git collection failed (${args[0]}): ${result.error?.message ?? result.stderr.toString("utf8").trim().slice(0, 1000)}`,
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? "unsupported"
        : "incomplete",
    );
  return result.stdout;
}
function tokens(output: Buffer): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  if (text && !text.endsWith("\0"))
    throw new CollectionError("Git path output is not NUL terminated");
  return text ? text.slice(0, -1).split("\0") : [];
}
function excluded(root: string, path: string): boolean {
  const first = path.split("/")[0]!;
  for (const name of exclusions) {
    if (first === name) return true;
    const entry = lstatSync(join(root, first), { bigint: true, throwIfNoEntry: false });
    const reserved = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
    if (entry && reserved && entry.dev === reserved.dev && entry.ino === reserved.ino)
      return true;
  }
  return false;
}
function path(root: string, value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..") ||
    posix.normalize(value) !== value
  )
    throw new CollectionError(
      `Unsafe Git source path: ${JSON.stringify(value)}`,
      "unsupported",
    );
  if (excluded(root, value)) return value;
  const normalized = relative(root, safePath(root, value)).split(sep).join("/");
  if (!normalized || normalized !== value || value.endsWith("/"))
    throw new CollectionError(
      `Git reported a noncanonical source path: ${JSON.stringify(value)}`,
      "unsupported",
    );
  return normalized;
}
type ObjectEntry = { object: string; mode: string };
function tree(root: string, revision: string): Map<string, ObjectEntry> {
  const result = new Map<string, ObjectEntry>();
  for (const item of tokens(git(root, ["ls-tree", "-rz", "--full-tree", revision]))) {
    const tab = item.indexOf("\t"),
      header = item.slice(0, tab).split(" ");
    if (tab < 0 || header.length !== 3)
      throw new CollectionError("Malformed Git tree inventory");
    const name = path(root, item.slice(tab + 1));
    result.set(name, { mode: header[0]!, object: header[2]! });
    if (result.size > maxEntries)
      throw new CollectionError("Git tree exceeds 30,000 entries");
  }
  return result;
}
function index(root: string): Map<string, ObjectEntry> {
  const result = new Map<string, ObjectEntry>();
  for (const item of tokens(git(root, ["ls-files", "--stage", "-z"]))) {
    const tab = item.indexOf("\t"),
      header = item.slice(0, tab).split(" ");
    if (tab < 0 || header.length !== 3 || header[2] !== "0")
      throw new CollectionError(
        "Unmerged or malformed Git index is unsupported",
        "unsupported",
      );
    const name = path(root, item.slice(tab + 1));
    result.set(name, { mode: header[0]!, object: header[1]! });
    if (result.size > maxEntries)
      throw new CollectionError("Git index exceeds 30,000 entries");
  }
  for (const item of tokens(git(root, ["ls-files", "-t", "-z"])))
    if (item.startsWith("S "))
      throw new CollectionError(
        "Sparse/skip-worktree index is unsupported",
        "unsupported",
      );
  return result;
}
function indexDigest(root: string, directory: string): string {
  const indexPath = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ])
    .toString("utf8")
    .trim();
  const names = [
    indexPath,
    ...readdirSync(directory)
      .filter((name) => name.startsWith("sharedindex."))
      .sort(order)
      .map((name) => join(directory, name)),
  ];
  const hash = createHash("sha256");
  for (const name of names) {
    const stat = lstatSync(name, { throwIfNoEntry: false });
    if (!stat) {
      hash.update(`${name}\0absent\0`);
      continue;
    }
    if (!stat.isFile() || stat.size > maxFileBytes)
      throw new CollectionError("Unsafe or oversized Git index", "unsupported");
    hash.update(`${name}\0`);
    hash.update(readFileSync(name));
  }
  return hash.digest("hex");
}
function rawLayers(
  root: string,
  args: string[],
  layer: "committed" | "staged",
): ChangeLayer[] {
  const values = tokens(
    git(root, [
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames=50%",
      "--ignore-submodules=none",
      ...args,
      "--",
    ]),
  );
  const result: ChangeLayer[] = [];
  for (let i = 0; i < values.length; i++) {
    const header = values[i]!.split(" "),
      code = header[4];
    if (header.length !== 5 || !header[0]!.startsWith(":"))
      throw new CollectionError("Malformed Git diff inventory");
    const names = [path(root, values[++i] ?? "")];
    if (code?.startsWith("R")) names.push(path(root, values[++i] ?? ""));
    const status = {
      A: "added",
      M: "modified",
      D: "deleted",
      T: "type-changed",
      R: "renamed",
    }[code?.[0] ?? ""] as ChangeLayer["status"] | undefined;
    if (!status)
      throw new CollectionError(`Unsupported Git status ${code}`, "unsupported");
    result.push({
      layer,
      status,
      paths: names,
      ...(status === "renamed" ? { similarity: Number(code!.slice(1)) } : {}),
    });
  }
  return result;
}
function resolveCommit(root: string, input: string): string {
  if (!input || input.length > 256 || input.includes("\0"))
    throw new CollectionError("An explicit bounded Git base is required");
  const object = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${input}^{commit}`,
  ])
    .toString("utf8")
    .trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object))
    throw new CollectionError("Git revision did not resolve to a full commit object");
  return object;
}
function collect(rootInput: string, baseInput: string): ChangesetSnapshot {
  const root = realpathSync(rootInput);
  const version = git(root, ["--version"]).toString("utf8").trim();
  if (!/^git version 2\.52\.\d+(?:\..*)?$/.test(version))
    throw new CollectionError(
      `Unsupported Git version ${version}; qualified version is 2.52.x`,
      "unsupported",
    );
  if (
    git(root, ["rev-parse", "--is-inside-work-tree"]).toString("utf8").trim() !== "true"
  )
    throw new CollectionError("A Git worktree is required", "unsupported");
  if (
    realpathSync(git(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim()) !==
    root
  )
    throw new CollectionError("Scope root must be the Git worktree root", "unsupported");
  const base = resolveCommit(root, baseInput),
    head = resolveCommit(root, "HEAD");
  const gitDirectory = realpathSync(
    git(root, ["rev-parse", "--absolute-git-dir"]).toString("utf8").trim(),
  );
  const commonDirectory = realpathSync(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      .toString("utf8")
      .trim(),
  );
  const stat = lstatSync(root, { bigint: true });
  const gitStat = lstatSync(gitDirectory, { bigint: true }),
    commonStat = lstatSync(commonDirectory, { bigint: true });
  const repository = {
    root,
    gitDirectory,
    commonDirectory,
    identity: `${stat.dev}:${stat.ino}/${gitStat.dev}:${gitStat.ino}/${commonStat.dev}:${commonStat.ino}`,
  };
  const indexSha256 = indexDigest(root, gitDirectory);
  const before = tree(root, base),
    current = tree(root, head),
    staged = index(root);
  for (const [name, entry] of [...before, ...current, ...staged])
    if (!excluded(root, name) && !["100644", "100755"].includes(entry.mode))
      throw new CollectionError(
        `Unsupported tracked type/submodule: ${JSON.stringify(name)} (${entry.mode})`,
        "unsupported",
      );
  const objects = [
    ...new Set(
      [...before, ...current, ...staged]
        .filter(([name]) => !excluded(root, name))
        .map(([, entry]) => entry.object),
    ),
  ];
  if (objects.length) {
    const checked = git(
      root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      objects.join("\n") + "\n",
    )
      .toString("utf8")
      .trim()
      .split("\n");
    if (
      checked.length !== objects.length ||
      checked.some(
        (line, i) =>
          !line.startsWith(`${objects[i]} blob `) ||
          Number(line.split(" ")[2]) > maxFileBytes,
      )
    )
      throw new CollectionError(
        "Missing local blob objects or unsupported/oversized tracked source; no fetch is permitted",
      );
  }
  const untracked = tokens(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ).map((name) => path(root, name));
  const names = [
    ...new Set([...before.keys(), ...current.keys(), ...staged.keys(), ...untracked]),
  ].sort(order);
  if (names.length > maxEntries)
    throw new CollectionError("Working inventory exceeds 30,000 entries");
  const algorithm = base.length === 40 ? "sha1" : "sha256";
  const working = new Map<string, { sha256: string; object: string; mode: string }>();
  const workingHash = createHash("sha256");
  let total = 0;
  for (const name of names) {
    if (excluded(root, name)) continue;
    for (const entry of [before.get(name), current.get(name), staged.get(name)])
      if (entry && !["100644", "100755"].includes(entry.mode))
        throw new CollectionError(
          `Unsupported tracked type/submodule: ${JSON.stringify(name)} (${entry.mode})`,
          "unsupported",
        );
    const absolute = safePath(root, name),
      entry = lstatSync(absolute, { throwIfNoEntry: false });
    if (!entry) {
      workingHash.update(`${name}\0absent\0`);
      continue;
    }
    if (!entry.isFile())
      throw new CollectionError(
        `Unsupported source type: ${JSON.stringify(name)}`,
        "unsupported",
      );
    total += entry.size;
    if (entry.size > maxFileBytes || total > 256 * 1024 * 1024)
      throw new CollectionError("Working source exceeds byte bounds");
    const bytes = readFileSync(absolute),
      sha256 = digest(bytes);
    const mode = entry.mode & 0o111 ? "100755" : "100644";
    const object = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    working.set(name, { sha256, object, mode });
    workingHash.update(`${name}\0${sha256}\0${mode}\0`);
  }
  const layers = [
    ...rawLayers(root, [base, head], "committed"),
    ...rawLayers(root, ["--cached", head], "staged"),
  ];
  for (const [name, entry] of staged) {
    if (excluded(root, name)) continue;
    const after = working.get(name);
    if (!after || after.object !== entry.object || after.mode !== entry.mode)
      layers.push({
        layer: "unstaged",
        status: !after
          ? "deleted"
          : after.mode !== entry.mode
            ? "type-changed"
            : "modified",
        paths: [name],
      });
  }
  for (const name of untracked)
    layers.push({ layer: "untracked", status: "added", paths: [name] });
  const changed = [...new Set(layers.flatMap((layer) => layer.paths))].sort(order);
  const endpoints = changed.map((name): ChangeEndpoint => {
    const after = working.get(name);
    return {
      path: name,
      excluded: excluded(root, name),
      before: before.get(name) ?? null,
      after: after ? { sha256: after.sha256, mode: after.mode } : null,
    };
  });
  if (
    indexSha256 !== indexDigest(root, gitDirectory) ||
    base !== resolveCommit(root, baseInput) ||
    head !== resolveCommit(root, "HEAD")
  )
    throw new CollectionError(
      "Git base/HEAD/index drifted during collection; retry from a stable worktree",
    );
  const value = {
    schemaVersion: "1" as const,
    assurance: "git-complete" as const,
    status: "complete" as const,
    base,
    head,
    gitVersion: version,
    repository,
    indexSha256,
    workingSha256: workingHash.digest("hex"),
    layers,
    endpoints,
    exclusions: [...exclusions],
  };
  return { ...value, fingerprint: digest(JSON.stringify(value)) };
}

/** Read-only complete collection requires two agreeing bounded observations. */
export function inspectChangeset(
  root: string,
  base: string,
): ChangesetSnapshot | ChangesetFailure {
  try {
    const first = collect(root, base),
      second = collect(root, base);
    if (first.fingerprint !== second.fingerprint)
      throw new CollectionError(
        "Working-tree or Git identity drifted during collection; retry from a stable worktree",
      );
    return second;
  } catch (error) {
    return {
      schemaVersion: "1",
      assurance: "unestablished",
      status: error instanceof CollectionError ? error.status : "incomplete",
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}
export function inspectManualScope(
  root: string,
  scope: string[],
): ManualScope | ChangesetFailure {
  try {
    if (!scope.length || scope.length > maxEntries)
      throw new CollectionError("Manual mode requires bounded declared scope");
    for (const name of scope) {
      const normalized = relative(safePath(root, "."), safePath(root, name))
        .split(sep)
        .join("/");
      if (!normalized || excluded(root, normalized))
        throw new CollectionError(
          `Declare existing source outside exact root metadata, evidence and dependencies: ${name}`,
        );
      hashScope(root, name);
    }
    return {
      schemaVersion: "1",
      assurance: "declared-only",
      status: "complete",
      scope: [...scope],
      diagnostics: [
        "Manual mode validates declared existing source only; complete changes, deletions and Git provenance are unknown.",
      ],
    };
  } catch (error) {
    return {
      schemaVersion: "1",
      assurance: "unestablished",
      status: "incomplete",
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}
export interface ComparisonContracts {
  config: ArrsConfig;
  policy: RiskPolicy;
  features: FeatureMap[];
  sources: Array<{ path: string; sha256: string }>;
  featureSources: Array<{ id: string; path: string; sha256: string }>;
}
/** Read bounded contract facts from the exact inspected local base; no project execution. */
export function readComparisonContracts(
  root: string,
  snapshot: ChangesetSnapshot,
  bounds: { fileBytes?: number; metadataBytes?: number; features?: number } = {},
): ComparisonContracts {
  const version = git(root, ["--version"]).toString("utf8").trim();
  if (!/^git version 2\.52\.\d+(?:\..*)?$/.test(version))
    throw new CollectionError(
      `Unsupported Git version ${version}; qualified version is 2.52.x`,
      "unsupported",
    );
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.base) ||
    resolveCommit(root, snapshot.base) !== snapshot.base
  )
    throw new CollectionError(
      "Comparison contracts require an exact locally resolved commit object",
    );
  const entries = tree(root, snapshot.base);
  const sources: ComparisonContracts["sources"] = [];
  const fileLimit = Math.min(bounds.fileBytes ?? maxFileBytes, maxFileBytes),
    totalLimit = Math.min(bounds.metadataBytes ?? 256 * 1024 * 1024, 256 * 1024 * 1024),
    featureLimit = Math.min(bounds.features ?? maxEntries, maxEntries);
  let total = 0;
  const read = (name: string, kind: "config" | "risk" | "feature"): unknown => {
    path(root, name);
    const entry = entries.get(name);
    if (!entry || !["100644", "100755"].includes(entry.mode))
      throw new CollectionError(`Comparison-base ${kind} unavailable: ${name}`);
    const size = Number(
      git(root, ["cat-file", "-s", entry.object]).toString("utf8").trim(),
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > fileLimit ||
      total + size > totalLimit
    )
      throw new CollectionError("Historical contract exceeds byte bounds");
    total += size;
    const output = git(root, ["cat-file", "blob", entry.object]);
    if (output.length !== size)
      throw new CollectionError(
        "Historical contract object bytes differ from the local preflight",
      );
    const value: unknown = JSON.parse(output.toString("utf8"));
    sources.push({ path: name, sha256: digest(output) });
    const errors = validate(kind, value);
    if (errors.length)
      throw new CollectionError(
        `Invalid comparison-base ${kind} ${name}: ${errors.join("; ")}`,
      );
    return value;
  };
  const config = read("arrs.json", "config") as ArrsConfig;
  const policy = read(config.riskPolicy, "risk") as RiskPolicy;
  if (policy.sensitivePaths.some((entry) => entry.risk < "R3"))
    throw new CollectionError("Comparison-base sensitive rules require at least R3");
  const featurePaths = [...entries.keys()]
    .filter(
      (name) => name.endsWith(".json") && pathsOverlap(config.knowledge.features, name),
    )
    .sort(order);
  if (featurePaths.length > featureLimit)
    throw new CollectionError(
      "Historical Feature Maps exceed configured collection bounds",
    );
  const features = featurePaths.map((name) => read(name, "feature") as FeatureMap);
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id))
      throw new CollectionError(`Duplicate comparison-base feature ${feature.id}`);
    ids.add(feature.id);
    if (
      !Object.hasOwn(config.verifyTargets, feature.verification.target) ||
      (feature.sensitivity === "sensitive" && feature.risk < "R3") ||
      (feature.sensitivity === "critical" && feature.risk !== "R4")
    )
      throw new CollectionError(
        `Comparison-base feature ${feature.id} has invalid risk/verification semantics`,
      );
    for (const name of [...feature.implementation, ...feature.entryPoints]) {
      safePath(root, name);
      const normalized = posix.normalize(name).replace(/\/$/, "");
      if (
        !entries.has(normalized) &&
        ![...entries.keys()].some((entry) => entry.startsWith(normalized + "/"))
      )
        throw new CollectionError(
          `Comparison-base feature ${feature.id} has a broken source reference: ${name}`,
        );
    }
  }
  for (const feature of features)
    if (feature.dependencies.some((id) => !ids.has(id)))
      throw new CollectionError(
        `Unresolved comparison-base feature dependency for ${feature.id}`,
      );
  const byId = new Map(features.map((feature) => [feature.id, feature])),
    colors = new Map<string, number>();
  for (const start of ids) {
    if (colors.has(start)) continue;
    const stack = [{ id: start, index: 0 }];
    colors.set(start, 1);
    while (stack.length) {
      const top = stack.at(-1)!,
        dependencies = byId.get(top.id)!.dependencies;
      if (top.index >= dependencies.length) {
        colors.set(top.id, 2);
        stack.pop();
        continue;
      }
      const next = dependencies[top.index++]!;
      if (colors.get(next) === 1)
        throw new CollectionError(`Comparison-base feature dependency cycle: ${next}`);
      if (!colors.has(next)) {
        colors.set(next, 1);
        stack.push({ id: next, index: 0 });
      }
    }
  }
  return {
    config,
    policy,
    features,
    sources: sources.sort((a, b) => order(a.path, b.path)),
    featureSources: features.map((feature, index) => ({
      id: feature.id,
      ...sources.find((source) => source.path === featurePaths[index])!,
    })),
  };
}
/** Coverage does not supply trusted pre-change policy context or acceptance. */
export function checkChangesetScope(
  root: string,
  plan: Pick<ProofPlan, "scope" | "risk">,
  base?: string,
): ScopeCheck {
  const inventory = base
    ? inspectChangeset(root, base)
    : inspectManualScope(root, plan.scope);
  const result: ScopeCheck = {
    schemaVersion: "1",
    passed: false,
    inventory,
    covered: [],
    uncovered: [],
    excluded: [],
    effectiveRisk: plan.risk,
    verificationTargets: [],
    features: [],
    diagnostics: [],
  };
  if (inventory.status !== "complete") {
    result.diagnostics = inventory.diagnostics;
    return result;
  }
  if (inventory.assurance === "declared-only") {
    result.passed = true;
    result.diagnostics = inventory.diagnostics;
    return result;
  }
  try {
    const scopes = plan.scope.map((name) =>
      relative(safePath(root, "."), safePath(root, name)).split(sep).join("/"),
    );
    if (scopes.some((name) => !name || excluded(root, name)))
      throw new CollectionError(
        "Declare source files or directories outside root metadata, evidence and dependencies",
      );
    for (const endpoint of inventory.endpoints) {
      if (endpoint.excluded) result.excluded.push(endpoint.path);
      else if (
        scopes.some(
          (scope) =>
            scope === endpoint.path ||
            endpoint.path.startsWith(`${scope}/`) ||
            scope === "" ||
            repositoryPathsOverlap(root, scope, endpoint.path),
        )
      )
        result.covered.push(endpoint.path);
      else result.uncovered.push(endpoint.path);
    }
    const changed = inventory.endpoints
      .filter((entry) => !entry.excluded)
      .map((entry) => entry.path);
    const config = readConfig(root),
      policy = readRiskPolicy(root, config),
      maps = scanFeatures(root, config);
    if (maps.errors.length)
      throw new CollectionError(
        `Invalid current Feature Maps: ${maps.errors.join("; ")}`,
      );
    const historical = readComparisonContracts(root, inventory);
    result.effectiveRisk = classifyRisk(root, changed, plan.risk, policy, maps.features);
    result.effectiveRisk = classifyRisk(
      root,
      changed,
      result.effectiveRisk,
      historical.policy,
      historical.features,
    );
    for (const [features, provenance] of [
      [maps.features, "current"],
      [historical.features, "comparison-base"],
    ] as const)
      for (const feature of features)
        if (
          changed.some((name) =>
            [...feature.implementation, ...feature.entryPoints].some((entry) =>
              repositoryPathsOverlap(root, name, entry),
            ),
          )
        )
          result.features.push({
            id: feature.id,
            target: feature.verification.target,
            risk: feature.risk,
            provenance,
          });
    result.verificationTargets = [
      ...new Set(result.features.map((feature) => feature.target)),
    ].sort(order);
    if (result.uncovered.length)
      result.diagnostics.push(
        `Uncovered changed paths: ${result.uncovered.map((name) => JSON.stringify(name)).join(", ")}; declare each source path or its enclosing source directory`,
      );
    if (result.effectiveRisk > plan.risk)
      result.diagnostics.push(
        `Changed source requires ${result.effectiveRisk}; plan declares ${plan.risk}`,
      );
    const final = inspectChangeset(root, base!);
    if (final.status !== "complete" || !isDeepStrictEqual(final, inventory))
      throw new CollectionError(
        "Git/source state drifted while assessing scope and historical obligations; retry from a stable worktree",
      );
    result.passed = result.diagnostics.length === 0;
  } catch (error) {
    result.diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
export function requireChangeset(
  root: string,
  plan: Pick<ProofPlan, "scope" | "risk" | "steps" | "changeset">,
): ChangesetSnapshot | undefined {
  if (!plan.changeset) return undefined;
  const result = checkChangesetScope(root, plan, plan.changeset.base);
  if (!result.passed || result.inventory.assurance !== "git-complete")
    throw new Error(
      `Incomplete proof changeset coverage: ${result.diagnostics.join("; ")}`,
    );
  for (const target of result.verificationTargets)
    if (
      !plan.steps.some(
        (step) =>
          step.command === "verify" &&
          step.target === target &&
          step.phase !== "before" &&
          step.expectExitCode === 0,
      )
    )
      throw new Error(`Changeset proof lacks mapped verification target ${target}`);
  return result.inventory;
}
export function changesetScopeHash(
  root: string,
  name: string,
  snapshot?: ChangesetSnapshot,
): string {
  if (lstatSync(safePath(root, name), { throwIfNoEntry: false }))
    return hashScope(root, name);
  const normalized = relative(safePath(root, "."), safePath(root, name))
    .split(sep)
    .join("/");
  const endpoint = snapshot?.endpoints.find(
    (entry) =>
      entry.path === normalized && !entry.excluded && entry.before && !entry.after,
  );
  if (!endpoint?.before || !snapshot)
    throw new Error(
      `Missing declared source has no complete Git deletion provenance: ${name}`,
    );
  return digest(
    JSON.stringify({
      contract: "arrs-deletion-v1",
      base: snapshot.base,
      path: normalized,
      before: endpoint.before,
      after: "absent",
    }),
  );
}
export function validateChangesetSnapshot(
  root: string,
  plan: ProofPlan,
  snapshot?: ChangesetSnapshot,
): string[] {
  if (!plan.changeset)
    return snapshot ? ["Changeset snapshot lacks explicit negotiated capability"] : [];
  if (!snapshot)
    return ["Changeset capability requires captured snapshot; recapture proof"];
  try {
    const current = requireChangeset(root, plan);
    if (!isDeepStrictEqual(current, snapshot))
      return [
        "Proof changeset state drifted or snapshot integrity changed; recapture against the explicit base",
      ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return [];
}
