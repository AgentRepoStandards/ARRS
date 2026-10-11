import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { readConfig } from "./config.js";
import {
  policyRequirements,
  requirePolicyBaseline,
  samePolicyBaseline,
} from "./policy-baseline.js";
import { readJson, safePath } from "./files.js";
import {
  changesetScopeHash,
  requireChangeset,
  validateChangesetSnapshot,
} from "./changeset.js";
import { resolveCommand } from "./runner.js";
import { validate } from "./schema.js";
import { evidenceIgnoreProtection, type IgnoreProtection } from "./evidence-ignore.js";
import type {
  ProofManifest,
  ProofPlan,
  ProofResult,
  ProofStep,
  ProofReview,
  PolicyBaseline,
} from "./types.js";

/** Match reserved roots by spelling or filesystem identity without following symlinks. */
function isOutputScope(base: string, normalized: string): boolean {
  if (!normalized) return true;
  const first = normalized.split("/")[0]!;
  const reserved = [".arrs", ".git", "node_modules"].find(
    (name) => name.toUpperCase() === first.toUpperCase(),
  );
  if (!reserved) return false;
  if (first === reserved) return true;
  try {
    const candidate = lstatSync(join(base, first), { bigint: true });
    const control = lstatSync(join(base, reserved), { bigint: true });
    return candidate.dev === control.dev && candidate.ino === control.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function validatePlan(
  root: string,
  value: unknown,
  baseline?: PolicyBaseline,
): string[] {
  const errors = validate("proof-plan", value);
  if (errors.length) return errors;
  const plan = value as ProofPlan;
  try {
    requirePolicyBaseline(plan.policyBaseline, baseline);
    requireChangeset(root, plan);
    const requirements = policyRequirements(root, plan.scope, plan.risk, baseline);
    const { policy } = requirements;
    if (requirements.risk > plan.risk)
      errors.push(
        `Declared risk is below the feature/sensitive-path risk floor (${requirements.risk}); reclassify using the selected pre-change baseline and candidate`,
      );
    const base = safePath(root, ".");
    for (const path of plan.scope) {
      const normalized = relative(base, safePath(root, path)).replaceAll(sep, "/");
      if (isOutputScope(base, normalized))
        errors.push(
          `Proof scope must refer to source paths, not root/generated/control output: ${path}; declare source files or directories outside these root trees`,
        );
    }
    for (const check of requirements.requiredChecks)
      if (
        !plan.steps.some(
          (step) =>
            step.command === check &&
            step.phase !== "before" &&
            step.expectExitCode === 0,
        )
      )
        errors.push(`Proof plan lacks required successful ${check} step`);
    for (const target of requirements.verificationTargets)
      if (
        !plan.steps.some(
          (step) =>
            step.command === "verify" &&
            step.target === target &&
            step.phase !== "before" &&
            step.expectExitCode === 0,
        )
      )
        errors.push(`Protected proof lacks mapped verification target ${target}`);
    for (const criterion of plan.acceptance)
      if (
        !plan.steps.some(
          (step) => step.criterion === criterion && acceptanceStep(plan, step),
        )
      )
        errors.push(
          `Acceptance criterion has no successful verification step: ${criterion}`,
        );
    if (
      !["bug", "refactor"].includes(plan.category) &&
      plan.steps.some((step) => step.phase === "before")
    )
      errors.push("Before evidence is only supported for bug/refactor tasks");
    if (
      plan.steps.some(
        (step, index) =>
          step.phase === "before" &&
          plan.steps.slice(0, index).some((previous) => previous.phase !== "before"),
      )
    )
      errors.push("Before evidence must precede all implementation verification steps");
    for (const step of plan.steps) {
      requirements.assertCommand(step.command, step.target);
      if (step.target && step.command !== "verify")
        errors.push(`Only verify steps accept target: ${step.command}`);
      if (
        step.expectExitCode !== 0 &&
        !(plan.category === "bug" && step.phase === "before")
      )
        errors.push("Only a bug reproduction before step may expect a failing command");
      if (
        (step.phase === "behavior" ||
          step.phase === "before" ||
          step.phase === "after") &&
        step.command !== "verify"
      )
        errors.push(`Behavioral phase ${step.phase} must execute verify`);
    }
    if (
      plan.risk >= requirements.behavioralRequiredFrom &&
      !plan.steps.some(
        (step) =>
          ["behavior", "after"].includes(step.phase) &&
          step.command === "verify" &&
          step.expectExitCode === 0,
      )
    )
      errors.push("Risk requires successful runtime behavioral verification");
    if (
      plan.category === "feature" &&
      !plan.steps.some(
        (step) =>
          step.phase === "behavior" &&
          step.command === "verify" &&
          step.expectExitCode === 0,
      )
    )
      errors.push("Feature proof requires real behavior verification");
    if (
      plan.category === "bug" &&
      (!plan.steps.some(
        (step) =>
          step.phase === "before" &&
          step.command === "verify" &&
          step.expectExitCode !== 0,
      ) ||
        !plan.steps.some(
          (step) =>
            step.phase === "after" &&
            step.command === "verify" &&
            step.expectExitCode === 0,
        ))
    )
      errors.push(
        "Bug proof requires a failing before verification and successful after verification",
      );
    if (
      plan.category === "refactor" &&
      (!plan.steps.some(
        (step) =>
          step.phase === "before" &&
          step.command === "verify" &&
          step.expectExitCode === 0,
      ) ||
        !plan.steps.some(
          (step) =>
            step.phase === "after" &&
            step.command === "verify" &&
            step.expectExitCode === 0,
        ))
    )
      errors.push("Refactor proof requires successful before and after verification");
    if (
      policy.humanApproval &&
      (plan.authorization?.humanApproval ?? plan.review?.humanApproval ?? "").trim()
        .length < 12
    )
      errors.push(`${plan.risk} requires human approval authorization before execution`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function evidenceFile(
  root: string,
  path: string,
  baseline?: PolicyBaseline,
): { manifest: ProofManifest; sha256: string } {
  const manifest = readJson(root, path) as ProofManifest;
  const errors = validateEvidence(root, manifest, baseline);
  if (errors.length) throw new Error(`Invalid technical proof: ${errors.join("; ")}`);
  const canonical = `${readConfig(root).proof.evidenceDir}/${manifest.id}/proof.json`;
  if (safePath(root, path) !== safePath(root, canonical))
    throw new Error("Reviewed proof must be in its canonical evidence location");
  return {
    manifest,
    sha256: createHash("sha256")
      .update(readFileSync(safePath(root, path)))
      .digest("hex"),
  };
}

function reviewErrors(
  root: string,
  manifest: ProofManifest,
  sha256: string,
  value: unknown,
  baseline?: PolicyBaseline,
): string[] {
  const errors = validate("proof-review", value);
  if (errors.length) return errors;
  const review = value as ProofReview;
  if (!samePolicyBaseline(review.policyBaseline, manifest.policyBaseline))
    errors.push("Implementation review policy baseline binding differs from the proof");
  if (review.proofId !== manifest.id || review.manifestSha256 !== sha256)
    errors.push(
      "Implementation review does not bind this proof attempt and manifest bytes",
    );
  const entries = (hashes: Record<string, string>): string =>
    JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
  if (entries(review.scopeHashes) !== entries(manifest.scopeHashes))
    errors.push("Implementation review scope binding differs from the proof");
  const timestamp = Date.parse(review.createdAt);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < Date.parse(manifest.createdAt) ||
    timestamp > Date.now()
  )
    errors.push(
      "Implementation review timestamp must follow capture and not be in the future",
    );
  const policy = policyRequirements(root, manifest.scope, manifest.risk, baseline).policy;
  if (
    policy.independentReview &&
    (!review.independent || review.independent.trim().length < 12)
  )
    errors.push("Independent implementation review required");
  if (
    policy.humanApproval &&
    (!review.humanApproval || review.humanApproval.trim().length < 12)
  )
    errors.push("Human approval of the implementation required for acceptance");
  return errors;
}

/** Accepted evidence is technical success plus current policy-required review of this immutable attempt. */
export function validateAcceptedEvidence(
  root: string,
  path: string,
  baseline?: PolicyBaseline,
): string[] {
  try {
    const { manifest, sha256 } = evidenceFile(root, path, baseline);
    const policy = policyRequirements(
      root,
      manifest.scope,
      manifest.risk,
      baseline,
    ).policy;
    if (!policy.independentReview && !policy.humanApproval) return [];
    const directory = dirname(path);
    const failures: string[] = [];
    for (const file of readdirSync(safePath(root, directory)).filter((file) =>
      /^review-[a-f0-9-]{36}\.json$/.test(file),
    )) {
      try {
        const errors = reviewErrors(
          root,
          manifest,
          sha256,
          readJson(root, `${directory}/${file}`),
          baseline,
        );
        if (!errors.length) return [];
        failures.push(`${file}: ${errors.join("; ")}`);
      } catch (error) {
        failures.push(
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return [
      "No valid implementation review is attached to the selected proof attempt",
      ...failures,
    ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Diagnose one local attachment without borrowing acceptance from another review. */
export function validateImplementationReview(
  root: string,
  path: string,
  reviewPath: string,
  baseline?: PolicyBaseline,
): string[] {
  try {
    const { manifest, sha256 } = evidenceFile(root, path, baseline);
    if (
      dirname(safePath(root, reviewPath)) !== dirname(safePath(root, path)) ||
      !/^review-[a-f0-9-]{36}\.json$/.test(reviewPath.split("/").at(-1) ?? "")
    )
      throw new Error("Review must be a canonical attachment beside the selected proof");
    return reviewErrors(root, manifest, sha256, readJson(root, reviewPath), baseline);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Append an explicit implementation-stage review without rewriting captured evidence. */
export function attachImplementationReview(
  root: string,
  path: string,
  input: unknown,
  baseline?: PolicyBaseline,
): { path: string; review: ProofReview; ignoreProtection: IgnoreProtection } {
  const { manifest, sha256 } = evidenceFile(root, path, baseline);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["schemaVersion", "stage", "independent", "humanApproval"].includes(key),
    )
  )
    throw new Error(
      "Review input must contain only schemaVersion, implementation stage and actual review/approval records",
    );
  const review = {
    ...input,
    proofId: manifest.id,
    manifestSha256: sha256,
    scopeHashes: manifest.scopeHashes,
    createdAt: new Date().toISOString(),
    ...(manifest.policyBaseline ? { policyBaseline: manifest.policyBaseline } : {}),
  } as ProofReview;
  const errors = reviewErrors(root, manifest, sha256, review, baseline);
  if (errors.length)
    throw new Error(`Invalid implementation review: ${errors.join("; ")}`);
  const reviewPath = `${readConfig(root).proof.evidenceDir}/${manifest.id}/review-${randomUUID()}.json`;
  const ignoreProtection = evidenceIgnoreProtection(
    root,
    readConfig(root).proof.evidenceDir,
  );
  writeFileSync(safePath(root, reviewPath), JSON.stringify(review, null, 2) + "\n", {
    flag: "wx",
  });
  return { path: reviewPath, review, ignoreProtection };
}

function acceptanceStep(plan: ProofPlan, step: ProofStep): boolean {
  if (plan.category === "docs")
    return step.phase !== "before" && step.expectExitCode === 0;
  return (
    step.command === "verify" &&
    step.expectExitCode === 0 &&
    (plan.category === "feature" ? step.phase === "behavior" : step.phase === "after")
  );
}

function sameStep(a: ProofStep, b: ProofStep): boolean {
  return (
    a.phase === b.phase &&
    a.command === b.command &&
    a.target === b.target &&
    a.expectExitCode === b.expectExitCode &&
    a.criterion === b.criterion
  );
}
function sameScenario(a: ProofResult, b: ProofResult): boolean {
  return (
    a.command === b.command &&
    a.target === b.target &&
    JSON.stringify(a.argv) === JSON.stringify(b.argv)
  );
}

/** Validate current, local evidence against source, current commands and policy. Not hostile-author attestation. */
export function validateEvidence(
  root: string,
  value: unknown,
  baseline?: PolicyBaseline,
): string[] {
  const errors = validate("proof", value);
  if (errors.length) return errors;
  const manifest = value as ProofManifest;
  const {
    id: _id,
    createdAt: _createdAt,
    status: _status,
    results: _results,
    scopeHashes: _hashes,
    changesetSnapshot: _changeset,
    ...plan
  } = manifest;
  if (baseline && !manifest.policyBaseline)
    errors.push(
      "Protected evidence requires a captured policy baseline binding; recapture under the independently selected baseline",
    );
  errors.push(...validatePlan(root, plan, baseline));
  errors.push(...validateChangesetSnapshot(root, plan, manifest.changesetSnapshot));
  try {
    const config = readConfig(root);
    if (manifest.status !== "passed") errors.push("Proof status is failed");
    evidenceIgnoreProtection(root, config.proof.evidenceDir);
    if (!Number.isFinite(Date.parse(manifest.createdAt)))
      errors.push("Proof createdAt is not a valid timestamp");
    if (manifest.results.length !== manifest.steps.length)
      errors.push("Proof results do not correspond one-to-one to planned steps");
    for (const [index, result] of manifest.results.entries()) {
      const step = manifest.steps[index];
      if (!step || !sameStep(step, result))
        errors.push(`Result ${index + 1} does not match its planned step`);
      if (result.exitCode !== result.expectExitCode)
        errors.push(
          `Result ${index + 1} exited ${result.exitCode}; expected ${result.expectExitCode}`,
        );
      if (
        result.exitCode !== 0 &&
        !(
          manifest.category === "bug" &&
          result.phase === "before" &&
          result.expectExitCode !== 0
        )
      )
        errors.push(`Required verification result ${index + 1} failed`);
      const configured = resolveCommand(config, result.command, result.target);
      if (JSON.stringify(configured.argv) !== JSON.stringify(result.argv))
        errors.push(
          `Result ${index + 1} argv differs from the current configured command`,
        );
      if (!result.log.startsWith(`${config.proof.evidenceDir}/${manifest.id}/`))
        errors.push(`Result ${index + 1} log is outside its evidence directory`);
      const content = readFileSync(safePath(root, result.log));
      if (createHash("sha256").update(content).digest("hex") !== result.sha256)
        errors.push(`Result ${index + 1} log hash does not match`);
      const log = readJson(root, result.log) as {
        argv?: unknown;
        exitCode?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        durationMs?: unknown;
      };
      if (
        JSON.stringify(log.argv) !== JSON.stringify(result.argv) ||
        log.exitCode !== result.exitCode ||
        log.durationMs !== result.durationMs ||
        typeof log.stdout !== "string" ||
        typeof log.stderr !== "string"
      )
        errors.push(
          `Result ${index + 1} log does not substantiate the recorded execution`,
        );
    }
    for (const criterion of manifest.acceptance)
      if (
        !manifest.results.some(
          (result) =>
            result.criterion === criterion &&
            acceptanceStep(manifest, result) &&
            result.exitCode === 0,
        )
      )
        errors.push(`Acceptance criterion lacks passing evidence: ${criterion}`);
    for (const before of manifest.results.filter((result) => result.phase === "before")) {
      if (
        (manifest.category === "bug" || manifest.category === "refactor") &&
        !manifest.results.some(
          (result) =>
            result.phase === "after" &&
            result.exitCode === 0 &&
            sameScenario(before, result),
        )
      )
        errors.push(
          "Before and after evidence must execute the same behavioral scenario (argv and target)",
        );
    }
    const keys = Object.keys(manifest.scopeHashes).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...manifest.scope].sort()))
      errors.push("Proof scopeHashes do not exactly cover the declared scope");
    for (const path of manifest.scope)
      if (
        manifest.scopeHashes[path] !==
        changesetScopeHash(root, path, manifest.changesetSnapshot)
      )
        errors.push(`Proof scope changed since execution: ${path}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
