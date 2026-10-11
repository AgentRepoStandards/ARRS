import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readConfig } from "../core/config.js";
import { readJson, safePath } from "../core/files.js";
import {
  changesetScopeHash,
  requireChangeset,
  type ChangesetSnapshot,
} from "../core/changeset.js";
import {
  validateEvidence,
  validatePlan,
  attachImplementationReview,
} from "../core/evidence.js";
import { policyRequirements } from "../core/policy-baseline.js";
import {
  evidenceIgnoreProtection,
  type IgnoreProtection,
} from "../core/evidence-ignore.js";
import { resolveCommand, runCommand } from "../core/runner.js";
import { collectPlanLifecycle, outcomeIdentity } from "../core/outcomes.js";
import type {
  ProofPlan,
  ProofResult,
  ProofManifest,
  ProofStep,
  PolicyBaseline,
} from "../core/types.js";

interface Session {
  schemaVersion: "0.1";
  id: string;
  createdAt: string;
  plan: ProofPlan;
  results: ProofResult[];
  digest: string;
}
const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");
function validatedPlan(
  root: string,
  value: unknown,
  baseline?: PolicyBaseline,
): ProofPlan {
  const errors = validatePlan(root, value, baseline);
  if (errors.length) throw new Error(`Invalid proof plan:\n${errors.join("\n")}`);
  const plan = baseline
    ? { ...(value as ProofPlan), policyBaseline: baseline }
    : (value as ProofPlan);
  const config = readConfig(root);
  if (!config.proof.evidenceDir.startsWith(".arrs/"))
    throw new Error("Proof evidenceDir must be inside ignored .arrs/.");
  evidenceIgnoreProtection(root, config.proof.evidenceDir);
  const snapshot = requireChangeset(root, plan);
  for (const scope of plan.scope) {
    safePath(root, scope);
    changesetScopeHash(root, scope, snapshot);
  }
  const risk = policyRequirements(root, plan.scope, plan.risk, baseline).risk;
  if (risk !== plan.risk)
    throw new Error(
      `Scope requires ${risk}; plan declares ${plan.risk}. Reclassify risk and satisfy review policy.`,
    );
  for (const step of plan.steps) resolveCommand(config, step.command, step.target);
  if (plan.category === "bug" || plan.category === "refactor") {
    if (
      !plan.steps.some((step) => step.phase === "before") ||
      !plan.steps.some((step) => step.phase === "after")
    )
      throw new Error(`${plan.category} proof requires before and after steps.`);
    if (
      plan.steps.some(
        (step, index) =>
          step.phase === "before" &&
          plan.steps.slice(0, index).some((previous) => previous.phase !== "before"),
      )
    )
      throw new Error("Before steps must precede all implementation verification steps.");
  } else if (plan.steps.some((step) => step.phase === "before"))
    throw new Error("Use bug/refactor category for before evidence.");
  return plan;
}
async function capture(
  root: string,
  id: string,
  steps: ProofStep[],
  startIndex: number,
  plan: ProofPlan,
  baseline?: PolicyBaseline,
): Promise<ProofResult[]> {
  const requirements = policyRequirements(root, plan.scope, plan.risk, baseline);
  const config = requirements.config;
  for (const step of steps) requirements.assertCommand(step.command, step.target);
  const directory = safePath(root, `${config.proof.evidenceDir}/${id}`);
  evidenceIgnoreProtection(root, config.proof.evidenceDir);
  mkdirSync(directory, { recursive: true });
  const results: ProofResult[] = [];
  for (const [index, step] of steps.entries()) {
    const result = await runCommand(
      root,
      resolveCommand(config, step.command, step.target),
    );
    const log = `${config.proof.evidenceDir}/${id}/${String(startIndex + index).padStart(3, "0")}-${step.phase}.json`;
    const content = JSON.stringify(result, null, 2) + "\n";
    evidenceIgnoreProtection(root, config.proof.evidenceDir);
    writeFileSync(safePath(root, log), content, { flag: "wx" });
    results.push({
      ...step,
      argv: result.argv,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      log,
      sha256: digest(content),
    });
    // Keep all required results, including failing ones. No exception hides a failure.
  }
  return results;
}
function finalize(
  root: string,
  plan: ProofPlan,
  id: string,
  createdAt: string,
  results: ProofResult[],
  verifiedHashes: Record<string, string>,
  baseline?: PolicyBaseline,
  changesetSnapshot?: ChangesetSnapshot,
): {
  manifest: ProofManifest;
  path: string;
  errors: string[];
  ignoreProtection: IgnoreProtection;
  outcomeWarnings: string[];
} {
  const config = readConfig(root);
  const scopeHashes = verifiedHashes;
  const manifest: ProofManifest = {
    ...plan,
    id,
    createdAt,
    status: "passed",
    results,
    scopeHashes,
    ...(changesetSnapshot ? { changesetSnapshot } : {}),
  };
  const errors = validateProof(root, manifest, baseline);
  if (errors.length) manifest.status = "failed";
  const path = `${config.proof.evidenceDir}/${id}/proof.json`;
  const ignoreProtection = evidenceIgnoreProtection(root, config.proof.evidenceDir);
  writeFileSync(safePath(root, path), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  const outcomeWarnings = collectPlanLifecycle(
    root,
    plan,
    { kind: "proof-completed", attemptId: id, status: manifest.status },
    id,
    new Date().toISOString(),
    manifest.status === "failed" ? ["verification-failed"] : [],
  );
  return { manifest, path, errors, ignoreProtection, outcomeWarnings };
}
export function validateProof(
  root: string,
  manifest: unknown,
  baseline?: PolicyBaseline,
): string[] {
  return validateEvidence(root, manifest, baseline);
}
export function reviewProof(
  root: string,
  manifestFile: string,
  reviewFile: string,
  baseline?: PolicyBaseline,
): ReturnType<typeof attachImplementationReview> & { outcomeWarnings: string[] } {
  const input = readJson(root, reviewFile);
  const result = attachImplementationReview(root, manifestFile, input, baseline);
  const manifest = readJson(root, manifestFile) as ProofManifest;
  const outcomeWarnings = collectPlanLifecycle(
    root,
    manifest,
    { kind: "review-attached", attemptId: manifest.id },
    `${manifest.id}:${outcomeIdentity(input)}`,
    result.review.createdAt,
  );
  return { ...result, outcomeWarnings };
}
export async function runProof(
  root: string,
  planFile: string,
  execute: boolean,
  baseline?: PolicyBaseline,
): Promise<{
  manifest: ProofManifest;
  path: string;
  errors: string[];
  ignoreProtection: IgnoreProtection;
  outcomeWarnings: string[];
}> {
  if (!execute)
    throw new Error(
      "Proof executes repository commands; pass --execute after reviewing the plan and arrs.json.",
    );
  const plan = validatedPlan(root, readJson(root, planFile), baseline);
  if (plan.category === "bug" || plan.category === "refactor")
    throw new Error(
      "Bug/refactor proof requires proof start before the edit and proof finish after it.",
    );
  const id = randomUUID(),
    createdAt = new Date().toISOString();
  const snapshot = requireChangeset(root, plan);
  const hashes = Object.fromEntries(
    plan.scope.map((scope) => [scope, changesetScopeHash(root, scope, snapshot)]),
  );
  const allocationWarnings = collectPlanLifecycle(
    root,
    plan,
    { kind: "proof-allocated", attemptId: id },
    id,
    createdAt,
  );
  const result = finalize(
    root,
    plan,
    id,
    createdAt,
    await capture(root, id, plan.steps, 0, plan, baseline),
    hashes,
    baseline,
    snapshot,
  );
  return {
    ...result,
    outcomeWarnings: [...allocationWarnings, ...result.outcomeWarnings],
  };
}
export async function startProof(
  root: string,
  planFile: string,
  execute: boolean,
  baseline?: PolicyBaseline,
): Promise<{
  session: string;
  results: ProofResult[];
  ignoreProtection: IgnoreProtection;
  outcomeWarnings: string[];
}> {
  if (!execute) throw new Error("Pass --execute to capture before evidence.");
  const plan = validatedPlan(root, readJson(root, planFile), baseline);
  if (plan.category !== "bug" && plan.category !== "refactor")
    throw new Error(
      "Proof start is for bug/refactor plans; use proof run for feature/docs.",
    );
  const id = randomUUID(),
    createdAt = new Date().toISOString();
  const before = plan.steps.filter((step) => step.phase === "before");
  const allocationWarnings = collectPlanLifecycle(
    root,
    plan,
    { kind: "proof-allocated", attemptId: id, phase: "baseline" },
    id,
    createdAt,
  );
  const results = await capture(root, id, before, 0, plan, baseline);
  const completionWarnings = collectPlanLifecycle(
    root,
    plan,
    {
      kind: "proof-completed",
      attemptId: id,
      phase: "baseline",
      status: results.every((result) => result.exitCode === result.expectExitCode)
        ? "passed"
        : "failed",
    },
    id,
    new Date().toISOString(),
  );
  if (results.some((result) => result.exitCode !== result.expectExitCode))
    throw new Error(
      `Before scenario did not produce the expected exit status. Evidence retained at ${readConfig(root).proof.evidenceDir}/${id}.`,
    );
  const content = { schemaVersion: "0.1" as const, id, createdAt, plan, results };
  const session = `${readConfig(root).proof.evidenceDir}/${id}/session.json`;
  const ignoreProtection = evidenceIgnoreProtection(
    root,
    readConfig(root).proof.evidenceDir,
  );
  writeFileSync(
    safePath(root, session),
    JSON.stringify({ ...content, digest: digest(JSON.stringify(content)) }, null, 2) +
      "\n",
    { flag: "wx" },
  );
  return {
    session,
    results,
    ignoreProtection,
    outcomeWarnings: [...allocationWarnings, ...completionWarnings],
  };
}
export async function finishProof(
  root: string,
  sessionFile: string,
  execute: boolean,
  baseline?: PolicyBaseline,
): Promise<{
  manifest: ProofManifest;
  path: string;
  errors: string[];
  ignoreProtection: IgnoreProtection;
  outcomeWarnings: string[];
}> {
  if (!execute) throw new Error("Pass --execute to capture after evidence.");
  const session = readJson(root, sessionFile) as Session;
  if (
    !session ||
    typeof session !== "object" ||
    session.schemaVersion !== "0.1" ||
    !/^[a-f0-9-]{36}$/.test(session.id) ||
    !Array.isArray(session.results)
  )
    throw new Error("Malformed proof session.");
  const { digest: stored, ...content } = session;
  if (digest(JSON.stringify(content)) !== stored)
    throw new Error(
      "Proof session modified; preserve original before evidence and plan.",
    );
  if (baseline && !session.plan?.policyBaseline)
    throw new Error(
      "Protected finish requires the baseline selected at proof start; a candidate-only session cannot acquire pre-change trust at finish. Start a new protected workflow from the known pre-change source.",
    );
  const plan = validatedPlan(root, session.plan, baseline);
  if (plan.category !== "bug" && plan.category !== "refactor")
    throw new Error("Proof session category requires bug/refactor.");
  const config = readConfig(root);
  const expected = `${config.proof.evidenceDir}/${session.id}/session.json`;
  if (safePath(root, sessionFile) !== safePath(root, expected))
    throw new Error("Session must remain in its original configured evidence directory.");
  const before = plan.steps.filter((step) => step.phase === "before");
  if (session.results.length !== before.length)
    throw new Error("Before evidence must match the original planned baseline steps.");
  const baselineLogs = session.results.map((result, index) => {
    const step = before[index]!;
    if (
      !result ||
      !(["phase", "command", "target", "expectExitCode", "criterion"] as const).every(
        (key) => result[key] === step[key],
      ) ||
      result.exitCode !== step.expectExitCode ||
      JSON.stringify(result.argv) !==
        JSON.stringify(resolveCommand(config, step.command, step.target).argv)
    )
      throw new Error(
        "Before evidence scenario/argv no longer matches its planned configured command.",
      );
    if (!result.log.startsWith(`${config.proof.evidenceDir}/${session.id}/`))
      throw new Error(
        "Before evidence log must remain in its original session directory.",
      );
    const text = readFileSync(safePath(root, result.log));
    if (digest(text) !== result.sha256)
      throw new Error("Before evidence log was modified.");
    return text;
  });

  // Reserve an immutable attempt before any command can cause side effects.
  const id = randomUUID(),
    createdAt = new Date().toISOString();
  const directory = `${config.proof.evidenceDir}/${id}`;
  mkdirSync(safePath(root, config.proof.evidenceDir), { recursive: true });
  mkdirSync(safePath(root, directory));
  const allocationWarnings = collectPlanLifecycle(
    root,
    plan,
    { kind: "proof-allocated", attemptId: id },
    id,
    createdAt,
  );
  const copied = session.results.map((result, index) => ({
    ...result,
    log: `${directory}/${String(index).padStart(3, "0")}-before.json`,
  }));
  writeFileSync(
    safePath(root, `${directory}/attempt.json`),
    JSON.stringify(
      {
        schemaVersion: "0.1",
        id,
        createdAt,
        session: expected,
        sessionDigest: stored,
        baseline: copied.map((result, index) => ({
          source: session.results[index]!.log,
          copy: result.log,
          sha256: result.sha256,
        })),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  for (const [index, result] of copied.entries())
    writeFileSync(safePath(root, result.log), baselineLogs[index]!, { flag: "wx" });
  const after = plan.steps.filter((step) => step.phase !== "before");
  const snapshot = requireChangeset(root, plan);
  const hashes = Object.fromEntries(
    plan.scope.map((scope) => [scope, changesetScopeHash(root, scope, snapshot)]),
  );
  const results = await capture(root, id, after, copied.length, plan, baseline);
  const result = finalize(
    root,
    plan,
    id,
    createdAt,
    [...copied, ...results],
    hashes,
    baseline,
    snapshot,
  );
  return {
    ...result,
    outcomeWarnings: [...allocationWarnings, ...result.outcomeWarnings],
  };
}
