import { existsSync } from "node:fs";
import {
  policyRequirements,
  requirePolicyBaseline,
  samePolicyBaseline,
} from "./policy-baseline.js";
import { validateEvidence, validateAcceptedEvidence } from "./evidence.js";
import { readJson, safePath } from "./files.js";
import { validate } from "./schema.js";
import type { ProofManifest, Risk, PolicyBaseline } from "./types.js";

export interface WorkItem {
  schemaVersion: "0.1";
  id: string;
  title: string;
  state:
    | "needs-triage"
    | "needs-information"
    | "ready-for-agent"
    | "in-progress"
    | "verification-failed"
    | "ready-for-review"
    | "human-required"
    | "completed"
    | "rejected";
  risk: Risk;
  category: "bug" | "feature" | "refactor" | "docs";
  featureIds: string[];
  acceptance: string[];
  context: string[];
  verificationTargets: string[];
  dependencies: string[];
  decisions: string[];
  proof?: string;
  policyBaseline?: PolicyBaseline;
  authorization?: { humanApproval: string };
  review?: { independent: string; humanApproval?: string };
}

/** Shared readiness/completion policy used by both audit and transition mutation. */
export function validateWorkItem(
  root: string,
  value: unknown,
  baseline?: PolicyBaseline,
): string[] {
  const errors = validate("work-item", value);
  if (errors.length) return errors;
  const item = value as WorkItem;
  try {
    requirePolicyBaseline(item.policyBaseline, baseline);
    const requirements = policyRequirements(root, item.context, item.risk, baseline);
    const { config, policy } = requirements;
    const maps = { features: requirements.features };
    for (const id of item.featureIds) {
      const map = maps.features.find((feature) => feature.id === id);
      const previous = requirements.baselineFeatures.find((feature) => feature.id === id);
      if (previous) {
        if (item.risk < previous.risk)
          errors.push(`Work risk is below baseline feature ${id} risk ${previous.risk}`);
        if (!item.verificationTargets.includes(previous.verification.target))
          errors.push(
            `Work omits baseline feature ${id} verification target ${previous.verification.target}`,
          );
        requirements.assertCommand("verify", previous.verification.target);
      }
      if (!map) errors.push(`Unknown feature ${id}`);
      else {
        if (item.risk < map.risk)
          errors.push(`Work risk is below feature ${id} risk ${map.risk}`);
        if (!item.verificationTargets.includes(map.verification.target))
          errors.push(
            `Work omits feature ${id} verification target ${map.verification.target}`,
          );
      }
    }
    for (const context of item.context)
      if (!existsSync(safePath(root, context))) errors.push(`Missing context ${context}`);
    for (const target of item.verificationTargets)
      if (!Object.hasOwn(config.verifyTargets, target))
        errors.push(`Unknown verification target ${target}`);
      else requirements.assertCommand("verify", target);
    for (const target of requirements.verificationTargets)
      if (!item.verificationTargets.includes(target))
        errors.push(`Work omits protected mapped verification target ${target}`);
    if (requirements.risk > item.risk)
      errors.push("Work risk is lower than context scope requires");
    if (
      ["ready-for-agent", "in-progress", "ready-for-review", "completed"].includes(
        item.state,
      ) &&
      (item.dependencies.length || item.decisions.length)
    )
      errors.push("Resolve dependencies and decisions before executable/reviewable work");
    if (
      item.state === "ready-for-agent" &&
      (item.risk === "R4" || (baseline && policy.autonomy === "human"))
    )
      errors.push(
        item.risk === "R4"
          ? "R4 cannot be ready for an autonomous agent in v0.1; route to human-required"
          : `${item.risk} human autonomy cannot be ready for an autonomous agent in v0.1; route to human-required`,
      );
    if (
      ["ready-for-agent", "in-progress"].includes(item.state) &&
      policy.humanApproval &&
      (item.authorization?.humanApproval ?? item.review?.humanApproval ?? "").trim()
        .length < 12
    )
      errors.push(`${item.risk} requires human approval before execution`);
    if (["ready-for-review", "completed"].includes(item.state)) {
      if (!item.proof) errors.push("Passing proof required");
      else {
        const proof = readJson(root, item.proof);
        const proofErrors =
          item.state === "completed"
            ? validateAcceptedEvidence(root, item.proof, baseline)
            : validateEvidence(root, proof, baseline);
        errors.push(...proofErrors);
        if (!validate("proof", proof).length) {
          const manifest = proof as ProofManifest;
          if (!samePolicyBaseline(manifest.policyBaseline, item.policyBaseline))
            errors.push("Work and proof policy baseline binding mismatch");
          if (
            manifest.task !== item.id ||
            manifest.risk !== item.risk ||
            manifest.category !== item.category
          )
            errors.push("Proof task/risk/category mismatch");
          for (const criterion of item.acceptance)
            if (
              !manifest.acceptance.includes(criterion) ||
              !manifest.results.some(
                (result) =>
                  result.criterion === criterion &&
                  result.exitCode === 0 &&
                  result.expectExitCode === 0 &&
                  result.phase !== "before",
              )
            )
              errors.push(`Work acceptance lacks passing proof criterion: ${criterion}`);
          for (const target of item.verificationTargets)
            if (
              !manifest.results.some(
                (result) =>
                  result.command === "verify" &&
                  result.target === target &&
                  result.exitCode === 0 &&
                  result.expectExitCode === 0 &&
                  result.phase !== "before",
              )
            )
              errors.push(`Work target lacks passing verification evidence: ${target}`);
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
