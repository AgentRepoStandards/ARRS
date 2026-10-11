import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  pathsOverlap,
  readArchitecture,
  readConfig,
  readRiskPolicy,
  scanFeatures,
} from "../core/config.js";
import { evidenceIgnoreProtection } from "../core/evidence-ignore.js";
import { hashScope, readJson, safePath, walkFiles } from "../core/files.js";
import { policyRequirements } from "../core/policy-baseline.js";
import { assertValid } from "../core/schema.js";
import type {
  ArchitecturePolicy,
  Command,
  FeatureMap,
  PolicyBaseline,
  RiskPolicy,
} from "../core/types.js";

export interface AdoptionInput extends Partial<Omit<FeatureMap, "verification">> {
  schemaVersion: "0.1";
  id: string;
  tests?: string[];
  verification?: { target: string; command?: Command };
  architecture?: { modules: ArchitecturePolicy["modules"] };
  sensitivePaths?: RiskPolicy["sensitivePaths"];
}
interface Bytes {
  sha256: string;
  bytesBase64: string;
  mode: number;
}
interface Operation {
  path: string;
  reason: string;
  expected: Bytes | null;
  replacement: Bytes;
}
export interface AdoptionProposal {
  schemaVersion: "0.1";
  kind: "adoption-proposal";
  id: string;
  inputPath: string;
  status: "blocked" | "ready-for-review";
  input: AdoptionInput;
  snapshots: { path: string; sha256: string | null; mode: number | null }[];
  discovery: {
    kind:
      "manifest" | "script" | "instruction" | "configured-command" | "configured-target";
    source: string;
    name: string;
    supplied: false;
    detail: string;
  }[];
  blockers: { code: string; message: string; remediation: string }[];
  checklist: {
    id: string;
    status: "configured" | "proposed" | "decision" | "remaining";
    detail: string;
  }[];
  operations: Operation[];
  remainingChecks: string[];
}
const digest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function fileBytes(root: string, path: string): Bytes | null {
  const absolute = safePath(root, path);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink > 1)
    throw new Error(`Adoption requires a regular, singly linked file: ${path}`);
  if (stat.size > 2 * 1024 * 1024)
    throw new Error(`Adoption file exceeds 2 MiB: ${path}`);
  const bytes = readFileSync(absolute);
  return {
    sha256: digest(bytes),
    bytesBase64: bytes.toString("base64"),
    mode: stat.mode & 0o7777,
  };
}
/** Source admission rejects canonical and filesystem-identical reserved root aliases. */
function sourcePath(root: string, path: string, allowModuleRoot = false): string {
  const base = safePath(root, ".");
  const absolute = safePath(root, path);
  const normalized = relative(base, absolute).replaceAll(sep, "/");
  const first = normalized.split("/")[0]!;
  if (!normalized && !allowModuleRoot)
    throw new Error("Adoption source cannot be the repository root");
  for (const reserved of [".git", ".arrs", "node_modules"]) {
    const left = lstatSync(join(base, first), { bigint: true, throwIfNoEntry: false });
    const right = lstatSync(join(base, reserved), {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      first === reserved ||
      (left && right && left.dev === right.dev && left.ino === right.ino)
    )
      throw new Error(
        `Adoption source/destination is reserved output or metadata: ${path}`,
      );
  }
  return normalized;
}
function moduleContains(root: string, module: string, path: string): boolean {
  const parent = safePath(root, module),
    child = safePath(root, path);
  return child === parent || child.startsWith(parent + sep);
}

// Retain all existing bytes. Parse JSON token locations rather than reserializing
// unrelated keys. Duplicate keys are rejected to keep insertion unambiguous.
interface JsonNode {
  start: number;
  end: number;
  fields?: Map<string, JsonNode>;
  items?: JsonNode[];
}
function jsonTree(text: string): JsonNode {
  JSON.parse(text);
  let cursor = 0;
  const space = (): void => {
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const c = text[cursor++]!;
      if (c === "\\") cursor++;
      else if (c === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const node = (): JsonNode => {
    space();
    const start = cursor;
    if (text[cursor] === "{") {
      cursor++;
      const fields = new Map<string, JsonNode>();
      space();
      while (text[cursor] !== "}") {
        const key = string();
        if (fields.has(key)) throw new Error(`Duplicate JSON property: ${key}`);
        space();
        cursor++; // colon, already validated by JSON.parse
        fields.set(key, node());
        space();
        if (text[cursor] === ",") {
          cursor++;
          space();
        } else break;
      }
      cursor++;
      return { start, end: cursor, fields };
    }
    if (text[cursor] === "[") {
      cursor++;
      const items: JsonNode[] = [];
      space();
      while (text[cursor] !== "]") {
        items.push(node());
        space();
        if (text[cursor] === ",") {
          cursor++;
          space();
        } else break;
      }
      cursor++;
      return { start, end: cursor, items };
    }
    if (text[cursor] === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
    return { start, end: cursor };
  };
  return node();
}
function appendJson(
  text: string,
  path: string[],
  additions: Record<string, unknown> | unknown[],
): string {
  let node = jsonTree(text);
  for (const key of path) {
    const child = node.fields?.get(key);
    if (!child) throw new Error(`Missing JSON integration object ${path.join(".")}`);
    node = child;
  }
  const values = Array.isArray(additions)
    ? additions.map((item) => JSON.stringify(item))
    : Object.entries(additions).map(([key, value]) => {
        if (node.fields?.has(key))
          throw new Error(`Adoption cannot replace existing JSON key: ${key}`);
        return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
      });
  if (!values.length) return text;
  const children = node.items ?? [...(node.fields?.values() ?? [])];
  if (!node.items && !node.fields)
    throw new Error("Adoption integration target is not an object/array");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const parentIndent =
    /^\s*/.exec(text.slice(text.lastIndexOf("\n", node.start) + 1, node.start))?.[0] ??
    "";
  const existingIndent = children.length
    ? /^[ \t]*/.exec(
        text.slice(text.lastIndexOf("\n", children[0]!.start) + 1, children[0]!.start),
      )?.[0]
    : undefined;
  const indent =
    existingIndent && existingIndent.length > parentIndent.length
      ? existingIndent
      : parentIndent + "  ";
  const position = children.length ? children.at(-1)!.end : node.start + 1;
  const insertion =
    (children.length ? "," : "") +
    newline +
    indent +
    values.join("," + newline + indent) +
    (children.length ? "" : newline + parentIndent);
  const result = text.slice(0, position) + insertion + text.slice(position);
  jsonTree(result);
  return result;
}

export function planAdoption(root: string, inputPath: string): AdoptionProposal {
  sourcePath(root, inputPath);
  fileBytes(root, inputPath);
  const input = readJson(root, inputPath);
  assertValid<AdoptionInput>("adoption-input", input);
  const config = readConfig(root);
  const architecture = readArchitecture(root, config);
  const risk = readRiskPolicy(root, config);
  const proposal: AdoptionProposal = {
    schemaVersion: "0.1",
    kind: "adoption-proposal",
    id: input.id,
    inputPath,
    status: "blocked",
    input,
    snapshots: [],
    discovery: [],
    blockers: [],
    checklist: [],
    operations: [],
    remainingChecks: [
      "Run configured check, test, build and verification targets explicitly after review.",
      "Capture actual behavioral proof; configuration is not executed or accepted evidence.",
      "Obtain separate policy-required independent implementation review and human acceptance.",
      "Hosted CI observations and dependency acceptance remain unevaluated.",
    ],
  };
  const snapshots = new Map<string, AdoptionProposal["snapshots"][number]>();
  const snapshot = (path: string): void => {
    const absolute = safePath(root, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    snapshots.set(path, {
      path,
      sha256: stat ? hashScope(root, path) : null,
      mode: stat ? stat.mode & 0o7777 : null,
    });
  };
  const block = (code: string, message: string, remediation: string): void => {
    proposal.blockers.push({ code, message, remediation });
  };
  const operation = (path: string, replacement: string, reason: string): void => {
    sourcePath(root, path);
    snapshot(path);
    const expected = fileBytes(root, path);
    const bytes = Buffer.from(replacement);
    if (expected?.sha256 === digest(bytes)) return;
    proposal.operations.push({
      path,
      reason,
      expected,
      replacement: {
        sha256: digest(bytes),
        bytesBase64: bytes.toString("base64"),
        mode: expected?.mode ?? 0o644,
      },
    });
  };
  for (const path of [
    inputPath,
    "arrs.json",
    config.architecture.policy,
    config.riskPolicy,
    config.knowledge.features,
  ])
    snapshot(path);
  for (const manifest of [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "tsconfig.json",
  ]) {
    snapshot(manifest);
    if (!existsSync(safePath(root, manifest))) continue;
    proposal.discovery.push({
      kind: "manifest",
      source: manifest,
      name: manifest,
      supplied: false,
      detail: "Existing repository manifest; no installation or execution performed.",
    });
  }
  if (existsSync(safePath(root, "package.json"))) {
    const pkg = readJson(root, "package.json") as { scripts?: Record<string, unknown> };
    const manager = existsSync(safePath(root, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(safePath(root, "yarn.lock"))
        ? "yarn"
        : "npm";
    for (const [name, script] of Object.entries(pkg.scripts ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      if (typeof script === "string")
        proposal.discovery.push({
          kind: "script",
          source: `package.json#/scripts/${name}`,
          name,
          supplied: false,
          detail: `${JSON.stringify([manager, "run", name])}: ${script}`,
        });
  }
  for (const [name, command] of Object.entries(config.commands).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    proposal.discovery.push({
      kind: "configured-command",
      source: `arrs.json#/commands/${name}`,
      name,
      supplied: false,
      detail: JSON.stringify(command),
    });
  for (const [name, command] of Object.entries(config.verifyTargets).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    proposal.discovery.push({
      kind: "configured-target",
      source: `arrs.json#/verifyTargets/${name}`,
      name,
      supplied: false,
      detail: JSON.stringify(command),
    });

  const suppliedPaths = [
    ...(input.entryPoints ?? []),
    ...(input.implementation ?? []),
    ...(input.tests ?? []),
    ...(input.related ?? []),
  ];
  const instructions = new Set<string>(["AGENTS.md"]);
  let sourceFiles: string[] = [];
  for (const path of suppliedPaths) {
    sourcePath(root, path);
    snapshot(path);
    if (!existsSync(safePath(root, path)))
      block(
        "missing-path",
        `Supplied path does not exist: ${path}`,
        "Correct the supplied path to existing source, tests or documentation.",
      );
    let ancestor = dirname(path);
    while (ancestor !== ".") {
      instructions.add(`${ancestor}/AGENTS.md`);
      ancestor = dirname(ancestor);
    }
  }
  for (const path of input.implementation ?? [])
    if (existsSync(safePath(root, path)))
      sourceFiles.push(...walkFiles(root, path, { includeIgnored: true }));
  if (
    !sourceFiles.some((path) => /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path)) ||
    sourceFiles.some((path) => /\.(?:py|go|rs|java|cs|rb|php|vue|svelte)$/.test(path))
  )
    block(
      "unsupported-architecture",
      "The bundled architecture adapter requires declared JavaScript/TypeScript source; this capability's coverage is unsupported or unknown.",
      "Use a supported source scope or qualify a separate language adapter. Directory names do not establish architecture.",
    );
  if (existsSync(safePath(root, "tsconfig.json"))) {
    try {
      const ts = readJson(root, "tsconfig.json") as {
        compilerOptions?: { paths?: unknown; baseUrl?: unknown };
      };
      if (ts.compilerOptions?.paths || ts.compilerOptions?.baseUrl)
        block(
          "unsupported-architecture",
          "TypeScript alias/baseUrl resolution is unsupported by the bundled adapter.",
          "Resolve alias coverage explicitly before adoption; no boundary claim is generated.",
        );
    } catch {
      block(
        "unsupported-architecture",
        "TypeScript configuration cannot be inspected as strict JSON.",
        "Confirm supported literal relative import resolution with a reviewed configuration.",
      );
    }
  }
  for (const path of [...instructions].sort()) {
    snapshot(path);
    if (existsSync(safePath(root, path)))
      proposal.discovery.push({
        kind: "instruction",
        source: path,
        name: path,
        supplied: false,
        detail:
          "Existing scoped instructions; referenced by the map and preserved byte for byte.",
      });
  }
  for (const field of [
    "goal",
    "owners",
    "entryPoints",
    "implementation",
    "boundaries",
    "invariants",
    "sensitivity",
    "acceptance",
    "risk",
    "tests",
  ] as const) {
    const value = input[field];
    if (value === undefined || (Array.isArray(value) && !value.length))
      block(
        `missing-${field}`,
        `Owner-supplied ${field} is missing.`,
        `Supply actual capability ${field}; ARRS cannot infer product facts or ownership.`,
      );
  }
  const additions = input.architecture?.modules ?? [];
  const modules = [...architecture.modules];
  for (const module of additions) {
    const existing = modules.find(
      (item) =>
        item.id === module.id ||
        safePath(root, item.path) === safePath(root, module.path),
    );
    if (existing) {
      block(
        "module-conflict",
        `Architecture module ${module.id} already exists or overlaps an identical module path.`,
        "Reference the existing module or separately review a policy modification; adoption only appends new explicit modules.",
      );
      continue;
    }
    for (const path of [module.path, ...module.public]) {
      const normalized = sourcePath(root, path, path === module.path);
      if (normalized) snapshot(path);
      if (!existsSync(safePath(root, path)))
        block(
          "missing-module-path",
          `Module path does not exist: ${path}`,
          "Supply actual module and public source paths.",
        );
    }
    for (const path of module.public)
      if (!moduleContains(root, module.path, path))
        block(
          "invalid-public-path",
          `Public path ${path} is outside module ${module.id}.`,
          "Declare a public path contained in the owning module.",
        );
    modules.push(module);
  }
  for (const module of modules)
    for (const allowed of module.allows)
      if (!modules.some((item) => item.id === allowed))
        block(
          "unknown-module",
          `Module ${module.id} permits unknown module ${allowed}.`,
          "Supply or reference a declared module.",
        );
  for (const owner of [...(input.owners ?? []), ...(input.boundaries ?? [])])
    if (!modules.some((module) => module.id === owner))
      block(
        "unknown-owner",
        `Owning module/boundary ${owner} is not declared.`,
        "Select an existing module or supply its real architecture declaration.",
      );
  for (const path of [...(input.entryPoints ?? []), ...(input.implementation ?? [])])
    if (
      !modules.some(
        (module) =>
          (input.boundaries ?? []).includes(module.id) &&
          moduleContains(root, module.path, path),
      )
    )
      block(
        "unowned-path",
        `Source path ${path} is outside supplied declared boundaries.`,
        "Name a declared owning boundary for each actual source path.",
      );
  if (
    additions.length &&
    !proposal.blockers.some((item) =>
      [
        "module-conflict",
        "missing-module-path",
        "invalid-public-path",
        "unknown-module",
      ].includes(item.code),
    )
  )
    operation(
      config.architecture.policy,
      appendJson(
        readFileSync(safePath(root, config.architecture.policy), "utf8"),
        ["modules"],
        additions,
      ),
      "Append only owner-supplied actual architecture declarations; preserve existing policy bytes.",
    );

  const sensitive = input.sensitivePaths ?? [];
  for (const item of sensitive) {
    sourcePath(root, item.path);
    snapshot(item.path);
    if (item.risk < "R3")
      block(
        "invalid-sensitive-rule",
        `Sensitive rule ${item.path} must be R3 or R4, not ${item.risk}.`,
        "Declare the actual sensitive risk floor; invalid proposed controls cannot be applied.",
      );
  }
  if (
    new Set(sensitive.map((item) => sourcePath(root, item.path))).size !==
    sensitive.length
  )
    block(
      "sensitive-conflict",
      "Proposed sensitive rules repeat the same normalized path.",
      "Supply one explicit rule per path.",
    );
  if (
    sensitive.some((item) =>
      risk.sensitivePaths.some(
        (existing) => safePath(root, existing.path) === safePath(root, item.path),
      ),
    )
  )
    block(
      "sensitive-conflict",
      "A proposed sensitive path already has an existing rule.",
      "Reference the existing coverage or separately review a policy change.",
    );
  else if (
    sensitive.length &&
    !proposal.blockers.some((item) =>
      ["invalid-sensitive-rule", "sensitive-conflict"].includes(item.code),
    )
  )
    operation(
      config.riskPolicy,
      appendJson(
        readFileSync(safePath(root, config.riskPolicy), "utf8"),
        ["sensitivePaths"],
        sensitive,
      ),
      "Append explicit sensitive-path decisions without replacing risk classes or existing rules.",
    );
  if (input.sensitivity === "sensitive" || input.sensitivity === "critical") {
    const minimum = input.sensitivity === "critical" ? "R4" : "R3";
    if (!input.risk || input.risk < minimum)
      block(
        "sensitive-risk",
        `Sensitivity requires at least ${minimum}.`,
        "Supply the appropriate risk and explicit sensitive-path coverage.",
      );
    for (const path of input.implementation ?? [])
      if (
        ![...risk.sensitivePaths, ...sensitive].some(
          (item) => item.risk >= minimum && moduleContains(root, item.path, path),
        )
      )
        block(
          "missing-sensitive-decision",
          `Sensitive implementation has no explicit ${minimum} coverage: ${path}`,
          "Supply the sensitive-path decision; adoption cannot infer it.",
        );
  }
  const target = input.verification?.target;
  if (!target) {
    const candidates = proposal.discovery.filter(
      (item) => item.kind === "script" && /test|verify|acceptance/.test(item.name),
    );
    block(
      "verification-decision",
      `No explicit verification target was supplied. Candidates: ${candidates.map((item) => item.source).join(", ") || "none"}.`,
      "Select an explicit own verification target and, if absent from configuration, provide its existing command argv. Candidate scripts remain unconfirmed.",
    );
  } else if (Object.hasOwn(config.verifyTargets, target)) {
    if (
      input.verification?.command &&
      canonical(config.verifyTargets[target]) !== canonical(input.verification.command)
    )
      block(
        "command-conflict",
        `Verification target ${target} has a different existing command binding.`,
        "Reference the existing binding or separately review a command transition.",
      );
  } else if (!input.verification?.command) {
    block(
      "verification-decision",
      `Verification target ${target} is not an own configured entry.`,
      "Supply its explicit existing command argv; discovery never selects one automatically.",
    );
  } else {
    operation(
      "arrs.json",
      appendJson(readFileSync(safePath(root, "arrs.json"), "utf8"), ["verifyTargets"], {
        [target]: input.verification.command,
      }),
      `Add explicitly supplied own verification target ${target}; no commands run and all unrelated config bytes remain unchanged.`,
    );
  }
  for (const name of ["check", "test", "build", "verify"] as const)
    if (!Object.hasOwn(config.commands, name))
      block(
        "missing-command",
        `Required existing ${name} command is unconfigured.`,
        "Configure the actual existing command through a separately reviewed command transition, then replan adoption.",
      );
  const existingMaps = scanFeatures(root, config);
  for (const error of existingMaps.errors)
    block(
      "existing-contract",
      error,
      "Repair the existing repository contract before applying an adoption patch; read-only partial proposals remain available.",
    );
  if (existingMaps.features.some((map) => map.id === input.id))
    block(
      "existing-capability",
      `Feature identity ${input.id} already exists.`,
      "Use a new capability identity or separately review an existing-map update.",
    );
  for (const dependency of input.dependencies ?? [])
    if (!existingMaps.features.some((map) => map.id === dependency))
      block(
        "unknown-dependency",
        `Feature dependency ${dependency} is unmapped.`,
        "Reference a maintained feature identity or resolve the dependency decision.",
      );
  if (!proposal.blockers.length) {
    const map: FeatureMap = {
      schemaVersion: "0.1",
      id: input.id,
      goal: input.goal!,
      owners: input.owners!,
      entryPoints: input.entryPoints!,
      implementation: input.implementation!,
      boundaries: input.boundaries!,
      dependencies: input.dependencies ?? [],
      domainTerms: input.domainTerms ?? [],
      invariants: input.invariants!,
      sensitivity: input.sensitivity!,
      acceptance: input.acceptance!,
      verification: { target: target! },
      risk: input.risk!,
      related: [
        ...new Set([
          ...(input.related ?? []),
          ...proposal.discovery
            .filter((item) => item.kind === "instruction")
            .map((item) => item.source),
        ]),
      ],
    };
    assertValid<FeatureMap>("feature", map);
    const destination = `${config.knowledge.features}/${input.id}.json`;
    if (existsSync(safePath(root, destination)))
      block(
        "existing-map",
        `Map destination exists: ${destination}`,
        "Choose an unused feature identity; existing maps are never overwritten.",
      );
    else
      operation(
        destination,
        json(map),
        "Create one schema-valid capability map using supplied acceptance/ownership and real scoped instruction pointers.",
      );
  }
  proposal.operations.sort((a, b) => a.path.localeCompare(b.path));
  if (
    new Set(proposal.operations.map((item) => sourcePath(root, item.path))).size !==
    proposal.operations.length
  )
    throw new Error("Repeated adoption operation targets");
  proposal.snapshots = [...snapshots.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  proposal.checklist = [
    {
      id: "facts",
      status: proposal.blockers.length ? "decision" : "configured",
      detail:
        "Owner-supplied acceptance, real paths, declared ownership and explicit verification binding.",
    },
    {
      id: "patch",
      status: "proposed",
      detail: `${proposal.operations.length} ordered exact-byte operations; inspect every expected/replacement pair before applying.`,
    },
    {
      id: "context",
      status: "configured",
      detail:
        "Existing root/scoped instructions are sourced references; adoption never rewrites them.",
    },
    {
      id: "authorization",
      status: "remaining",
      detail:
        "Apply classifies actual paths under unchanged pre-change controls. Existing control edits require external baseline and separate proposal-bound execution authorization.",
    },
    ...proposal.remainingChecks.map((detail, index) => ({
      id: `remaining-${index + 1}`,
      status: "remaining" as const,
      detail,
    })),
  ];
  proposal.status = proposal.blockers.length ? "blocked" : "ready-for-review";
  assertValid<AdoptionProposal>("adoption-proposal", proposal);
  return proposal;
}

function outputPath(root: string, path: string): string {
  const absolute = safePath(root, path);
  const normalized = relative(safePath(root, "."), absolute).replaceAll(sep, "/");
  if (
    path !== normalized ||
    !/^\.arrs\/adoption\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "Adoption output must use a canonical contained .arrs/adoption/<name> path",
    );
  const config = readConfig(root);
  if (pathsOverlap(normalized, config.proof.evidenceDir))
    throw new Error("Adoption output cannot overlap proof evidence");
  evidenceIgnoreProtection(root, path);
  return absolute;
}
export function writeAdoptionProposal(
  root: string,
  proposal: AdoptionProposal,
  directory: string,
): { proposal: string; sha256: string; patch: string } {
  const absolute = outputPath(root, directory);
  if (existsSync(absolute))
    throw new Error(
      "Adoption output must be fresh; existing artifacts are never overwritten",
    );
  mkdirSync(absolute, { recursive: true });
  const path = `${directory}/proposal.json`;
  const bytes = json(proposal);
  writeFileSync(safePath(root, path), bytes, { flag: "wx", mode: 0o600 });
  const patchPath = `${directory}/patch.diff`;
  const patch = proposal.operations
    .map((operation) => {
      const before = operation.expected
        ? Buffer.from(operation.expected.bytesBase64, "base64").toString("utf8")
        : "";
      const after = Buffer.from(operation.replacement.bytesBase64, "base64").toString(
        "utf8",
      );
      return (
        `diff --arrs ${operation.path}\n--- ${operation.expected ? operation.expected.sha256 : "absent"} mode=${operation.expected?.mode ?? "absent"}\n+++ ${operation.replacement.sha256} mode=${operation.replacement.mode}\n` +
        before
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n") +
        "\n" +
        after
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") +
        "\n"
      );
    })
    .join("\n");
  writeFileSync(safePath(root, patchPath), patch, { flag: "wx", mode: 0o600 });
  return { proposal: path, sha256: digest(bytes), patch: patchPath };
}

export function applyAdoption(
  root: string,
  proposalPath: string,
  authorizationPath?: string,
  baseline?: PolicyBaseline,
): object {
  const proposalBytes = fileBytes(root, proposalPath);
  if (!proposalBytes) throw new Error("Adoption proposal is missing");
  const proposal = readJson(root, proposalPath);
  assertValid<AdoptionProposal>("adoption-proposal", proposal);
  if (proposal.status !== "ready-for-review" || proposal.blockers.length)
    throw new Error(
      "Adoption proposal has unresolved blockers; no application writes permitted",
    );
  const paths = proposal.operations.map((item) => sourcePath(root, item.path));
  if (!paths.length || new Set(paths).size !== paths.length)
    throw new Error("Empty or repeated adoption operation targets");
  for (const item of proposal.operations) {
    if (canonical(fileBytes(root, item.path)) !== canonical(item.expected))
      throw new Error(`Stale adoption input: ${item.path}; replan and review`);
    for (const bytes of [item.expected, item.replacement]) {
      if (
        bytes &&
        (Buffer.from(bytes.bytesBase64, "base64").toString("base64") !==
          bytes.bytesBase64 ||
          digest(Buffer.from(bytes.bytesBase64, "base64")) !== bytes.sha256)
      )
        throw new Error(`Malformed adoption bytes: ${item.path}`);
    }
  }
  const derived = planAdoption(root, proposal.inputPath);
  if (canonical(derived) !== canonical(proposal))
    throw new Error(
      "Adoption proposal is stale or modified; replan and review exact operations and snapshots",
    );
  const config = readConfig(root);
  const controlChange = paths.some((path) =>
    ["arrs.json", config.architecture.policy, config.riskPolicy].some((control) =>
      pathsOverlap(path, control),
    ),
  );
  if (controlChange && !baseline)
    throw new Error(
      "Governing-control adoption requires independently retained pre-change --baseline and --baseline-sha256; a proposal cannot select its own controls",
    );
  const requirements = policyRequirements(
    root,
    paths,
    controlChange ? "R3" : "R2",
    baseline,
  );
  if (requirements.risk === "R4")
    throw new Error(
      "R4 adoption requires human-owned execution; this authoring workflow cannot apply it",
    );
  let authorizationRecord:
    { path: string; sha256: string; humanApproval: string } | undefined;
  if (authorizationPath) {
    if (authorizationPath === proposalPath)
      throw new Error("Apply requires a separate actual execution authorization file");
    sourcePath(root, authorizationPath);
    const bytes = fileBytes(root, authorizationPath);
    if (!bytes) throw new Error("Execution authorization file is missing");
    const authorization = readJson(root, authorizationPath);
    assertValid<{ schemaVersion: "0.1"; proposalSha256: string; humanApproval: string }>(
      "adoption-authorization",
      authorization,
    );
    if (authorization.proposalSha256 !== proposalBytes.sha256)
      throw new Error(
        "Execution authorization does not bind the reviewed proposal bytes",
      );
    authorizationRecord = {
      path: authorizationPath,
      sha256: bytes.sha256,
      humanApproval: authorization.humanApproval,
    };
  }
  if ((requirements.policy.humanApproval || controlChange) && !authorizationRecord)
    throw new Error(
      "Apply requires a separate actual execution authorization file bound to this proposal digest",
    );
  // Proposed risk rules/modules never reduce the pre-change requirements used here.
  const risk = requirements.risk;
  const directory = `.arrs/adoption/recovery-${randomUUID()}`;
  const recovery = outputPath(root, directory);
  if (existsSync(recovery)) throw new Error("Recovery allocation collision");
  const createdDirectories: string[] = [];
  for (const item of proposal.operations) {
    let parent = dirname(safePath(root, item.path));
    while (!existsSync(parent)) {
      createdDirectories.push(parent);
      parent = dirname(parent);
    }
    if (!lstatSync(parent).isDirectory())
      throw new Error(`Adoption destination parent is not a directory: ${item.path}`);
  }
  mkdirSync(recovery, { recursive: true, mode: 0o700 });
  const journal = {
    schemaVersion: "0.1",
    kind: "adoption-recovery",
    proposal: proposalPath,
    proposalSha256: proposalBytes.sha256,
    risk,
    status: "prepared",
    operations: proposal.operations,
    attempted: [] as string[],
    applied: [] as string[],
    rollbackErrors: [] as string[],
    ...(authorizationRecord ? { authorization: authorizationRecord } : {}),
    ...(baseline ? { policyBaseline: baseline } : {}),
  };
  const persist = (): void => {
    const temp = join(recovery, "state.tmp");
    writeFileSync(temp, json(journal), { mode: 0o600 });
    renameSync(temp, join(recovery, "recovery.json"));
  };
  persist();
  try {
    for (const item of proposal.operations) {
      // Recheck immediately before each write. Cooperative local operation only;
      // no cross-process transaction or hostile filesystem race is claimed.
      if (canonical(fileBytes(root, item.path)) !== canonical(item.expected))
        throw new Error(`Stale adoption destination during application: ${item.path}`);
      const absolute = safePath(root, item.path);
      journal.attempted.push(item.path);
      persist();
      mkdirSync(dirname(absolute), { recursive: true });
      if (!item.expected) {
        writeFileSync(absolute, Buffer.from(item.replacement.bytesBase64, "base64"), {
          flag: "wx",
          mode: item.replacement.mode,
        });
      } else {
        const staged = join(recovery, `replacement-${journal.applied.length}.tmp`);
        writeFileSync(staged, Buffer.from(item.replacement.bytesBase64, "base64"), {
          flag: "wx",
          mode: item.replacement.mode,
        });
        chmodSync(staged, item.replacement.mode);
        renameSync(staged, absolute);
      }
      journal.applied.push(item.path);
      if (!item.expected) chmodSync(absolute, item.replacement.mode);
      persist();
    }
    journal.status = "applied";
    persist();
  } catch (error) {
    for (const path of [...journal.attempted].reverse()) {
      const item = proposal.operations.find((operation) => operation.path === path)!;
      try {
        const current = canonical(fileBytes(root, path));
        if (current === canonical(item.expected)) continue;
        if (current !== canonical(item.replacement))
          throw new Error(
            "Intervening bytes/mode differ; retained original requires manual review",
          );
        const absolute = safePath(root, path);
        if (item.expected) {
          writeFileSync(absolute, Buffer.from(item.expected.bytesBase64, "base64"));
          chmodSync(absolute, item.expected.mode);
        } else unlinkSync(absolute);
      } catch (rollback) {
        journal.rollbackErrors.push(
          `${path}: ${rollback instanceof Error ? rollback.message : String(rollback)}`,
        );
      }
    }
    for (const path of [...new Set(createdDirectories)].sort(
      (a, b) => b.length - a.length,
    )) {
      try {
        rmdirSync(path);
      } catch {
        /* Nonempty or intervening directories are preserved. */
      }
    }
    journal.status = journal.rollbackErrors.length ? "partial-write" : "rolled-back";
    try {
      persist();
    } catch {
      /* Retained prepared journal still contains every original. */
    }
    throw new Error(
      `Adoption ${journal.status}: ${error instanceof Error ? error.message : String(error)}. Recovery: ${directory}/recovery.json. Attempted paths: ${journal.attempted.join(", ") || "none"}. Applied paths: ${journal.applied.join(", ") || "none"}. ${journal.rollbackErrors.join("; ")}`,
    );
  }
  return {
    schemaVersion: "0.1",
    kind: "adoption-application",
    id: proposal.id,
    status: "configured",
    risk,
    changedPaths: journal.applied,
    recovery: `${directory}/recovery.json`,
    remainingChecks: proposal.remainingChecks,
    behavioralProof: "not-evaluated",
    policyMode: baseline ? "protected-transition" : "candidate-only",
    reviewRequirements: {
      independent: requirements.policy.independentReview,
      humanAcceptance: requirements.policy.humanApproval || controlChange,
    },
    accepted: false,
    ...(baseline ? { policyBaseline: baseline } : {}),
  };
}
