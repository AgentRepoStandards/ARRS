import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { readConfig, scanFeatures } from "./config.js";
import { references } from "./context.js";
import { validatePlan } from "./evidence.js";
import { readJson, safePath, walkFiles } from "./files.js";
import {
  candidatePolicyLimitation,
  policyMode,
  policyRequirements,
  requirePolicyBaseline,
} from "./policy-baseline.js";
import { resolveCommand } from "./runner.js";
import { assertValid } from "./schema.js";
import { validateWorkItem, type WorkItem } from "./work.js";
import type {
  CommandName,
  FeatureMap,
  PolicyBaseline,
  ProofPlan,
  ProofStep,
} from "./types.js";

export const preparationLimits = {
  features: 32,
  dependencyDepth: 8,
  documents: 32,
  navigationDepth: 2,
  documentBytes: 64_000,
  inventoryFiles: 1024,
  fileBytes: 8 * 1024 * 1024,
  inventoryBytes: 64 * 1024 * 1024,
} as const;
export interface PreparationScenarios {
  schemaVersion: "0.1";
  scenarios: Array<{
    id: string;
    target: string;
    criterion: string;
    beforeExitCode: number;
    afterExitCode: number;
  }>;
}
export interface PreparedTask {
  schemaVersion: "0.1";
  kind: "prepared-task";
  id: string;
  status: "draft" | "blocked" | "human-required";
  objective: string;
  category: WorkItem["category"];
  acceptance: string[];
  dependencies: string[];
  decisions: string[];
  scenarios: PreparationScenarios["scenarios"];
  selectionRule: string;
  scope: string[];
  features: Array<{
    id: string;
    selected: boolean;
    map: FeatureMap;
    path: string;
    source: "candidate" | "baseline";
  }>;
  inventory: Array<{
    path: string;
    kind: "file";
    sha256: string;
    bytes: number;
    reasons: string[];
    provenance: string[];
  }>;
  documents: Array<{ path: string; text: string }>;
  omitted: Array<{ path: string; reason: string }>;
  blockers: string[];
  requirements: {
    requestedRisk: WorkItem["risk"];
    risk: WorkItem["risk"];
    policyEvaluation: string;
    policyBaseline?: PolicyBaseline;
    limitation?: string;
    autonomy: string;
    authorizationRequired: boolean;
    independentReviewRequired: boolean;
    humanAcceptanceRequired: boolean;
    requiredChecks: CommandName[];
    verificationTargets: string[];
    commands: Array<{
      command: CommandName;
      target?: string;
      argv: string[];
      timeoutSeconds: number;
    }>;
  };
  drafts: {
    work: WorkItem;
    proof?: ProofPlan;
    proofProposal: { steps: ProofStep[]; missingFields: string[] };
    validationErrors: string[];
  };
  limits: typeof preparationLimits;
  warnings: string[];
}
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const ordered = (values: string[]): string[] => [...new Set(values)].sort();
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Assemble local facts only. No command execution, proof allocation or work mutation. */
export function prepareTask(
  root: string,
  workPath: string,
  options: { baseline?: PolicyBaseline; scenariosPath?: string } = {},
): PreparedTask {
  if (lstatSync(safePath(root, workPath)).size > preparationLimits.documentBytes)
    throw new Error("Work input exceeds 64000 bytes; narrow the bounded task");
  const value = readJson(root, workPath);
  assertValid<WorkItem>("work-item", value);
  return prepareWorkItem(root, value, workPath, options);
}

