import { existsSync, lstatSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { readJson, safePath, walkFiles } from "./files.js";
import { assertValid } from "./schema.js";
import type {
  ArrsConfig,
  ArchitecturePolicy,
  FeatureMap,
  Risk,
  RiskPolicy,
} from "./types.js";

export function readConfig(root: string): ArrsConfig {
  const value = readJson(root, "arrs.json");
  assertValid<ArrsConfig>("config", value);
  const paths = [
    ...Object.values(value.knowledge),
    value.architecture.policy,
    value.riskPolicy,
    value.proof.evidenceDir,
    value.skills.path,
    value.ci.workflow,
    value.security.exceptions,
    ...(value.work ? [value.work.path] : []),
  ];
  for (const path of paths) safePath(root, path);
  const skillsPath = safePath(root, value.skills.path);
  const generatedPath = safePath(root, ".arrs");
  if (skillsPath === generatedPath || skillsPath.startsWith(generatedPath + sep))
    throw new Error(
      "skills.path must be outside the reserved .arrs generated-output tree",
    );
  if (value.work) {
    const workPath = safePath(root, value.work.path);
    if (workPath === generatedPath || workPath.startsWith(generatedPath + sep))
      throw new Error(
        "work.path must be outside the reserved .arrs generated-output tree",
      );
  }
  if (!value.proof.evidenceDir.startsWith(".arrs/"))
    throw new Error(
      "proof.evidenceDir must be inside .arrs/ to separate generated evidence from source",
    );
  return value;
}

export function readArchitecture(
  root: string,
  config = readConfig(root),
): ArchitecturePolicy {
  const value = readJson(root, config.architecture.policy);
  assertValid<ArchitecturePolicy>("architecture", value);
  const roots = new Set<string>();
  for (const entry of value.adapter?.packageRoots ?? []) {
    const path = safePath(root, entry);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new Error(`Python package root is not a directory: ${entry}`);
    if (roots.has(path))
      throw new Error(`Duplicate normalized Python package root: ${entry}`);
    roots.add(path);
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const module of value.modules) {
    if (ids.has(module.id))
      throw new Error(`Duplicate architecture module ID: ${module.id}`);
    ids.add(module.id);
    const path = safePath(root, module.path);
    if (!existsSync(path))
      throw new Error(`Architecture module path does not exist: ${module.path}`);
    if (paths.has(path))
      throw new Error(`Duplicate architecture module path: ${module.path}`);
    paths.add(path);
    for (const entry of module.public) {
      const publicPath = safePath(root, entry);
      if (!existsSync(publicPath))
        throw new Error(`Public interface does not exist: ${entry}`);
      if (publicPath !== path && !publicPath.startsWith(path + sep))
        throw new Error(`Public interface ${entry} is outside module ${module.id}`);
    }
  }
  for (const module of value.modules)
    for (const allowed of module.allows) {
      if (!ids.has(allowed))
        throw new Error(`Module ${module.id} allows unknown module ${allowed}`);
    }
  return value;
}

export function readRiskPolicy(root: string, config = readConfig(root)): RiskPolicy {
  const value = readJson(root, config.riskPolicy);
  assertValid<RiskPolicy>("risk", value);
  for (const [risk, policy] of Object.entries(value.classes)) {
    if (risk >= "R3" && (policy.autonomy === "unattended" || !policy.independentReview))
      throw new Error(
        `${risk} must require independent review and cannot allow unattended work`,
      );
    if (risk === "R4" && (policy.autonomy !== "human" || !policy.humanApproval))
      throw new Error("R4 must require human autonomy and human approval");
    if (!policy.requiredChecks.includes("check"))
      throw new Error(`${risk} must require check`);
    if (risk >= "R1" && !policy.requiredChecks.includes("test"))
      throw new Error(`${risk} must require test`);
    if (
      risk >= "R2" &&
      !["check", "test", "verify"].every((check) =>
        policy.requiredChecks.includes(check as "check" | "test" | "verify"),
      )
    )
      throw new Error(`${risk} must require check, test and verify`);
    if (risk >= "R3" && !policy.requiredChecks.includes("build"))
      throw new Error(`${risk} must require build`);
  }
  for (const item of value.sensitivePaths) {
    safePath(root, item.path);
    if (item.risk < "R3") throw new Error(`Sensitive path ${item.path} must be R3 or R4`);
  }
  return value;
}

export interface FeatureScan {
  features: FeatureMap[];
  errors: string[];
}
export function scanFeatures(
  root: string,
  config = readConfig(root),
  options: { includeIgnored?: boolean; maxFiles?: number } = {},
): FeatureScan {
  const features: FeatureMap[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  let files: string[];
  try {
    files = walkFiles(root, config.knowledge.features, options).filter((file) =>
      file.endsWith(".json"),
    );
  } catch (error) {
    return { features, errors: [String(error)] };
  }
  if (!files.length)
    errors.push(`No Feature Maps found under ${config.knowledge.features}`);
  for (const file of files) {
    try {
      const value = readJson(root, file);
      assertValid<FeatureMap>("feature", value);
      if (ids.has(value.id)) throw new Error(`Duplicate Feature Map id ${value.id}`);
      ids.add(value.id);
      for (const path of [
        ...value.entryPoints,
        ...value.implementation,
        ...value.related,
      ])
        if (!existsSync(safePath(root, path)))
          throw new Error(`Referenced path does not exist: ${path}`);
      if (!Object.hasOwn(config.verifyTargets, value.verification.target))
        throw new Error(
          `Feature ${value.id} references unconfigured verification target ${value.verification.target}`,
        );
      if (value.sensitivity === "sensitive" && value.risk < "R3")
        throw new Error(`Sensitive feature ${value.id} must be at least R3`);
      if (value.sensitivity === "critical" && value.risk !== "R4")
        throw new Error(`Critical feature ${value.id} must be R4`);
      features.push(value);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (features.length) {
    try {
      const policy = readArchitecture(root, config);
      if (!policy.modules.length)
        throw new Error(
          `Feature ownership is blocked: architecture is unconfigured at ${config.architecture.policy}; declare real modules before validating ownership`,
        );
      for (const feature of features) {
        for (const boundary of [...feature.owners, ...feature.boundaries])
          if (!policy.modules.some((module) => module.id === boundary))
            errors.push(
              `Feature ${feature.id} references unknown owning module/boundary ${boundary}`,
            );
        for (const path of [...feature.entryPoints, ...feature.implementation]) {
          const absolute = safePath(root, path);
          if (
            !policy.modules.some(
              (module) =>
                feature.boundaries.includes(module.id) &&
                (absolute === safePath(root, module.path) ||
                  absolute.startsWith(safePath(root, module.path) + sep)),
            )
          )
            errors.push(
              `Feature ${feature.id} path ${path} is outside its declared boundaries`,
            );
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const feature of features)
    for (const dependency of feature.dependencies)
      if (!ids.has(dependency))
        errors.push(`Feature ${feature.id} has unknown dependency ${dependency}`);
  return { features, errors };
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = posix.normalize(a).replace(/\/$/, "");
  const right = posix.normalize(b).replace(/\/$/, "");
  return (
    left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

/** Preserve source risk floors for actual aliases without assuming filesystem casing. */
export function repositoryPathsOverlap(root: string, a: string, b: string): boolean {
  if (pathsOverlap(a, b)) return true;
  const base = safePath(root, ".");
  const left = relative(base, safePath(root, a)).split(sep);
  const right = relative(base, safePath(root, b)).split(sep);
  const sameEntry = (leftDepth: number, rightDepth: number): boolean | undefined => {
    const leftStat = lstatSync(join(base, ...left.slice(0, leftDepth)), {
      bigint: true,
      throwIfNoEntry: false,
    });
    const rightStat = lstatSync(join(base, ...right.slice(0, rightDepth)), {
      bigint: true,
      throwIfNoEntry: false,
    });
    return leftStat && rightStat
      ? leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
      : undefined;
  };
  // Explicit file references can also alias through hardlinks at different depths.
  if (left.length !== right.length && sameEntry(left.length, right.length)) return true;
  for (let depth = Math.min(left.length, right.length); depth > 0; depth--) {
    const identical = sameEntry(depth, depth);
    if (identical !== undefined) return identical;
    // Absent entries have no identity: only peel identically spelled missing suffixes.
    if (left[depth - 1] !== right[depth - 1]) return false;
  }
  return true;
}

export function effectiveRisk(root: string, scope: string[], requested: Risk): Risk {
  const config = readConfig(root);
  const policy = readRiskPolicy(root, config);
  const maps = scanFeatures(root, config);
  if (maps.errors.length)
    throw new Error(
      `Cannot classify scope against invalid Feature Maps: ${maps.errors.join("; ")}`,
    );
  return classifyRisk(root, scope, requested, policy, maps.features);
}

/** Apply validated rule data against this filesystem, including actual aliases. */
export function classifyRisk(
  root: string,
  scope: string[],
  requested: Risk,
  policy: RiskPolicy,
  features: FeatureMap[],
): Risk {
  let result = requested;
  for (const path of scope) {
    safePath(root, path);
    for (const item of policy.sensitivePaths)
      if (item.risk > result && repositoryPathsOverlap(root, path, item.path))
        result = item.risk;
    for (const feature of features)
      if (
        feature.risk > result &&
        [...feature.implementation, ...feature.entryPoints].some((entry) =>
          repositoryPathsOverlap(root, path, entry),
        )
      )
        result = feature.risk;
  }
  return result;
}
