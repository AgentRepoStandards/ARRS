import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { hashScope, safePath, walkFiles } from "../core/files.js";
import {
  effectiveRisk,
  readConfig,
  scanFeatures,
  repositoryPathsOverlap,
} from "../core/config.js";
import { maintenanceComments, maintenanceExcerpt } from "../core/maintenance.js";
import { requireLocalWorkProvider, workLocation } from "../core/work-provider.js";
import { validate } from "../core/schema.js";
import { policyRequirements } from "../core/policy-baseline.js";
import type { ProofPlan, Risk, FeatureMap } from "../core/types.js";
import type { WorkItem } from "../core/work.js";
import { checkArchitecture } from "../core/architecture.js";
import { checkSecurity } from "../core/security.js";
import { doctor } from "../core/doctor.js";
import { readOutcomeRecords, outcomeIdentity } from "../core/outcomes.js";
import { readLegacyMetrics } from "./metrics.js";
export interface Candidate {
  id: string;
  ruleId: string;
  observation: string;
  evidence: string[];
  recommendedEnforcement: string;
  proposedChange: string;
  priority: "low" | "medium" | "high";
  locations: Array<{ path: string; line: number; column: number; sha256: string }>;
  provenance: Array<{
    path: string;
    sha256: string;
    kind: "source" | "configuration" | "observation";
  }>;
  proposedScope: string[];
  featureIds: string[];
  suggestedRisk: Risk;
  verificationTargets: string[];
  uncertainty: string[];
  recurrence?: {
    distinctTasks: number;
    uniqueEvents: number;
    start: string;
    end: string;
    cohortSha256: string;
    supportingEventIds: string[];
    supportingEventsTruncated: boolean;
    controlIdentity: "known" | "unknown";
  };
}
export async function garden(
  root: string,
): Promise<{ schemaVersion: "0.1"; candidates: Candidate[]; warnings: string[] }> {
  const candidates: Candidate[] = [],
    warnings: string[] = [];
  const config = readConfig(root);
  const maps = scanFeatures(root, config);
  warnings.push(...maps.errors);
  const fingerprintPaths = [
    "arrs.json",
    config.riskPolicy,
    config.architecture.policy,
    config.knowledge.features,
  ];
  const configuration: Candidate["provenance"] = fingerprintPaths.map((path) => ({
    path,
    sha256: hashScope(root, path),
    kind: "configuration",
  }));
  const add = (
    observation: string,
    evidence: string[],
    recommendedEnforcement: string,
    proposedChange: string,
    priority: Candidate["priority"] = "medium",
    proposedScope: string[] = [],
    ruleId = observation
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-$/, ""),
    locations: Candidate["locations"] = [],
    extra: Candidate["provenance"] = [],
    recurrence?: Candidate["recurrence"],
  ): void => {
    if (evidence.length) {
      const scope = [...new Set(proposedScope)].sort();
      const features = maps.features.filter((map) =>
        [...map.implementation, ...map.entryPoints].some((path) =>
          scope.some((item) => repositoryPathsOverlap(root, path, item)),
        ),
      );
      const provenance: Candidate["provenance"] = [
        ...configuration,
        ...scope.map((path) => ({
          path,
          sha256: hashScope(root, path),
          kind: "source" as const,
        })),
        ...extra,
      ];
      const safeEvidence = evidence.map(maintenanceExcerpt);
      const id = createHash("sha256")
        .update(
          JSON.stringify({
            ruleId,
            evidence: safeEvidence,
            scope,
            locations,
            provenance,
          }),
        )
        .digest("hex");
      candidates.push({
        id,
        ruleId,
        observation,
        evidence: safeEvidence,
        recommendedEnforcement,
        proposedChange,
        priority,
        locations,
        provenance,
        proposedScope: scope,
        featureIds: features.map((map) => map.id).sort(),
        suggestedRisk: scope.length ? effectiveRisk(root, scope, "R1") : "R2",
        verificationTargets: [
          ...new Set(features.map((map) => map.verification.target)),
        ].sort(),
        uncertainty: [
          "Responsibility and root cause are suggestions requiring investigation.",
          ...(!scope.length
            ? ["Bounded source scope is unresolved; draft creation is blocked."]
            : []),
          ...(!features.length
            ? ["Feature ownership is unresolved; draft creation is blocked."]
            : []),
        ],
        ...(recurrence ? { recurrence } : {}),
      });
    }
  };
  try {
    add(
      "Architectural drift",
      checkArchitecture(root, { allowExternalRuntime: false }),
      "Keep the architecture gate in check and CI.",
      "Repair offending dependency direction or review a policy change independently.",
      "high",
    );
  } catch (error) {
    warnings.push(String(error));
  }
  try {
    add(
      "Security/control exceptions need attention",
      checkSecurity(root),
      "Require expiring justified exceptions and reject credentials.",
      "Remove the shortcut or implement the approved control.",
      "high",
    );
  } catch (error) {
    warnings.push(String(error));
  }
  const health = await doctor(root);
  add(
    "Mapping or verification gaps",
    health.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.id}: ${check.detail}; ${check.remediation}`),
    "Validate Feature Maps and workflow configuration in CI.",
    "Fix one failed control with its documented remediation.",
  );
  const files = walkFiles(root).filter(
    (file) => !file.startsWith("upstream/") && !file.startsWith("skills/"),
  );
  const duplicateGroups = new Map<string, string[]>();
  for (const file of files) {
    if (
      (file.startsWith("src/") || file.startsWith("tests/")) &&
      /\.(?:py|go|rs|rb|java|cs|php|vue|svelte)$/.test(file)
    ) {
      warnings.push(
        `Unsupported maintenance syntax: ${file}; no all-clear coverage is established`,
      );
      continue;
    }
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|md)$/.test(file)) continue;
    if (statSync(safePath(root, file)).size > 1_000_000) {
      warnings.push(
        `Maintenance source exceeds 1 MB: ${file}; narrow or split the source, coverage is incomplete`,
      );
      continue;
    }
    const text = readFileSync(safePath(root, file), "utf8"),
      lines = text.split("\n");
    if (file.endsWith("AGENTS.md") && lines.length > 80)
      add(
        "Instruction bloat",
        [`${file}: ${lines.length} lines`],
        "Set a concise root-map budget and check it.",
        "Move task-specific reference behind contextual links.",
        "low",
      );
    if (file.startsWith("src/") || file.startsWith("tests/")) {
      const parsed = maintenanceComments(file, text);
      warnings.push(...parsed.warnings);
      for (const comment of parsed.comments) {
        const deferred = comment.rule === "deferred-work";
        add(
          deferred ? "Deferred work accumulated" : "Suppression growth",
          [`${file}:${comment.line}: ${maintenanceExcerpt(comment.text)}`],
          deferred
            ? "Link the comment to independently executable work and verify the bounded behavior."
            : "Require approved expiring exceptions for each suppression.",
          deferred
            ? "Resolve or triage this specific comment."
            : "Replace the suppression with a type/interface correction.",
          deferred ? "low" : "medium",
          [file],
          comment.rule,
          [
            {
              path: file,
              line: comment.line,
              column: comment.column,
              sha256: createHash("sha256").update(comment.text).digest("hex"),
            },
          ],
        );
      }
      if (file.startsWith("src/") && lines.length > 15) {
        const normalized = text
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const hash = createHash("sha256").update(normalized).digest("hex");
        duplicateGroups.set(hash, [...(duplicateGroups.get(hash) ?? []), file]);
      }
    }
  }
  for (const group of duplicateGroups.values())
    if (group.length > 1)
      add(
        "Exact duplicate source candidates",
        group,
        "Choose one public interface and protect shared behavior with tests.",
        "Inspect duplication; consolidate only if the responsibilities are identical.",
        "low",
        group,
      );
  const legacyPath = ".arrs/metrics/events.jsonl";
  const records = readOutcomeRecords(root);
  const superseded = new Set(records.flatMap((record) => record.supersedes ?? []));
  const groups = new Map<
    string,
    {
      category: string;
      knownControls: boolean;
      events: Map<
        string,
        { task: string; recordedAt: string; provenance: Candidate["provenance"][number] }
      >;
    }
  >();
  const occurrence = (
    category: string,
    cohort: unknown,
    knownControls: boolean,
    id: string,
    task: string,
    recordedAt: string,
    provenance: Candidate["provenance"][number],
  ): void => {
    const key = outcomeIdentity([category, cohort]);
    const group = groups.get(key) ?? { category, knownControls, events: new Map() };
    group.events.set(id, { task, recordedAt, provenance });
    groups.set(key, group);
  };
  for (const record of records) {
    if (superseded.has(record.id)) continue;
    const cohort = [
      record.workflow.id,
      record.workflow.model ?? null,
      record.risk,
      record.category,
      record.controls.sha256,
      record.controls.arrsVersion,
      record.featureIds.slice().sort(),
      record.window
        ? Date.parse(record.window.end) - Date.parse(record.window.start)
        : "lifecycle",
    ];
    const path = `.arrs/metrics/outcomes/${record.id}.json`;
    for (const category of record.failureCategories)
      occurrence(category, cohort, true, record.id, record.task, record.recordedAt, {
        path,
        sha256: hashScope(root, path),
        kind: "observation",
      });
  }
  const legacy = readLegacyMetrics(root);
  if (legacy.length) {
    const provenance = {
      path: legacyPath,
      sha256: hashScope(root, legacyPath),
      kind: "observation" as const,
    };
    for (const event of legacy)
      for (const category of event.failureCategories)
        occurrence(
          category,
          [
            event.workflow.id,
            event.workflow.model ?? null,
            event.risk,
            event.category,
            "legacy-controls-unknown",
            "legacy-window-unknown",
          ],
          false,
          event.id,
          event.task,
          event.recordedAt,
          provenance,
        );
    warnings.push(
      "Legacy recurrence has no retained control/window identity; its distinct-task groups remain separate from known lifecycle cohorts and do not establish a shared root cause.",
    );
  }
  for (const [cohortSha256, group] of groups) {
    const tasks = new Set([...group.events.values()].map((event) => event.task));
    if (tasks.size < 2) continue;
    const times = [...group.events.values()]
      .map((event) => event.recordedAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b));
    const supporting = [...group.events.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 1000);
    const extra = [
      ...new Map(
        supporting.map(([, event]) => [event.provenance.path, event.provenance]),
      ).values(),
    ];
    add(
      `Recurring failure: ${maintenanceExcerpt(group.category)}`,
      [
        `${tasks.size} distinct tasks; ${group.events.size} unique events; ${times[0]} through ${times.at(-1)}`,
        `Cohort ${cohortSha256}; control identity ${group.knownControls ? "known" : "unknown"}`,
      ],
      "Investigate the supporting events and add a bounded regression when root cause is established.",
      "Resolve source ownership before proposing a change.",
      "medium",
      [],
      "recurrence",
      [],
      extra,
      {
        distinctTasks: tasks.size,
        uniqueEvents: group.events.size,
        start: times[0]!,
        end: times.at(-1)!,
        cohortSha256,
        supportingEventIds: supporting.map(([id]) => id),
        supportingEventsTruncated: supporting.length < group.events.size,
        controlIdentity: group.knownControls ? "known" : "unknown",
      },
    );
  }
  warnings.push(
    "Static observations are candidates, not proof of dead code or flaky tests. No rewrites are performed.",
  );
  return {
    schemaVersion: "0.1",
    candidates: candidates.sort((a, b) => a.id.localeCompare(b.id)),
    warnings: [...new Set(warnings.map(maintenanceExcerpt))],
  };
}

/** Creation selects one current finding; reports and drafts never grant execution permission. */
export async function proposeGarden(
  root: string,
  candidateId: string,
  output: string,
): Promise<{
  created: boolean;
  path: string;
  proposal: string;
  proofPlan: string;
  candidate: Candidate;
}> {
  if (!/^[a-f0-9]{64}$/.test(candidateId))
    throw new Error("Expected a current Gardener candidate SHA-256 identity");
  requireLocalWorkProvider(root);
  const config = readConfig(root);
  const candidate = (await garden(root)).candidates.find(
    (item) => item.id === candidateId,
  );
  if (!candidate)
    throw new Error("Stale or unknown Gardener candidate; rerun the read-only report");
  if (
    !candidate.proposedScope.length ||
    !candidate.featureIds.length ||
    !candidate.verificationTargets.length
  )
    throw new Error(
      "Candidate has unresolved scope/ownership/verification; resolve those decisions before creating a draft",
    );
  const location = safePath(root, workLocation(config).path);
  const absolute = safePath(root, output);
  if (!absolute.startsWith(location + sep) || !output.endsWith(".json"))
    throw new Error(
      "Gardener drafts must be JSON strictly below the configured local work location",
    );
  const requirements = policyRequirements(
    root,
    candidate.proposedScope,
    candidate.suggestedRisk,
  );
  const mapIds = candidate.featureIds;
  const maps: FeatureMap[] = requirements.features.filter((map) =>
    mapIds.includes(map.id),
  );
  const targets = [
    ...new Set([...candidate.verificationTargets, ...requirements.verificationTargets]),
  ].sort();
  const criterion = `Resolve ${candidate.ruleId} at the selected bounded scope and retain a regression rejecting the original failure.`;
  const proposalPath = `.agent/plans/gardener-${candidate.id}.proposal.json`;
  const proofPath = `.agent/plans/gardener-${candidate.id}.proof-plan.json`;
  const draft: WorkItem = {
    schemaVersion: "0.1",
    id: `garden-${candidate.id}`,
    title: candidate.observation,
    state: "needs-triage",
    risk: requirements.risk,
    category: "bug",
    featureIds: mapIds,
    acceptance: [criterion],
    context: [
      ...new Set([
        ...candidate.proposedScope,
        ...maps.flatMap((map) => map.related),
        proposalPath,
      ]),
    ].sort(),
    verificationTargets: targets,
    dependencies: [],
    decisions: [
      "Confirm bounded responsibility, reproduction and actual execution authorization before promoting this draft.",
    ],
  };
  const proof: ProofPlan = {
    schemaVersion: "0.1",
    task: draft.id,
    category: "bug",
    risk: requirements.risk,
    scope: candidate.proposedScope,
    acceptance: [criterion],
    steps: [
      ...requirements.requiredChecks.map((command) => ({
        phase: command === "test" ? ("test" as const) : ("check" as const),
        command,
        expectExitCode: 0,
      })),
      ...targets.map((target) => ({
        phase: "behavior" as const,
        command: "verify" as const,
        target,
        expectExitCode: 0,
        criterion,
      })),
    ],
    residualRisks: candidate.uncertainty,
    deviations: [
      "Draft only: supply an actual failing before scenario and identical passing after scenario before proof start; no execution authorization or completed approval is supplied.",
    ],
  };
  const proposal = {
    schemaVersion: "0.1",
    kind: "gardener-proposal",
    candidate,
    objective: criterion,
    scope: candidate.proposedScope,
    acceptance: [criterion],
    evidence: candidate.provenance,
    exclusions: [
      "No source changes, command execution, network request, issue publication, work promotion or acceptance is authorized by this draft.",
    ],
    reviewInstructions: `Classify actual changed scope with the existing classifier. ${requirements.risk}: autonomy ${requirements.policy.autonomy}; independent review ${requirements.policy.independentReview}; human approval ${requirements.policy.humanApproval}.`,
    proofDraft: proofPath,
    workDraft: output,
  };
  const validation = validate("work-item", draft);
  if (validation.length)
    throw new Error(`Invalid Gardener draft: ${validation.join("; ")}`);
  const artifacts = [
    [output, draft],
    [proposalPath, proposal],
    [proofPath, proof],
  ] as const;
  const encoded = artifacts.map(([path, value]) => ({
    path,
    absolute: safePath(root, path),
    bytes: JSON.stringify(value, null, 2) + "\n",
  }));
  if (new Set(encoded.map((item) => item.absolute)).size !== encoded.length)
    throw new Error(
      "Gardener artifact destinations must be distinct; output aliases a companion document",
    );
  if (
    encoded
      .slice(1)
      .some(
        (item) => item.absolute === location || item.absolute.startsWith(location + sep),
      )
  )
    throw new Error(
      "Gardener companion documents overlap the configured work-item inventory; select a narrower work location",
    );
  for (const item of encoded)
    if (existsSync(item.absolute) && readFileSync(item.absolute, "utf8") !== item.bytes)
      throw new Error(
        `Gardener draft conflict at ${item.path}; existing bytes preserved`,
      );
  const written: string[] = [];
  try {
    for (const item of encoded) {
      if (existsSync(item.absolute)) {
        if (readFileSync(safePath(root, item.path), "utf8") !== item.bytes)
          throw new Error(
            `Gardener draft changed during publication at ${item.path}; existing bytes preserved`,
          );
      } else {
        mkdirSync(dirname(item.absolute), { recursive: true });
        try {
          writeFileSync(safePath(root, item.path), item.bytes, {
            flag: "wx",
            mode: 0o600,
          });
          written.push(item.absolute);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            readFileSync(safePath(root, item.path), "utf8") !== item.bytes
          )
            throw error;
        }
      }
    }
  } catch (error) {
    for (const path of written.reverse()) unlinkSync(path);
    throw error;
  }
  return {
    created: written.length > 0,
    path: relative(safePath(root, "."), absolute).replaceAll(sep, "/"),
    proposal: proposalPath,
    proofPlan: proofPath,
    candidate,
  };
}
