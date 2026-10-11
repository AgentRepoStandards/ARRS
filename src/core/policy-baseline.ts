import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import {
  classifyRisk,
  readConfig,
  readRiskPolicy,
  repositoryPathsOverlap,
  scanFeatures,
} from "./config.js";
import { safePath, walkFiles } from "./files.js";
import { resolveCommand } from "./runner.js";
import type {
  ArrsConfig,
  FeatureMap,
  PolicyBaseline,
  Risk,
  RiskPolicy,
} from "./types.js";

interface Controls {
  config: ArrsConfig;
  policy: RiskPolicy;
  features: FeatureMap[];
}

function assertInventoriedSource(root: string, path: string, kind: string): void {
  const first = posix.normalize(path).split("/")[0]!;
  const excluded = [".git", ".arrs", "node_modules"].find(
    (name) => name.toUpperCase() === first.toUpperCase(),
  );
  if (!excluded) return;
  let outsideInventory = first === excluded;
  if (!outsideInventory) {
    const base = safePath(root, ".");
    const entry = lstatSync(join(base, first), { bigint: true, throwIfNoEntry: false });
    const reserved = entry
      ? lstatSync(join(base, excluded), { bigint: true, throwIfNoEntry: false })
      : undefined;
    outsideInventory = Boolean(
      entry && reserved && entry.dev === reserved.dev && entry.ino === reserved.ino,
    );
  }
  if (outsideInventory)
    throw new Error(
      `Protected policy baseline ${kind} must use inventoried source outside excluded root ${excluded}: ${path}. Select source paths outside root metadata/evidence/dependencies; candidate-only evaluation cannot authorize the transition`,
    );
}

function controls(root: string, baseline = false): Controls {
  const config = readConfig(root);
  const policy = readRiskPolicy(root, config);
  const maps = scanFeatures(root, config);
  if (maps.errors.length)
    throw new Error(`Invalid policy Feature Maps: ${maps.errors.join("; ")}`);
  if (baseline)
    for (const path of [
      ...policy.sensitivePaths.map((item) => item.path),
      ...maps.features.flatMap((feature) => [
        ...feature.implementation,
        ...feature.entryPoints,
      ]),
    ])
      assertInventoriedSource(root, path, "floor reference");
  return { config, policy, features: maps.features };
}

function externalRoot(candidate: string, source: string): string {
  if (!isAbsolute(source)) throw new Error("Policy baseline root must be absolute");
  const entry = lstatSync(source, { throwIfNoEntry: false });
  if (!entry)
    throw new Error(
      "Selected policy baseline directory is missing; restore the independently selected known-good pre-change source before protected evaluation",
    );
  if (entry.isSymbolicLink())
    throw new Error("Policy baseline root must not be a symlink");
  if (!entry.isDirectory())
    throw new Error("Policy baseline must be a known-good external repository directory");
  const root = realpathSync(resolve(source));
  const current = realpathSync(resolve(candidate));
  if (root === current || root.startsWith(current + sep))
    throw new Error(
      "Policy baseline must be a known-good external directory selected before editing, outside the candidate checkout",
    );
  return root;
}