/** Pure preparation projection for callers that already hold an explicit local item. */
export function prepareWorkItem(
  root: string,
  item: WorkItem,
  workPath: string,
  options: { baseline?: PolicyBaseline; scenariosPath?: string } = {},
): PreparedTask {
  assertValid<WorkItem>("work-item", item);
  safePath(root, workPath);
  if (Buffer.byteLength(JSON.stringify(item)) > preparationLimits.documentBytes)
    throw new Error("Work input exceeds 64000 bytes; narrow the bounded task");
  if (!["needs-triage", "needs-information", "human-required"].includes(item.state))
    throw new Error(
      "Preparation requires a non-executable work state: needs-triage, needs-information or human-required",
    );
  requirePolicyBaseline(item.policyBaseline, options.baseline);
  const config = readConfig(root);
  // Pin trust before discovery and before any optional output can be attempted.
  policyRequirements(root, item.context, item.risk, options.baseline);
  const blockers: string[] = [];
  const omitted: PreparedTask["omitted"] = [];
  const selected: PreparedTask["features"] = [];
  const pathReasons = new Map<
    string,
    { reasons: Set<string>; provenance: Set<string> }
  >();
  const baseline = options.baseline;
  const reference = (path: string, reason: string, provenance: string): void => {
    try {
      safePath(root, path);
      path = posix.normalize(path);
      const entry = pathReasons.get(path) ?? {
        reasons: new Set(),
        provenance: new Set(),
      };
      entry.reasons.add(reason);
      entry.provenance.add(provenance);
      pathReasons.set(path, entry);
    } catch (error) {
      blockers.push(message(error));
    }
  };
  for (const path of [
    workPath,
    "arrs.json",
    config.riskPolicy,
    config.architecture.policy,
    "AGENTS.md",
  ])
    reference(path, "mandatory task or governing contract", workPath);
  for (const path of item.context)
    reference(path, "supplied authoritative context", workPath);
  const mapPaths = (source: string, directory: string): Map<string, string> => {
    const paths = new Map<string, string>();
    for (const path of walkFiles(source, directory)
      .filter((path) => path.endsWith(".json"))
      .sort()) {
      const map = readJson(source, path) as FeatureMap;
      paths.set(map.id, path);
    }
    return paths;
  };
  const discover = (source: string, sourceName: "candidate" | "baseline"): void => {
    const sourceConfig = readConfig(source);
    const scan = scanFeatures(source, sourceConfig);
    blockers.push(...scan.errors);
    const paths = mapPaths(source, sourceConfig.knowledge.features);
    const visited = new Set<string>();
    const visit = (id: string, chain: string[]): void => {
      if (chain.includes(id)) {
        blockers.push(`Feature dependency cycle: ${[...chain, id].join(" -> ")}`);
        return;
      }
      if (visited.has(id)) return;
      if (chain.length > preparationLimits.dependencyDepth) {
        blockers.push(
          `Feature dependency depth exceeds ${preparationLimits.dependencyDepth}: ${[...chain, id].join(" -> ")}`,
        );
        return;
      }
      if (visited.size >= preparationLimits.features) {
        blockers.push(
          `Feature dependency count exceeds ${preparationLimits.features}: ${id}`,
        );
        return;
      }
      visited.add(id);
      const map = scan.features.find((feature) => feature.id === id);
      if (!map) {
        blockers.push(
          `Unknown ${sourceName} feature ${id}; supply an existing valid Feature Map`,
        );
        return;
      }
      const path = paths.get(id)!;
      if (lstatSync(safePath(source, path)).size > preparationLimits.documentBytes)
        throw new Error(
          `Selected ${sourceName} Feature Map exceeds 64000 bytes: ${path}; narrow its contract`,
        );
      selected.push({
        id,
        selected: item.featureIds.includes(id),
        map,
        path,
        source: sourceName,
      });
      if (sourceName === "candidate") {
        reference(
          path,
          chain.length
            ? `dependency of ${chain.at(-1)}`
            : "explicitly selected Feature Map",
          workPath,
        );
        for (const entry of [...map.entryPoints, ...map.implementation])
          reference(entry, `feature ${id} entry point or implementation`, path);
        for (const entry of map.related)
          reference(entry, `feature ${id} linked decision/context`, path);
      }
      for (const dependency of ordered(map.dependencies))
        visit(dependency, [...chain, id]);
    };
    for (const id of ordered(item.featureIds)) visit(id, []);
  };
  discover(root, "candidate");
  if (baseline) discover(baseline.root, "baseline");
  selected.sort((a, b) => compare(a.id, b.id) || compare(a.source, b.source));
  const scope = ordered([
    ...item.context,
    ...selected.flatMap(({ map }) => [...map.entryPoints, ...map.implementation]),
  ]);
  const requestedRisk = selected.reduce(
    (risk, feature) => (feature.map.risk > risk ? feature.map.risk : risk),
    item.risk,
  );
  const requirements = policyRequirements(root, scope, requestedRisk, baseline);
  const targets = ordered([
    ...item.verificationTargets,
    ...selected.map(({ map }) => map.verification.target),
    ...requirements.verificationTargets,
  ]);
  const commands: PreparedTask["requirements"]["commands"] = [];
  const command = (name: CommandName, target?: string): void => {
    try {
      requirements.assertCommand(name, target);
      const binding = resolveCommand(config, name, target);
      commands.push({
        command: name,
        ...(target === undefined ? {} : { target }),
        argv: [...binding.argv],
        timeoutSeconds: binding.timeoutSeconds ?? 300,
      });
    } catch (error) {
      if (baseline) throw error;
      blockers.push(message(error));
    }
  };
  for (const name of [...requirements.requiredChecks].sort()) command(name);
  for (const target of targets) command("verify", target);
  if (item.dependencies.length)
    blockers.push("Unresolved work dependencies: " + item.dependencies.join("; "));
  if (item.decisions.length)
    blockers.push("Unresolved work decisions: " + item.decisions.join("; "));
  if (requirements.risk === "R4")
    blockers.push(
      "R4 requires human control; autonomous implementation is excluded in v0.1",
    );
  if (
    requirements.policy.humanApproval &&
    (item.authorization?.humanApproval ?? "").trim().length < 12
  )
    blockers.push(
      `${requirements.risk} requires actual human execution authorization; preparation cannot supply it`,
    );
  // Include instructions scoped to every selected source ancestor, without searching unrelated trees.
  for (const path of scope) {
    if (lstatSync(safePath(root, path), { throwIfNoEntry: false })?.isDirectory()) {
      try {
        for (const instruction of walkFiles(root, path, {
          maxFiles: preparationLimits.inventoryFiles,
          includeIgnored: true,
          excludedPaths: [".git", ".arrs", "node_modules"],
        }).filter((file) => posix.basename(file) === "AGENTS.md"))
          reference(instruction, `nested scoped instructions inside ${path}`, path);
      } catch (error) {
        blockers.push(message(error));
      }
    }
    let directory = lstatSync(safePath(root, path), {
      throwIfNoEntry: false,
    })?.isDirectory()
      ? posix.normalize(path)
      : posix.dirname(path);
    while (directory !== ".") {
      const instruction = `${directory}/AGENTS.md`;
      if (existsSync(safePath(root, instruction)))
        reference(instruction, `scoped instructions for ${path}`, path);
      directory = posix.dirname(directory);
    }
  }
  const documents: PreparedTask["documents"] = [];
  const queue = [...pathReasons.keys()]
    .filter((path) => /\.(md|txt)$/i.test(path))
    .sort()
    .map((path) => ({ path, depth: 0 }));
  const visitedDocuments = new Set<string>();
  let documentBytes = 0;
  while (queue.length) {
    const entry = queue.shift()!;
    if (visitedDocuments.has(entry.path)) continue;
    visitedDocuments.add(entry.path);
    try {
      const path = safePath(root, entry.path);
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      if (
        documents.length >= preparationLimits.documents ||
        documentBytes + stat.size > preparationLimits.documentBytes
      ) {
        omitted.push({
          path: entry.path,
          reason:
            "Optional document content exceeds document/byte navigation budget; inventory retains the reference",
        });
        blockers.push(
          "Document navigation budget exceeded; inspect omitted context and narrow the task",
        );
        continue;
      }
      const text = readFileSync(path, "utf8");
      documents.push({ path: entry.path, text });
      documentBytes += stat.size;
      const links = references(root, entry.path, text);
      blockers.push(...links.errors);
      for (const path of links.paths) {
        reference(path, `local reference from ${entry.path}`, entry.path);
        const index = `${path}/README.md`;
        if (
          lstatSync(safePath(root, path), { throwIfNoEntry: false })?.isDirectory() &&
          existsSync(safePath(root, index))
        ) {
          reference(index, `directory navigation index from ${entry.path}`, entry.path);
          if (entry.depth < preparationLimits.navigationDepth)
            queue.push({ path: index, depth: entry.depth + 1 });
        }
      }
      for (const path of ordered(links.documents)) {
        if (visitedDocuments.has(path)) continue;
        if (entry.depth < preparationLimits.navigationDepth)
          queue.push({ path, depth: entry.depth + 1 });
        else
          omitted.push({
            path,
            reason:
              "Linked document navigation depth limit; reference inventoried without following further links",
          });
      }
    } catch (error) {
      blockers.push(`${entry.path}: ${message(error)}`);
    }
  }
  let scenarios: PreparationScenarios | undefined;
  if (options.scenariosPath) {
    if (
      lstatSync(safePath(root, options.scenariosPath)).size >
      preparationLimits.documentBytes
    )
      throw new Error("Scenario input exceeds 64000 bytes; narrow the bounded scenarios");
    scenarios = readJson(root, options.scenariosPath) as PreparationScenarios;
    assertValid<PreparationScenarios>("prepare-scenarios", scenarios);
    reference(
      options.scenariosPath,
      "explicit supplied before/after scenario identities and exits",
      workPath,
    );
    if (!["bug", "refactor"].includes(item.category))
      throw new Error(
        "Before/after scenarios are only supported for bug/refactor preparation",
      );
    for (const scenario of scenarios.scenarios) {
      if (scenarios.scenarios.filter((entry) => entry.id === scenario.id).length > 1)
        blockers.push(
          `Duplicate supplied scenario identity ${scenario.id}; distinguish actual baseline scenarios`,
        );
      if (!item.acceptance.includes(scenario.criterion))
        blockers.push(
          `Scenario ${scenario.id} criterion is not an exact supplied acceptance criterion`,
        );
      command("verify", scenario.target);
      if (
        scenario.afterExitCode !== 0 ||
        (item.category === "bug"
          ? scenario.beforeExitCode === 0
          : scenario.beforeExitCode !== 0)
      )
        blockers.push(
          `Scenario ${scenario.id} expected exits do not satisfy the ${item.category} before/after contract`,
        );
    }
  }
  const inventory: PreparedTask["inventory"] = [];
  let inventoryBytes = 0;
  for (const [path, reason] of [...pathReasons].sort(([a], [b]) => compare(a, b))) {
    try {
      if (
        lstatSync(safePath(root, path)).isDirectory() &&
        ![...reason.reasons].some(
          (entry) =>
            entry.includes("entry point or implementation") ||
            entry.includes("supplied authoritative context"),
        )
      ) {
        omitted.push({
          path,
          reason:
            "Directory navigation reference retained without recursive content coverage; use the linked index or an explicit task scope",
        });
        continue;
      }
      const files = walkFiles(root, path, {
        includeIgnored: true,
        excludedPaths: [".git", ".arrs", "node_modules"],
        maxFiles: preparationLimits.inventoryFiles,
      }).sort();
      for (const file of files) {
        const present = inventory.find((entry) => entry.path === file);
        if (present) {
          present.reasons = ordered([...present.reasons, ...reason.reasons]);
          present.provenance = ordered([...present.provenance, ...reason.provenance]);
          continue;
        }
        const size = lstatSync(safePath(root, file)).size;
        if (
          inventory.length >= preparationLimits.inventoryFiles ||
          size > preparationLimits.fileBytes ||
          inventoryBytes + size > preparationLimits.inventoryBytes
        ) {
          omitted.push({
            path: file,
            reason: "Source inventory exceeds file/byte limit",
          });
          blockers.push(
            "Source inventory budget exceeded; narrow implementation/context scope",
          );
          continue;
        }
        const bytes = readFileSync(safePath(root, file));
        inventory.push({
          path: file,
          kind: "file",
          sha256: digest(bytes),
          bytes: size,
          reasons: ordered([...reason.reasons]),
          provenance: ordered([...reason.provenance]),
        });
        inventoryBytes += size;
      }
    } catch (error) {
      blockers.push(`${path}: ${message(error)}`);
    }
  }
  inventory.sort((a, b) => compare(a.path, b.path));
  documents.sort((a, b) => compare(a.path, b.path));
  const steps: ProofStep[] = [];
  for (const scenario of scenarios?.scenarios ?? [])
    steps.push({
      phase: "before",
      command: "verify",
      target: scenario.target,
      expectExitCode: scenario.beforeExitCode,
      criterion: scenario.criterion,
    });
  for (const name of [...requirements.requiredChecks].sort())
    steps.push({
      phase: name === "test" ? "test" : name === "check" ? "check" : "mechanical",
      command: name,
      expectExitCode: 0,
    });
  for (const target of targets)
    steps.push({
      phase:
        item.category === "docs"
          ? "mechanical"
          : ["bug", "refactor"].includes(item.category)
            ? "after"
            : "behavior",
      command: "verify",
      target,
      expectExitCode: 0,
    });
  for (const scenario of scenarios?.scenarios ?? [])
    steps.push({
      phase: "after",
      command: "verify",
      target: scenario.target,
      expectExitCode: scenario.afterExitCode,
      criterion: scenario.criterion,
    });
  for (const criterion of item.acceptance) {
    if (["bug", "refactor"].includes(item.category)) {
      const scenario = scenarios?.scenarios.find(
        (entry) => entry.criterion === criterion,
      );
      if (!scenario)
        blockers.push(
          `Missing explicit before/after scenario identity and expected exits for criterion: ${criterion}`,
        );
    } else if (targets[0])
      steps.push({
        phase: item.category === "docs" ? "mechanical" : "behavior",
        command: "verify",
        target: targets[0],
        expectExitCode: 0,
        criterion,
      });
  }
  const draft: WorkItem = {
    ...item,
    state:
      requirements.policy.autonomy === "human" ? "human-required" : "needs-information",
    risk: requirements.risk,
    context: scope,
    verificationTargets: targets,
    ...(baseline ? { policyBaseline: baseline } : {}),
  };
  delete draft.proof;
  delete draft.review;
  const plan: ProofPlan = {
    schemaVersion: "0.1",
    task: item.id,
    category: item.category,
    risk: requirements.risk,
    scope,
    acceptance: [...item.acceptance],
    steps,
    residualRisks: [
      "Draft configured target links require human assessment of product semantics; no commands or reviews have been performed.",
    ],
    deviations: [],
    ...(item.authorization ? { authorization: item.authorization } : {}),
    ...(baseline ? { policyBaseline: baseline } : {}),
  };
  const validationErrors = ordered([
    ...validateWorkItem(root, draft, baseline),
    ...validatePlan(root, plan, baseline),
  ]);
  blockers.push(...validationErrors);
  const allBlockers = ordered(blockers);
  const packet: PreparedTask = {
    schemaVersion: "0.1",
    kind: "prepared-task",
    id: "",
    status: allBlockers.length
      ? "blocked"
      : requirements.policy.autonomy === "human"
        ? "human-required"
        : "draft",
    objective: item.title,
    category: item.category,
    acceptance: [...item.acceptance],
    dependencies: [...item.dependencies],
    decisions: [...item.decisions],
    scenarios: scenarios?.scenarios ?? [],
    selectionRule:
      "Only explicitly selected features and their declared dependency closure, supplied context, governing contracts, scoped AGENTS.md ancestors and bounded local document references are selected. Unrelated maps/documents/source are outside coverage.",
    scope,
    features: selected,
    inventory,
    documents,
    omitted: omitted.sort(
      (a, b) => compare(a.path, b.path) || compare(a.reason, b.reason),
    ),
    blockers: allBlockers,
    requirements: {
      requestedRisk: item.risk,
      risk: requirements.risk,
      policyEvaluation: policyMode(baseline),
      ...(baseline
        ? { policyBaseline: baseline }
        : { limitation: candidatePolicyLimitation }),
      autonomy: requirements.policy.autonomy,
      authorizationRequired: requirements.policy.humanApproval,
      independentReviewRequired: requirements.policy.independentReview,
      humanAcceptanceRequired: requirements.policy.humanApproval,
      requiredChecks: [...requirements.requiredChecks].sort(),
      verificationTargets: targets,
      commands: commands.filter(
        (entry, index, all) =>
          all.findIndex(
            (other) => other.command === entry.command && other.target === entry.target,
          ) === index,
      ),
    },
    drafts: {
      work: draft,
      ...(!allBlockers.length ? { proof: plan } : {}),
      proofProposal: { steps, missingFields: allBlockers },
      validationErrors,
    },
    limits: preparationLimits,
    warnings: [
      "Preparation supplies no proof, command execution, work transition, execution approval or implementation acceptance.",
      "A technically valid draft does not establish that configured tests prove product semantics.",
      "Digests cover the listed inventory, not a complete Git changeset or authenticated repository state.",
    ],
  };
  packet.id = digest(JSON.stringify(packet));
  return packet;
}

