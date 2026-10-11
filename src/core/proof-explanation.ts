import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { readConfig } from "./config.js";
import { safePath, hashScope } from "./files.js";
import { validate } from "./schema.js";
import { resolveCommand } from "./runner.js";
import {
  validateEvidence,
  validateAcceptedEvidence,
  validateImplementationReview,
} from "./evidence.js";
import { policyMode, policyRequirements } from "./policy-baseline.js";
import type { PolicyBaseline, ProofManifest, ProofStep } from "./types.js";

const maxJsonBytes = 1024 * 1024;
const maxLogBytes = 20 * 1024 * 1024;
const maxEntries = 2000;
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);
const diagnostics = (errors: string[]): string[] =>
  errors.slice(0, 40).map((error) => error.slice(0, 4000));

/** Bounded non-following JSON reads; never interpret provenance as a read instruction. */
export function readProofJson(root: string, path: string): unknown {
  const absolute = safePath(root, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size > maxJsonBytes)
    throw new Error(`Proof JSON must be a regular file at most 1 MiB: ${path}`);
  return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
}

export interface ProofExplanation {
  schemaVersion: "0.1";
  kind: "proof-explanation";
  path: string;
  id?: string;
  task?: string;
  category?: ProofManifest["category"];
  risk?: ProofManifest["risk"];
  createdAt?: string;
  recordedStatus?: ProofManifest["status"];
  manifestSha256?: string;
  policyMode: ReturnType<typeof policyMode>;
  technical: { valid: boolean; errors: string[] };
  review: {
    ready: boolean;
    status: "invalid-proof" | "ready-for-review" | "accepted";
    accepted: boolean;
    required: { independent: boolean; humanApproval: boolean } | null;
    errors: string[];
    attachments: Array<{ path: string; valid: boolean; errors: string[] }>;
  };
  scope: Array<{ path: string; sha256: string; fresh: boolean | null }>;
  requiredChecks: string[];
  verificationTargets: string[];
  steps: Array<{
    index: number;
    planned: ProofStep;
    result: ProofManifest["results"][number] | null;
    matchedExpectedExit: boolean;
    argvBound: boolean;
  }>;
  acceptance: Array<{ criterion: string; resultIndices: number[]; satisfied: boolean }>;
  baseline: Array<{
    beforeIndex: number;
    afterIndices: number[];
    identicalArgv: boolean;
  }>;
  residualRisks: string[];
  deviations: string[];
  coverage: { assurance: "declared-only" | "git-complete"; snapshot?: unknown };
  limitations: string[];
}

/** Preflight recorded log references before validators read any referenced bytes. */
export function containedProofLogs(root: string, manifest: ProofManifest): void {
  const directory = safePath(
    root,
    `${readConfig(root).proof.evidenceDir}/${manifest.id}`,
  );
  for (const result of manifest.results) {
    const absolute = safePath(root, result.log);
    if (!absolute.startsWith(directory + sep))
      throw new Error(`Referenced log escapes the canonical attempt: ${result.log}`);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > maxLogBytes)
      throw new Error(`Log must be a regular file at most 20 MiB: ${result.log}`);
  }
}

