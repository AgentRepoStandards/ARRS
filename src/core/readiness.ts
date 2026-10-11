import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { audit } from "./audit.js";
import { checkChangesetScope, type ScopeCheck } from "./changeset.js";
import { checkCI } from "./ci.js";
import { readConfig, scanFeatures } from "./config.js";
import { readJson, safePath, walkFiles } from "./files.js";
import {
  policyRequirements,
  requirePolicyBaseline,
  candidatePolicyLimitation,
} from "./policy-baseline.js";
import { prepareWorkItem, type PreparedTask } from "./prepare.js";
import {
  explainProof,
  readProofJson,
  containedProofLogs,
  type ProofExplanation,
} from "./proof-explanation.js";
import { assertValid, validate } from "./schema.js";
import { resolveCommand } from "./runner.js";
import { validateWorkItem, type WorkItem } from "./work.js";
import type {
  DiagnosticStatus,
  PolicyBaseline,
  Risk,
  AuditReport,
  ProofManifest,
  CommandName,
} from "./types.js";

export type ReadinessSubject =
  { kind: "feature"; id: string } | { kind: "work"; path: string };
export interface ReadinessSource {
  path: string;
  sha256?: string;
  recordedAt?: string;
}
export interface ReadinessDimension {
  id: string;
  status: DiagnosticStatus;
  reason: string;
  sources: ReadinessSource[];
  dependsOn: string[];
  remediation: string;
}
export interface ReadinessReport {
  schemaVersion: "0.1";
  kind: "readiness";
  identity: string;
  subject: ReadinessSubject;
  task?: string;
  dimensions: ReadinessDimension[];
  requirements?: PreparedTask["requirements"];
  preparation?: { id: string; scope: string[]; featureIds: string[]; blockers: string[] };
  scope?: ScopeCheck;
  selectedProof?: ProofExplanation;
  eligibility: {
    readyForAgent: boolean | null;
    humanControlledExecution: boolean | null;
    readyForReview: boolean | null;
    completed: boolean | null;
    autonomous: boolean | null;
  };
  admission: {
    readyForAgent: string[];
    inProgress: string[];
    readyForReview: string[];
    completed: string[];
  };
  nextActions: string[];
  repository: {
    contextualOnly: true;
    level: number | null;
    controls: AuditReport["controls"];
    warnings: string[];
    errors: string[];
    architecture?: AuditReport["architecture"];
  };
  limitations: string[];
}
const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const bounded = (values: string[]): string[] =>
  [...new Set(values)].slice(0, 40).map((value) => value.slice(0, 4000));
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
function preflightContracts(root: string): void {
  const boundedFile = (path: string): void => {
    const stat = lstatSync(safePath(root, path));
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error(`Readiness contract must be a regular file at most 1 MiB: ${path}`);
  };
  boundedFile("arrs.json");
  const config = readConfig(root);
  boundedFile(config.riskPolicy);
  boundedFile(config.architecture.policy);
  for (const path of walkFiles(root, config.knowledge.features, { maxFiles: 256 }).filter(
    (path) => path.endsWith(".json"),
  ))
    boundedFile(path);
}
function preflightAuditEvidence(root: string): void {
  const directory = readConfig(root).proof.evidenceDir;
  if (!existsSync(safePath(root, directory))) return;
  for (const path of walkFiles(root, directory, {
    includeIgnored: true,
    maxFiles: 2000,
  })) {
    if (/(?:\/proof\.json|\/review-[a-f0-9-]{36}\.json)$/.test(path)) {
      const value = readProofJson(root, path);
      if (path.endsWith("/proof.json") && !validate("proof", value).length)
        containedProofLogs(root, value as ProofManifest);
    }
  }
}