/** Compare versioned packets produced from current repository facts. */
export function comparePreparedTask(
  previous: unknown,
  current: PreparedTask,
): { stale: boolean; previousId: string; currentId: string; changedPaths: string[] } {
  assertValid<PreparedTask>("prepared-task", previous);
  if (digest(JSON.stringify({ ...previous, id: "" })) !== previous.id)
    throw new Error(
      "Prepared packet identity does not match its content; regenerate from the repository",
    );
  const paths = ordered([
    ...previous.inventory.map((entry) => entry.path),
    ...current.inventory.map((entry) => entry.path),
  ]);
  return {
    stale: previous.id !== current.id,
    previousId: previous.id,
    currentId: current.id,
    changedPaths: paths.filter(
      (path) =>
        previous.inventory.find((entry) => entry.path === path)?.sha256 !==
        current.inventory.find((entry) => entry.path === path)?.sha256,
    ),
  };
}

export function renderPreparedTask(packet: PreparedTask): string {
  return [
    `# ${packet.objective}`,
    `Packet ${packet.id} (${packet.status}); ${packet.requirements.policyEvaluation}; risk ${packet.requirements.risk}.`,
    packet.selectionRule,
    "## Acceptance",
    ...packet.acceptance.map((criterion) => `- ${criterion}`),
    "## Required gates",
    `Autonomy: ${packet.requirements.autonomy}; execution authorization: ${packet.requirements.authorizationRequired}; independent implementation review: ${packet.requirements.independentReviewRequired}; human acceptance: ${packet.requirements.humanAcceptanceRequired}.`,
    packet.requirements.limitation ??
      `Selected baseline: ${JSON.stringify(packet.requirements.policyBaseline)}`,
    ...packet.requirements.commands.map(
      (entry) =>
        `- ${entry.command}${entry.target === undefined ? "" : ` ${entry.target}`}: ${JSON.stringify(entry.argv)}; timeout ${entry.timeoutSeconds}s`,
    ),
    "## Blockers",
    ...(packet.blockers.length
      ? packet.blockers.map((blocker) => `- ${blocker}`)
      : [
          "No missing technical draft inputs. Execution and implementation acceptance remain separate.",
        ]),
    "## Supplied baseline scenarios",
    ...packet.scenarios.map(
      (entry) =>
        `- ${entry.id}: verify ${entry.target}; criterion ${JSON.stringify(entry.criterion)}; before exit ${entry.beforeExitCode}, after exit ${entry.afterExitCode}`,
    ),
    "## Draft contracts",
    "```json\n" + JSON.stringify(packet.drafts, null, 2) + "\n```",
    "## Selected references",
    ...packet.inventory.map(
      (entry) =>
        `- ${entry.path} (${entry.sha256}): ${entry.reasons.join("; ")}; from ${entry.provenance.join(", ")}`,
    ),
    "## Omitted content",
    ...packet.omitted.map((entry) => `- ${entry.path}: ${entry.reason}`),
    "## Scoped context",
    ...packet.documents.flatMap((entry) => [`### ${entry.path}`, entry.text]),
    "## Limits",
    ...packet.warnings.map((warning) => `- ${warning}`),
    "",
  ].join("\n\n");
}