/** Read-only diagnostic projection. Only the shared validators establish validity/acceptance. */
export function explainProof(
  root: string,
  input: string,
  baseline?: PolicyBaseline,
): ProofExplanation {
  const report: ProofExplanation = {
    schemaVersion: "0.1",
    kind: "proof-explanation",
    path: input,
    policyMode: policyMode(baseline),
    technical: { valid: false, errors: [] },
    review: {
      ready: false,
      status: "invalid-proof",
      accepted: false,
      required: null,
      errors: [],
      attachments: [],
    },
    scope: [],
    requiredChecks: [],
    verificationTargets: [],
    steps: [],
    acceptance: [],
    baseline: [],
    residualRisks: [],
    deviations: [],
    coverage: { assurance: "declared-only" },
    limitations: [
      "Local hashes and review notes are assertions, not authenticated execution or reviewer identity.",
      "Legacy declared scope does not establish complete Git changeset coverage.",
    ],
  };
  try {
    const value = readProofJson(root, input);
    if (
      value &&
      typeof value === "object" &&
      "task" in value &&
      typeof value.task === "string"
    )
      report.task = value.task.slice(0, 4000);
    const schemaErrors = validate("proof", value);
    if (schemaErrors.length) {
      report.technical.errors = diagnostics(schemaErrors);
      return report;
    }
    const manifest = value as ProofManifest;
    const config = readConfig(root);
    const canonical = `${config.proof.evidenceDir}/${manifest.id}/proof.json`;
    if (safePath(root, input) !== safePath(root, canonical))
      throw new Error("Selected proof must use its canonical attempt path");
    report.path = canonical;
    Object.assign(report, {
      id: manifest.id,
      task: manifest.task,
      category: manifest.category,
      risk: manifest.risk,
      createdAt: manifest.createdAt,
      recordedStatus: manifest.status,
    });
    report.manifestSha256 = createHash("sha256")
      .update(readFileSync(safePath(root, canonical)))
      .digest("hex");
    // Populate safe declared fields even when a referenced log or trust context is missing.
    report.residualRisks = manifest.residualRisks;
    report.deviations = manifest.deviations;
    report.scope = manifest.scope.map((path) => ({
      path,
      sha256: manifest.scopeHashes[path] ?? "",
      fresh: null,
    }));
    report.steps = manifest.steps.map((planned, index) => {
      const result = manifest.results[index] ?? null;
      let argvBound = false;
      try {
        argvBound =
          !!result &&
          JSON.stringify(resolveCommand(config, result.command, result.target).argv) ===
            JSON.stringify(result.argv);
      } catch {
        /* shared validator supplies the diagnostic */
      }
      return {
        index: index + 1,
        planned,
        result,
        matchedExpectedExit: !!result && result.exitCode === planned.expectExitCode,
        argvBound,
      };
    });
    report.acceptance = manifest.acceptance.map((criterion) => {
      const resultIndices = manifest.results.flatMap((result, index) =>
        result.criterion === criterion &&
        result.exitCode === 0 &&
        result.expectExitCode === 0 &&
        (manifest.category === "docs"
          ? result.phase !== "before"
          : result.command === "verify" &&
            (result.phase === "behavior" || result.phase === "after"))
          ? [index + 1]
          : [],
      );
      return { criterion, resultIndices, satisfied: false };
    });
    report.baseline = manifest.results.flatMap((before, index) => {
      if (before.phase !== "before") return [];
      const afterIndices = manifest.results.flatMap((after, afterIndex) =>
        after.phase === "after" &&
        after.exitCode === 0 &&
        before.target === after.target &&
        JSON.stringify(before.argv) === JSON.stringify(after.argv)
          ? [afterIndex + 1]
          : [],
      );
      return [
        { beforeIndex: index + 1, afterIndices, identicalArgv: afterIndices.length > 0 },
      ];
    });
    containedProofLogs(root, manifest);
    report.technical.errors = diagnostics(validateEvidence(root, value, baseline));
    report.technical.valid = report.technical.errors.length === 0;
    // #34 supplies this optional recorded snapshot. Only its shared successful
    // validator can establish coverage; an independent inspection never upgrades proof.
    if (
      "changesetSnapshot" in manifest &&
      manifest.changesetSnapshot &&
      typeof manifest.changesetSnapshot === "object"
    ) {
      report.coverage = {
        assurance: report.technical.valid ? "git-complete" : "declared-only",
        snapshot: manifest.changesetSnapshot,
      };
      if (report.technical.valid)
        report.limitations = report.limitations.filter(
          (text) => !text.startsWith("Legacy declared scope"),
        );
    }
    for (const scope of report.scope) {
      try {
        scope.fresh = hashScope(root, scope.path) === scope.sha256;
      } catch {
        scope.fresh = false;
      }
    }
    try {
      const requirements = policyRequirements(
        root,
        manifest.scope,
        manifest.risk,
        baseline,
      );
      report.requiredChecks = requirements.requiredChecks;
      report.verificationTargets = requirements.verificationTargets;
      report.review.required = {
        independent: requirements.policy.independentReview,
        humanApproval: requirements.policy.humanApproval,
      };
    } catch (error) {
      report.review.errors.push(message(error));
    }
    const directory = dirname(canonical);
    const files = readdirSync(safePath(root, directory));
    if (files.length > maxEntries)
      throw new Error("Too many proof attachment entries; narrow evidence history");
    let attachmentsBounded = true;
    for (const file of files
      .filter((file) => /^review-[a-f0-9-]{36}\.json$/.test(file))
      .sort()) {
      const path = `${directory}/${file}`;
      let errors: string[];
      try {
        const stat = lstatSync(safePath(root, path));
        if (!stat.isFile() || stat.size > maxJsonBytes) {
          attachmentsBounded = false;
          throw new Error(
            "Attachment exceeds the observer's regular-file/1 MiB read limit; acceptance cannot be established within reporting bounds",
          );
        }
        readProofJson(root, path);
        errors = validateImplementationReview(root, canonical, path, baseline);
      } catch (error) {
        errors = [message(error)];
      }
      report.review.attachments.push({
        path,
        valid: errors.length === 0,
        errors: diagnostics(errors),
      });
    }
    if (attachmentsBounded)
      report.review.errors.push(
        ...diagnostics(validateAcceptedEvidence(root, canonical, baseline)),
      );
    else
      report.review.errors.push(
        "Observer limit: an attachment exceeds safe reporting bounds; accepted status is unavailable. The authoritative admission validator is unchanged.",
      );
    report.review.accepted = report.technical.valid && report.review.errors.length === 0;
    report.review.ready = report.technical.valid;
    report.review.status = report.review.accepted
      ? "accepted"
      : report.technical.valid
        ? "ready-for-review"
        : "invalid-proof";
    for (const criterion of report.acceptance)
      criterion.satisfied = report.technical.valid && criterion.resultIndices.length > 0;
  } catch (error) {
    report.technical.errors.push(message(error));
    report.technical.valid = false;
    report.review.ready = false;
    report.review.accepted = false;
    report.review.status = "invalid-proof";
  }
  return report;
}

