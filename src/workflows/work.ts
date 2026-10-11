import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { collectPlanLifecycle } from "../core/outcomes.js";
import { readJson, safePath } from "../core/files.js";
import { validate } from "../core/schema.js";
import { validateWorkItem, type WorkItem } from "../core/work.js";
import type { PolicyBaseline } from "../core/types.js";
import { requirePolicyBaseline } from "../core/policy-baseline.js";
import { requireLocalWorkProvider } from "../core/work-provider.js";
const transitions: Record<string, string[]> = {
  "needs-triage": ["needs-information", "ready-for-agent", "human-required", "rejected"],
  "needs-information": ["needs-triage", "ready-for-agent", "human-required", "rejected"],
  "ready-for-agent": ["in-progress", "needs-information", "human-required", "rejected"],
  "in-progress": [
    "verification-failed",
    "ready-for-review",
    "needs-information",
    "human-required",
  ],
  "verification-failed": ["in-progress", "human-required", "rejected"],
  "ready-for-review": ["completed", "in-progress", "human-required", "rejected"],
  "human-required": [
    "needs-triage",
    "ready-for-agent",
    "in-progress",
    "ready-for-review",
    "completed",
    "rejected",
  ],
  completed: [],
  rejected: [],
};
export function validateWork(
  root: string,
  file: string,
  baseline?: PolicyBaseline,
): string[] {
  requireLocalWorkProvider(root);
  return validateWorkItem(root, readJson(root, file), baseline);
}
export function transitionWork(
  root: string,
  file: string,
  state: string,
  baseline?: PolicyBaseline,
): WorkItem & { outcomeWarnings: string[] } {
  requireLocalWorkProvider(root);
  const value = readJson(root, file),
    errors = validate("work-item", value);
  if (errors.length) throw new Error(errors.join("; "));
  const item = value as WorkItem;
  if (!transitions[item.state]?.includes(state))
    throw new Error(`Invalid work transition ${item.state} -> ${state}.`);
  requirePolicyBaseline(item.policyBaseline, baseline);
  const proposed = {
    ...item,
    state,
    ...(baseline ? { policyBaseline: baseline } : {}),
  } as WorkItem;
  const invalid = validateWorkItem(root, proposed, baseline);
  if (invalid.length)
    throw new Error(`Cannot transition ${item.state} -> ${state}: ${invalid.join("; ")}`);
  writeFileSync(safePath(root, file), JSON.stringify(proposed, null, 2) + "\n");
  const outcomeWarnings = collectPlanLifecycle(
    root,
    { task: item.id, category: item.category, risk: item.risk, scope: item.context },
    { kind: "work-transition", from: item.state, to: state },
    randomUUID(),
    new Date().toISOString(),
  );
  return { ...proposed, outcomeWarnings };
}