/** Scoped diagnostics compose existing admission; no execution, transitions or evidence writes. */
export async function assessReadiness(
  root: string,
  subject: ReadinessSubject,
  options: { baseline?: PolicyBaseline; base?: string } = {},
): Promise<ReadinessReport> {
  if (
    (subject.kind === "feature" ? subject.id.length : subject.path.length) >
    (subject.kind === "feature" ? 256 : 4096)
  )
    throw new Error("Readiness subject exceeds its bounded identifier/path limit");
  if (subject.kind === "feature" && options.base)
    throw new Error("An explicit Git base requires a concrete work item and scope");
  const report: ReadinessReport = {
    schemaVersion: "0.1",
    kind: "readiness",
    identity: "",
    subject,
    dimensions: [],
    eligibility: {
      readyForAgent: null,
      humanControlledExecution: null,
      readyForReview: null,
      completed: null,
      autonomous: null,
    },
    admission: { readyForAgent: [], inProgress: [], readyForReview: [], completed: [] },
    nextActions: [],
    repository: {
      contextualOnly: true,
      level: null,
      controls: [],
      warnings: [],
      errors: [],
    },
    limitations: [
      "Readiness performs no configured command execution, work transition, proof/review write, network request or remote issue mutation.",
      "Feature suitability remains unknown until a concrete task, acceptance and scope are selected.",
      "Architecture coverage is bounded to the selected adapter and declared source; unsupported language scope, external-runtime qualification and semantic test quality remain unknown unless separately established.",
      "Knowledge/context and static CI checks are bounded structural heuristics; maturity, passing tests and outcome counts grant no global model trust.",
      "Previously executed proof is revalidated for current recorded state; no check was executed by this readiness query.",
      "Required repository admission gates remain applicable; this scoped view cannot bypass them.",
    ],
  };
  const source = (path: string, recordedAt?: string): ReadinessSource => {
    const result: ReadinessSource = { path, ...(recordedAt ? { recordedAt } : {}) };
    try {
      const absolute = safePath(root, path);
      const stat = lstatSync(absolute);
      if (stat.isFile() && stat.size <= 1024 * 1024)
        result.sha256 = hash(readFileSync(absolute));
    } catch {
      /* missing references remain sourced without a fabricated digest */
    }
    return result;
  };
  const dimension = (
    id: string,
    status: DiagnosticStatus,
    reason: string,
    paths: string[],
    remediation: string,
    dependsOn: string[] = [],
    recordedAt?: string,
  ): void => {
    report.dimensions.push({
      id,
      status,
      reason: reason.slice(0, 4000),
      sources: [...new Set(paths)]
        .sort()
        .slice(0, 64)
        .map((path) => source(path, recordedAt)),
      remediation,
      dependsOn,
    });
  };
  let item: WorkItem | undefined;
  let packet: PreparedTask | undefined;
  let path = subject.kind === "work" ? subject.path : "arrs.json";
  let requiredRisk: Risk | undefined;
  try {
    preflightContracts(root);
    const config = readConfig(root);
    // Validate supplied protected context independently before projecting any claim.
    if (options.baseline) policyRequirements(root, ["."], "R0", options.baseline);
    const scan = scanFeatures(root, config);
    if (subject.kind === "work") {
      const stat = lstatSync(safePath(root, subject.path));
      if (!stat.isFile() || stat.size > 64000)
        throw new Error(
          "Readiness work input must be a regular file at most 64000 bytes",
        );
      const value = readJson(root, subject.path);
      assertValid<WorkItem>("work-item", value);
      item = value;
      requirePolicyBaseline(item.policyBaseline, options.baseline);
      report.task = item.id;
    } else {
      const map = scan.features.find((feature) => feature.id === subject.id);
      if (!map)
        throw new Error(
          `Unknown or invalid feature ${subject.id}; supply an existing mapped feature. ${scan.errors.join("; ")}`,
        );
      path = walkFiles(root, config.knowledge.features)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .find((file) => (readJson(root, file) as { id?: string }).id === subject.id)!;
      item = {
        schemaVersion: "0.1",
        id: `feature-context:${subject.id}`,
        title: map.goal,
        state: "needs-information",
        risk: map.risk,
        category: "feature",
        featureIds: [map.id],
        acceptance: [...map.acceptance],
        context: [...new Set([...map.entryPoints, ...map.implementation])],
        verificationTargets: [map.verification.target],
        dependencies: [],
        decisions: [],
      };
    }
    const contextErrors = bounded(
      item.context.flatMap((entry) => {
        try {
          if (!lstatSync(safePath(root, entry), { throwIfNoEntry: false }))
            return [`Missing context ${entry}`];
          return [];
        } catch (error) {
          return [message(error)];
        }
      }),
    );
    dimension(
      "context",
      contextErrors.length ? "incomplete" : "passed",
      contextErrors.length
        ? contextErrors.join("; ")
        : "Supplied source context exists; selected maps and scoped instructions are discoverable, without semantic knowledge certification",
      [path, "AGENTS.md", ...item.context],
      "Repair missing references and inspect selected map invariants and scoped instructions",
    );
    try {
      packet = prepareWorkItem(
        root,
        { ...item, state: "needs-information" },
        path,
        options.baseline ? { baseline: options.baseline } : {},
      );
      report.requirements = packet.requirements;
      report.preparation = {
        id: packet.id,
        scope: packet.scope,
        featureIds: packet.features.map((entry) => entry.id),
        blockers: bounded(packet.blockers),
      };
      dimension(
        "preparation",
        packet.blockers.length ? "incomplete" : "passed",
        packet.blockers.length
          ? packet.blockers.join("; ")
          : "Bounded scoped packet and technically valid draft inputs are reproducible; no execution readiness or semantic test adequacy is inferred",
        [path, ...packet.features.map((feature) => feature.path)],
        "Resolve missing draft/knowledge inputs while preserving the separate shared admission and evidence gates",
        ["context"],
      );
      requiredRisk = packet.requirements.risk;
      const selectionErrors = packet.blockers.filter((error) =>
        /Unknown .*feature|Feature dependency|Referenced path|Symlink|Missing context|budget exceeded|broken repository reference|invalid repository reference/.test(
          error,
        ),
      );
      dimension(
        "feature-contracts",
        selectionErrors.length ? "blocked" : "passed",
        selectionErrors.length
          ? selectionErrors.join("; ")
          : "Explicit selected features and their bounded declared dependency closure supply invariants and provenance",
        packet.features.map((feature) => feature.path),
        "Repair selected maps, their dependencies and owned boundaries before delegation",
        ["context"],
      );
      const configurationErrors = packet.blockers.filter((error) =>
        /command|verification target|binding|configured|Proof plan lacks required/i.test(
          error,
        ),
      );
      dimension(
        "verification-configuration",
        configurationErrors.length ? "blocked" : "passed",
        configurationErrors.length
          ? configurationErrors.join("; ")
          : "Required checks and owned verification targets have exact literal argv and timeout bindings; no commands were executed",
        ["arrs.json", ...packet.features.map((feature) => feature.path)],
        "Configure every required owned target and preserve protected argv/timeouts",
        ["feature-contracts"],
      );
    } catch (error) {
      dimension(
        "feature-contracts",
        "blocked",
        message(error),
        [path, config.knowledge.features, config.riskPolicy],
        "Repair the sourced contract or restore independently selected protected controls",
        ["context"],
      );
      dimension(
        "verification-configuration",
        "blocked",
        "Authoritative requirements unavailable while contract or trust validation is blocked",
        ["arrs.json"],
        "Resolve feature-contracts before interpreting command eligibility",
        ["feature-contracts"],
      );
    }
    const scopePaths = packet?.scope ?? item.context;
    const scopeCheck = checkChangesetScope(
      root,
      { scope: scopePaths, risk: requiredRisk ?? item.risk },
      options.base,
    );
    report.scope = scopeCheck;
    if (scopeCheck.effectiveRisk > (requiredRisk ?? item.risk))
      requiredRisk = scopeCheck.effectiveRisk;
    const scopeVerificationErrors: string[] = [];
    if (report.requirements && requiredRisk) {
      const raised = policyRequirements(
        root,
        scopeCheck.inventory.assurance === "git-complete"
          ? scopeCheck.inventory.endpoints
              .filter((entry) => !entry.excluded)
              .map((entry) => entry.path)
          : scopePaths,
        requiredRisk,
        options.baseline,
      );
      const targets = [
        ...new Set([
          ...report.requirements.verificationTargets,
          ...scopeCheck.verificationTargets,
          ...raised.verificationTargets,
        ]),
      ].sort();
      const commandEntries: Array<{ command: CommandName; target?: string }> = [
        ...raised.requiredChecks.sort().map((command) => ({ command })),
        ...targets.map((target) => ({ command: "verify" as const, target })),
      ];
      const commands = commandEntries.flatMap((entry) => {
        try {
          raised.assertCommand(entry.command, entry.target);
          const binding = resolveCommand(raised.config, entry.command, entry.target);
          return [
            {
              ...entry,
              argv: binding.argv,
              timeoutSeconds: binding.timeoutSeconds ?? 300,
            },
          ];
        } catch (error) {
          scopeVerificationErrors.push(message(error));
          return [];
        }
      });
      report.requirements = {
        ...report.requirements,
        risk: raised.risk,
        autonomy: raised.policy.autonomy,
        authorizationRequired: raised.policy.humanApproval,
        independentReviewRequired: raised.policy.independentReview,
        humanAcceptanceRequired: raised.policy.humanApproval,
        requiredChecks: raised.requiredChecks,
        verificationTargets: targets,
        commands,
      };
      if (subject.kind === "work")
        for (const target of targets)
          if (!item.verificationTargets.includes(target))
            scopeVerificationErrors.push(
              `Work omits current/comparison-base scope verification target ${target}`,
            );
    }
    dimension(
      "scope-verification",
      scopeVerificationErrors.length ? "blocked" : "passed",
      scopeVerificationErrors.length
        ? scopeVerificationErrors.join("; ")
        : "Current and comparison-base mapped targets remain required at every risk, with exact current/protected command bindings",
      [path, "arrs.json", ...scopePaths],
      "Retain every discovered historical/current target on the item and configure its exact binding before execution or review",
      ["scope", "verification-configuration"],
    );
    dimension(
      "scope",
      scopeCheck.passed
        ? "passed"
        : scopeCheck.inventory.status === "unsupported"
          ? "unsupported"
          : "blocked",
      scopeCheck.inventory.assurance === "git-complete"
        ? `Explicit base ${scopeCheck.inventory.base}, HEAD ${scopeCheck.inventory.head}, index and working identities are pinned; ${scopeCheck.uncovered.length} uncovered changed paths. ${scopeCheck.diagnostics.join("; ")}`
        : `${scopeCheck.inventory.assurance}: ${scopeCheck.diagnostics.join("; ") || "Existing declared source only; complete Git changes, deletions and renames remain unknown"}`,
      [path, ...scopePaths],
      "Supply an explicit --base and expand intended scope to cover discovered changed endpoints; do not infer completeness from context",
      ["context"],
    );
    const gates = report.requirements;
    dimension(
      "risk",
      !gates
        ? "blocked"
        : requiredRisk! > item.risk && subject.kind === "work"
          ? "blocked"
          : "passed",
      gates
        ? `Requested ${item.risk}; effective ${requiredRisk}; ${gates.autonomy} autonomy; independent implementation review ${gates.independentReviewRequired}; human acceptance ${gates.humanAcceptanceRequired}`
        : "Authoritative risk requirements unavailable",
      [
        path,
        config.riskPolicy,
        ...(packet?.features.map((feature) => feature.path) ?? []),
      ],
      "Reclassify understated work risk, preserve sensitive-path floors, and retain required human control",
      ["scope", "feature-contracts"],
    );
    const authorization =
      (item.authorization?.humanApproval ?? item.review?.humanApproval ?? "").trim()
        .length >= 12;
    dimension(
      "execution-authorization",
      subject.kind === "feature"
        ? "not-evaluated"
        : !gates
          ? "blocked"
          : gates.authorizationRequired && !authorization
            ? "blocked"
            : "passed",
      subject.kind === "feature"
        ? "No concrete task authorization selected"
        : gates?.authorizationRequired
          ? authorization
            ? "Existing local execution authorization is present; identity/authenticity is not established by its text"
            : "Actual human execution authorization is missing"
          : "Current scoped policy requires no human execution authorization",
      [path, config.riskPolicy],
      "Record actual required execution permission separately from implementation acceptance",
      ["risk"],
    );
    const unresolved = [
      ...item.dependencies.map((value) => `Dependency: ${value}`),
      ...item.decisions.map((value) => `Decision: ${value}`),
    ];
    dimension(
      "dependencies-decisions",
      unresolved.length ? "blocked" : "passed",
      unresolved.length
        ? unresolved.join("; ")
        : "Supplied dependencies and decisions are resolved; missing product knowledge is not inferred away",
      [path],
      "Resolve each supplied dependency and decision with real repository/task context",
    );
    if (subject.kind === "work") {
      let proofPreflightErrors: string[] = [];
      const scopedEvidenceErrors: string[] = [];
      if (item.proof) {
        // Enforce explanation's bounded/canonical preflight before work projections read evidence.
        try {
          readProofJson(root, item.proof);
          report.selectedProof = explainProof(root, item.proof, options.baseline);
          if (report.selectedProof.technical.valid)
            for (const target of report.requirements?.verificationTargets ?? []) {
              const expected = report.requirements?.commands.find(
                (entry) => entry.command === "verify" && entry.target === target,
              );
              if (
                !expected ||
                !report.selectedProof.steps.some(
                  (step) =>
                    step.argvBound &&
                    step.result?.command === "verify" &&
                    step.result.target === target &&
                    step.result.phase !== "before" &&
                    step.result.exitCode === 0 &&
                    step.result.expectExitCode === 0 &&
                    JSON.stringify(step.result.argv) === JSON.stringify(expected.argv),
                )
              )
                scopedEvidenceErrors.push(
                  `Selected proof lacks passing exact bound current/comparison-base scope target ${target}`,
                );
            }
        } catch (error) {
          proofPreflightErrors = [message(error)];
        }
      }
      const projection = (state: WorkItem["state"]): string[] => {
        if (
          ["ready-for-review", "completed"].includes(state) &&
          proofPreflightErrors.length
        )
          return proofPreflightErrors;
        if (
          state === "completed" &&
          report.selectedProof?.review.errors.some((error) =>
            /Observer limit|read limit|reporting bounds/i.test(error),
          )
        )
          return bounded(report.selectedProof.review.errors);
        if (
          ["ready-for-review", "completed"].includes(state) &&
          report.selectedProof &&
          !report.selectedProof.technical.valid
        )
          return bounded(report.selectedProof.technical.errors);
        return bounded(validateWorkItem(root, { ...item!, state }, options.baseline));
      };
      report.admission = {
        readyForAgent: projection("ready-for-agent"),
        inProgress: projection("in-progress"),
        readyForReview: projection("ready-for-review"),
        completed: projection("completed"),
      };
      const structural = report.dimensions.some(
        (entry) =>
          [
            "context",
            "feature-contracts",
            "verification-configuration",
            "scope-verification",
            "risk",
            "scope",
            "dependencies-decisions",
          ].includes(entry.id) && entry.status !== "passed",
      );
      report.eligibility.readyForAgent =
        !structural &&
        report.admission.readyForAgent.length === 0 &&
        gates?.autonomy !== "human" &&
        requiredRisk! < "R3";
      report.eligibility.humanControlledExecution =
        !structural &&
        gates?.autonomy === "human" &&
        requiredRisk !== "R4" &&
        report.admission.inProgress.length === 0;
      report.eligibility.autonomous =
        report.eligibility.readyForAgent &&
        gates?.autonomy !== "human" &&
        (requiredRisk ?? item.risk) < "R3";
      report.eligibility.readyForReview =
        !structural &&
        !scopedEvidenceErrors.length &&
        report.admission.readyForReview.length === 0;
      report.eligibility.completed =
        !structural &&
        !scopedEvidenceErrors.length &&
        report.admission.completed.length === 0;
      dimension(
        "technical-evidence",
        report.eligibility.readyForReview
          ? "passed"
          : item.proof
            ? "blocked"
            : "incomplete",
        report.eligibility.readyForReview
          ? "Exact selected canonical proof is current and matches work task/category/risk, exact criteria and required targets; evidence was previously executed"
          : [...report.admission.readyForReview, ...scopedEvidenceErrors].join("; ") ||
              "No task-matched proof selected",
        item.proof ? [item.proof] : [path],
        "Capture current task-matched evidence for every exact criterion and required target, then select that canonical attempt",
        ["scope", "risk", "verification-configuration"],
        report.selectedProof?.createdAt,
      );
      dimension(
        "implementation-acceptance",
        report.eligibility.completed
          ? "passed"
          : report.eligibility.readyForReview
            ? "incomplete"
            : "blocked",
        report.eligibility.completed
          ? "The exact selected attempt satisfies current shared accepted validation and work matching"
          : report.admission.completed.join("; ") ||
              "Technical readiness must precede completed implementation review",
        item.proof
          ? [
              item.proof,
              ...(report.selectedProof?.review.attachments.map((entry) => entry.path) ??
                []),
            ]
          : [path],
        "Obtain actual independent implementation review and required human acceptance bound to this selected immutable attempt",
        ["technical-evidence"],
        report.selectedProof?.createdAt,
      );
      if (
        !report.eligibility.readyForAgent &&
        report.admission.readyForAgent.length === 0
      )
        dimension(
          "validator-consistency",
          "blocked",
          "Shared work validator permits the projected state, but explicit sourced scope, contract or human-autonomy requirements prevent agent advice; readiness does not relax those requirements",
          [path, "arrs.json"],
          "Resolve scope/risk context before relying on executable-state advice",
          ["scope", "risk"],
        );
    } else {
      dimension(
        "technical-evidence",
        "not-evaluated",
        "No concrete task, category, exact criteria or selected proof exists; unrelated repository proof cannot establish feature suitability",
        [path],
        "Select a concrete work item and its exact canonical proof",
        ["scope", "verification-configuration"],
      );
      dimension(
        "implementation-acceptance",
        "not-evaluated",
        "Implementation acceptance is unknown for an unspecified task",
        [path],
        "Inspect concrete task-matched evidence and actual bound review",
        ["technical-evidence"],
      );
    }
    const ciErrors = checkCI(root, config);
    dimension(
      "static-ci",
      ciErrors.length
        ? ciErrors.some((value) => /unsupported/i.test(value))
          ? "unsupported"
          : "incomplete"
        : "passed",
      ciErrors.length
        ? ciErrors.join("; ")
        : "Supported workflow syntax contains required static gate invocations; this is not observed hosted execution or protected admission",
      [config.ci.workflow, "arrs.json"],
      "Repair supported workflow syntax and preserve required gates; inspect hosted run evidence separately",
    );
    dimension(
      "hosted-ci",
      "not-evaluated",
      "Hosted CI execution and enablement are unobserved; static syntax proves neither a hosted run nor enabled or required status",
      [config.ci.workflow],
      "Use separately authorized real hosted execution evidence if repository admission requires it; no hosted run is invented",
      ["static-ci"],
    );
  } catch (error) {
    dimension(
      "assessment",
      "blocked",
      message(error),
      [path, "arrs.json"],
      "Repair the explicit input/reference or restore independently selected protected context before retrying",
    );
    if (subject.kind === "work")
      report.eligibility = {
        readyForAgent: false,
        humanControlledExecution: false,
        readyForReview: false,
        completed: false,
        autonomous: false,
      };
  }
  try {
    preflightContracts(root);
    preflightAuditEvidence(root);
    const contextual = await audit(root, {
      execute: false,
      ...(options.baseline ? { baseline: options.baseline } : {}),
    });
    report.repository = {
      contextualOnly: true,
      level: contextual.level,
      controls: contextual.controls,
      warnings: bounded(contextual.warnings),
      errors: [],
    };
    const architecture = contextual.architecture;
    if (architecture !== undefined) report.repository.architecture = architecture;
    const architectureControl = contextual.controls.find(
      (entry) => entry.id === "architecture",
    );
    if (architectureControl)
      dimension(
        "architecture-coverage",
        architectureControl.status,
        `${architectureControl.detail}. Read-only inspection never invokes an external adapter runtime; unobserved qualification remains explicit.`,
        [readConfig(root).architecture.policy],
        "Inspect the selected adapter's bounded coverage and qualification; use separately authorized executed admission for external runtime checks",
      );
  } catch (error) {
    report.repository.errors.push(
      `Contextual audit unavailable within readiness reader bounds: ${message(error)}`.slice(
        0,
        4000,
      ),
    );
  }
  if (subject.kind === "feature")
    report.nextActions.push(
      "Choose a concrete work item with authoritative acceptance, intended source scope and selected proof before assessing task eligibility",
    );
  for (const entry of report.dimensions.filter((entry) => entry.status !== "passed"))
    report.nextActions.push(`${entry.id}: ${entry.remediation}`);
  if (report.eligibility.autonomous)
    report.nextActions.push(
      "Shared work admission permits ready-for-agent; execute only the bounded task after satisfying required repository gates",
    );
  if (report.eligibility.humanControlledExecution)
    report.nextActions.push(
      "R3 human-controlled execution is permitted by the shared in-progress projection; retain human control and required review",
    );
  if (report.eligibility.readyForReview && !report.eligibility.completed)
    report.nextActions.push(
      "Selected technical proof supports review; completed implementation acceptance remains pending",
    );
  if (report.eligibility.completed)
    report.nextActions.push(
      "Shared accepted work validation permits completion advice for this exact selected attempt; readiness performs no transition",
    );
  if (requiredRisk === "R4")
    report.nextActions.push(
      "R4 remains human-required; autonomous agent implementation is excluded in v0.1",
    );
  if (!options.baseline) report.limitations.push(candidatePolicyLimitation);
  report.nextActions = bounded(report.nextActions);
  report.identity = hash(JSON.stringify(report));
  return report;
}

export function renderReadiness(report: ReadinessReport): string {
  const clean = (text: string): string =>
    text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\uFFFD");
  return clean(
    [
      `Readiness ${report.subject.kind} ${report.subject.kind === "feature" ? report.subject.id : report.subject.path}`,
      `Agent execution: ${report.eligibility.readyForAgent ?? "unknown"}; human-controlled execution: ${report.eligibility.humanControlledExecution ?? "unknown"}; review: ${report.eligibility.readyForReview ?? "unknown"}; completed acceptance: ${report.eligibility.completed ?? "unknown"}.`,
      ...report.dimensions.map(
        (entry) =>
          `${entry.status.toUpperCase()} ${entry.id}: ${entry.reason}\n  Source: ${entry.sources.map((source) => source.path).join(", ")}\n  Next: ${entry.remediation}`,
      ),
      `Repository audit (context only): level ${report.repository.level ?? "unavailable"}; required admission gates remain applicable.`,
      ...report.nextActions,
      ...report.limitations,
    ].join("\n"),
  );
}