export interface ProofHistory {
  schemaVersion: "0.1";
  kind: "proof-history";
  evidenceDir: string;
  summary: {
    total: number;
    accepted: number;
    ready: number;
    invalid: number;
    failed: number;
    interrupted: number;
    sessions: number;
  };
  entries: Array<{
    path: string;
    id: string;
    status:
      | "accepted"
      | "ready-for-review"
      | "invalid"
      | "failed"
      | "interrupted"
      | "baseline-session";
    selected: boolean;
    createdAt?: string;
    task?: string;
    sessionHint?: string;
    provenanceTrusted: false;
    diagnostics: string[];
    explanation?: ProofExplanation;
  }>;
  errors: string[];
  limitations: string[];
  groups: Array<{
    sessionHint: string;
    attemptPaths: string[];
    provenanceTrusted: false;
  }>;
}

/** Index immediate canonical attempts. Malformed/symlink siblings remain isolated diagnostics. */
export function proofHistory(
  root: string,
  baseline?: PolicyBaseline,
  selected?: string,
): ProofHistory {
  const evidenceDir = readConfig(root).proof.evidenceDir;
  const report: ProofHistory = {
    schemaVersion: "0.1",
    kind: "proof-history",
    evidenceDir,
    summary: {
      total: 0,
      accepted: 0,
      ready: 0,
      invalid: 0,
      failed: 0,
      interrupted: 0,
      sessions: 0,
    },
    entries: [],
    errors: [],
    groups: [],
    limitations: [
      "Attempt provenance and session groups are untrusted diagnostic assertions; history does not promote or reuse acceptance.",
    ],
  };
  const selectedPath = selected ? safePath(root, selected) : undefined;
  try {
    if (!existsSync(safePath(root, evidenceDir))) return report;
    const names = readdirSync(safePath(root, evidenceDir)).sort();
    if (names.length > maxEntries)
      throw new Error(
        "Evidence history exceeds 2000 entries; no partial success is claimed",
      );
    for (const name of names) {
      const directory = `${evidenceDir}/${name}`;
      const entry: ProofHistory["entries"][number] = {
        path: `${directory}/proof.json`,
        id: name,
        status: "invalid",
        selected: false,
        provenanceTrusted: false,
        diagnostics: [],
      };
      try {
        const absolute = safePath(root, directory);
        if (!lstatSync(absolute).isDirectory()) continue;
        if (existsSync(safePath(root, entry.path))) {
          const explanation = explainProof(root, entry.path, baseline);
          entry.explanation = explanation;
          entry.selected = !!selectedPath && safePath(root, entry.path) === selectedPath;
          if (explanation.createdAt) entry.createdAt = explanation.createdAt;
          if (explanation.task) entry.task = explanation.task;
          entry.status = explanation.review.accepted
            ? "accepted"
            : explanation.technical.valid
              ? "ready-for-review"
              : explanation.recordedStatus === "failed"
                ? "failed"
                : "invalid";
          entry.diagnostics = [
            ...explanation.technical.errors,
            ...explanation.review.errors,
          ];
        } else if (existsSync(safePath(root, `${directory}/attempt.json`))) {
          entry.path = `${directory}/attempt.json`;
          entry.status = "interrupted";
          entry.diagnostics.push(
            "Allocated attempt has no completed manifest; it cannot establish technical success",
          );
        } else if (existsSync(safePath(root, `${directory}/session.json`))) {
          entry.path = `${directory}/session.json`;
          const value = readProofJson(root, entry.path);
          if (
            !value ||
            typeof value !== "object" ||
            !("id" in value) ||
            value.id !== name
          )
            throw new Error("Malformed baseline session");
          entry.status = "baseline-session";
        } else if (
          /^[a-f0-9-]{36}$/.test(name) &&
          readdirSync(absolute).some((file) =>
            /^\d{3}-(before|check|test|behavior|after|mechanical)\.json$/.test(file),
          )
        ) {
          entry.path = directory;
          entry.status = "interrupted";
          entry.diagnostics.push(
            "Canonical capture directory retains partial logs without a completed manifest; no execution, provenance or technical success is authenticated",
          );
        } else continue;
        entry.selected = !!selectedPath && safePath(root, entry.path) === selectedPath;
        // Parse only the marker itself; never dereference a supplied session/log path.
        const marker = `${directory}/attempt.json`;
        if (existsSync(safePath(root, marker))) {
          try {
            const value = readProofJson(root, marker);
            if (
              value &&
              typeof value === "object" &&
              "session" in value &&
              typeof value.session === "string"
            ) {
              const session = safePath(root, value.session);
              const normalized = relative(
                safePath(root, evidenceDir),
                session,
              ).replaceAll(sep, "/");
              if (
                normalized.startsWith("../") ||
                !/^[a-f0-9-]{36}\/session\.json$/.test(normalized)
              )
                throw new Error(
                  "Provenance session hint is outside canonical evidence; ignored",
                );
              entry.sessionHint = `${evidenceDir}/${normalized}`;
            } else throw new Error("Malformed attempt provenance; grouping unavailable");
          } catch (error) {
            entry.diagnostics.push(message(error));
          }
        }
      } catch (error) {
        entry.diagnostics.push(message(error));
      }
      report.entries.push(entry);
    }
    const priority = (entry: ProofHistory["entries"][number]): number =>
      entry.selected
        ? 0
        : entry.status === "accepted"
          ? 1
          : entry.status === "ready-for-review"
            ? 2
            : 3;
    report.entries.sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        a.path.localeCompare(b.path),
    );
    report.summary.total = report.entries.length;
    for (const entry of report.entries)
      report.summary[
        entry.status === "ready-for-review"
          ? "ready"
          : entry.status === "baseline-session"
            ? "sessions"
            : entry.status
      ]++;
    for (const sessionHint of [
      ...new Set(
        report.entries.flatMap((entry) => (entry.sessionHint ? [entry.sessionHint] : [])),
      ),
    ].sort())
      report.groups.push({
        sessionHint,
        attemptPaths: report.entries
          .filter((entry) => entry.sessionHint === sessionHint)
          .map((entry) => entry.path),
        provenanceTrusted: false,
      });
  } catch (error) {
    report.errors.push(message(error));
  }
  return report;
}