function controlDigest(root: string, config: ArrsConfig): string {
  const files = new Set([
    "arrs.json",
    config.riskPolicy,
    config.architecture.policy,
    ...walkFiles(root, config.knowledge.features).filter((file) =>
      file.endsWith(".json"),
    ),
  ]);
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(safePath(root, path)));
    hash.update("\0");
  }
  // Alias floors depend on source identities as well as rule bytes. Keep the
  // selected source immutable; excluded output/dependency roots are not inspected.
  hash.update("source-identities-v1\0");
  let entries: string[];
  try {
    entries = walkFiles(root, ".", {
      includeIgnored: true,
      includeDirectories: true,
      excludedPaths: [".git", ".arrs", "node_modules"],
    }).sort();
  } catch (error) {
    throw new Error(
      `Cannot pin baseline source identities; prepare a bounded symlink-free known-good source before selection: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const path of entries) {
    const stat = lstatSync(safePath(root, path), { bigint: true });
    hash.update(
      `${path}\0${stat.isDirectory() ? "directory" : "file"}\0${stat.dev}\0${stat.ino}\0`,
    );
  }
  return hash.digest("hex");
}

/** Inspection binds known-good bytes; a human/workflow establishes pre-change trust. */
export function inspectPolicyBaseline(candidate: string, source: string): PolicyBaseline {
  const root = externalRoot(candidate, resolve(source));
  const selected = controls(root, true);
  return { root, sha256: controlDigest(root, selected.config) };
}

export function samePolicyBaseline(a?: PolicyBaseline, b?: PolicyBaseline): boolean {
  return a?.root === b?.root && a?.sha256 === b?.sha256;
}

/** A persisted reference cannot select its own trust context. Never silently downgrade. */
export function requirePolicyBaseline(
  bound?: PolicyBaseline,
  supplied?: PolicyBaseline,
): void {
  if (bound && !supplied)
    throw new Error(
      "Baseline-bound record requires independently supplied --baseline and --baseline-sha256 selected before the edit",
    );
  if (bound && !samePolicyBaseline(bound, supplied))
    throw new Error(
      "Supplied policy baseline does not match this record's selected baseline",
    );
}

function selectedControls(candidate: string, selection: PolicyBaseline): Controls {
  if (!/^[a-f0-9]{64}$/.test(selection.sha256))
    throw new Error("Policy baseline requires an independently retained SHA-256 digest");
  const root = externalRoot(candidate, selection.root);
  if (root !== selection.root)
    throw new Error(
      "Policy baseline root identity changed; use the original selected directory",
    );
  let selected: Controls;
  try {
    selected = controls(root, true);
  } catch (error) {
    throw new Error(
      `Selected pre-change baseline is invalid; restore its original controls before protected evaluation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (controlDigest(root, selected.config) !== selection.sha256)
    throw new Error(
      "Selected policy baseline controls changed, source identities changed, or digest mismatched; restore the original immutable pre-change source, do not repin the candidate. Prepare/build the known-good source before selecting its digest",
    );
  return selected;
}

function mappedTargets(root: string, scope: string[], features: FeatureMap[]): string[] {
  return features
    .filter((feature) =>
      scope.some((path) =>
        [...feature.implementation, ...feature.entryPoints].some((entry) =>
          repositoryPathsOverlap(root, path, entry),
        ),
      ),
    )
    .map((feature) => feature.verification.target);
}

export function policyRequirements(
  root: string,
  scope: string[],
  requested: Risk,
  selection?: PolicyBaseline,
): {
  risk: Risk;
  config: ArrsConfig;
  policy: RiskPolicy["classes"][Risk];
  requiredChecks: ArrsConfig["proof"]["requiredChecks"];
  behavioralRequiredFrom: Risk;
  verificationTargets: string[];
  features: FeatureMap[];
  baselineFeatures: FeatureMap[];
  assertCommand: (command: Parameters<typeof resolveCommand>[1], target?: string) => void;
} {
  const current = controls(root);
  const baseline = selection ? selectedControls(root, selection) : undefined;
  if (selection)
    for (const path of scope) {
      assertInventoriedSource(root, path, "scope/context");
      assertInventoriedSource(selection.root, path, "scope/context");
    }
  let risk = classifyRisk(root, scope, requested, current.policy, current.features);
  if (baseline && selection) {
    risk = classifyRisk(root, scope, risk, baseline.policy, baseline.features);
    risk = classifyRisk(selection.root, scope, risk, baseline.policy, baseline.features);
  }
  const candidateClass = current.policy.classes[risk];
  const baselineClass = baseline?.policy.classes[risk];
  const autonomy = [candidateClass.autonomy, baselineClass?.autonomy].includes("human")
    ? "human"
    : [candidateClass.autonomy, baselineClass?.autonomy].includes("review")
      ? "review"
      : "unattended";
  const requiredChecks = [
    ...new Set([
      ...current.config.proof.requiredChecks,
      ...candidateClass.requiredChecks,
      ...(baseline?.config.proof.requiredChecks ?? []),
      ...(baselineClass?.requiredChecks ?? []),
    ]),
  ];
  const assertCommand = (
    command: Parameters<typeof resolveCommand>[1],
    target?: string,
  ): void => {
    const candidateCommand = resolveCommand(current.config, command, target);
    if (baseline) {
      const baselineCommand = resolveCommand(baseline.config, command, target);
      if (
        JSON.stringify(candidateCommand.argv) !== JSON.stringify(baselineCommand.argv) ||
        (candidateCommand.timeoutSeconds ?? 300) !==
          (baselineCommand.timeoutSeconds ?? 300)
      )
        throw new Error(
          `Protected policy transition changes command binding ${command}${target ? ` ${target}` : ""}; retain pre-change argv/timeout or stage a separately reviewed command transition before selecting a new baseline`,
        );
    }
  };
  const verificationTargets =
    baseline && selection
      ? [
          ...new Set([
            ...mappedTargets(root, scope, current.features),
            ...mappedTargets(root, scope, baseline.features),
            ...mappedTargets(selection.root, scope, baseline.features),
          ]),
        ]
      : [];
  if (baseline) for (const check of requiredChecks) assertCommand(check);
  for (const target of verificationTargets) assertCommand("verify", target);
  return {
    risk,
    config: current.config,
    policy: {
      autonomy,
      requiredChecks,
      independentReview:
        candidateClass.independentReview || Boolean(baselineClass?.independentReview),
      humanApproval:
        candidateClass.humanApproval || Boolean(baselineClass?.humanApproval),
    },
    requiredChecks,
    behavioralRequiredFrom:
      baseline &&
      baseline.config.proof.behavioralRequiredFrom <
        current.config.proof.behavioralRequiredFrom
        ? baseline.config.proof.behavioralRequiredFrom
        : current.config.proof.behavioralRequiredFrom,
    verificationTargets,
    features: current.features,
    baselineFeatures: baseline?.features ?? [],
    assertCommand,
  };
}

export function policyMode(
  selection?: PolicyBaseline,
): "protected-transition" | "candidate-only" {
  return selection ? "protected-transition" : "candidate-only";
}

export const candidatePolicyLimitation =
  "Candidate-only local evaluation is informational for policy transitions; it does not establish pre-change authorization.";