/** Terminal projection strips control characters; JSON preserves exact evidence text. */
export function proofExplanationText(report: ProofExplanation): string {
  const lines = [
    `Proof ${report.id ?? report.path}: ${report.task ?? "unreadable task"}`,
    `Technical: ${report.technical.valid ? "passed" : "invalid"}; review: ${report.review.status}; accepted: ${report.review.accepted}`,
    `Policy: ${report.policyMode}; risk: ${report.risk ?? "unknown"}`,
    `Required checks: ${report.requiredChecks.join(", ") || "unavailable"}`,
  ];
  for (const scope of report.scope)
    lines.push(
      `Scope ${scope.path}: ${scope.fresh === true ? "current" : scope.fresh === false ? "stale" : "unavailable"}`,
    );
  for (const step of report.steps)
    lines.push(
      `Step ${step.index} ${step.planned.phase} ${step.planned.command}: exit ${step.result?.exitCode ?? "missing"}, expected ${step.planned.expectExitCode}; argv ${JSON.stringify(step.result?.argv ?? [])}; binding ${step.argvBound}`,
    );
  for (const criterion of report.acceptance)
    lines.push(
      `Acceptance ${criterion.satisfied ? "verified" : "unresolved"}: ${criterion.criterion}; result(s) ${criterion.resultIndices.join(", ") || "none"}`,
    );
  for (const pair of report.baseline)
    lines.push(
      `Baseline step ${pair.beforeIndex}: identical after argv ${pair.identicalArgv}; after step(s) ${pair.afterIndices.join(", ") || "none"}`,
    );
  for (const text of [
    ...report.technical.errors,
    ...report.review.errors,
    ...report.residualRisks,
    ...report.deviations,
    ...report.limitations,
  ])
    lines.push(text);
  return lines.join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\uFFFD");
}
