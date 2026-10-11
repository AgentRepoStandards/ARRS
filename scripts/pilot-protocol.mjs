// Opt-in, read-only application-pilot observations. Never executes project commands.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { safePath } from "../dist/core/files.js";
import { readConfig } from "../dist/core/config.js";
import { validate } from "../dist/core/schema.js";
import { validateEvidence, validateAcceptedEvidence } from "../dist/core/evidence.js";

const args = process.argv.slice(2);
const ledgerPath = args.shift();
let root = process.cwd();
let exportRequested = false;
let baseline;
const options = new Set();
try {
  if (!ledgerPath) throw new Error("Supply a repository-relative pilot ledger path");
  while (args.length) {
    const option = args.shift();
    if (options.has(option)) throw new Error(`Duplicate option ${option}`);
    options.add(option);
    if (option === "--root" && args[0]) root = resolve(args.shift());
    else if (option === "--export") exportRequested = true;
    else if (option === "--baseline" && args[0]) {
      baseline = { ...baseline, root: args.shift() };
    } else if (option === "--baseline-sha256" && args[0]) {
      baseline = { ...baseline, sha256: args.shift() };
    } else throw new Error(`Unknown or incomplete option ${option}`);
  }
  if (baseline && (!baseline.root || !/^[a-f0-9]{64}$/.test(baseline.sha256)))
    throw new Error("Supply both independently selected baseline options");
  const path = safePath(root, ledgerPath);
  if (statSync(path).size > 1024 * 1024) throw new Error("Ledger exceeds 1 MiB bound");
  const bytes = readFileSync(path);
  const ledger = JSON.parse(bytes);
  const fields = (object, required, label) => {
    if (!object || typeof object !== "object" || Array.isArray(object))
      throw new Error(`${label}: expected object`);
    if (
      Object.keys(object).some((key) => !required.includes(key)) ||
      required.some((key) => !Object.hasOwn(object, key))
    )
      throw new Error(`${label}: exact fields required: ${required.join(", ")}`);
  };
  const oneOf = (value, values, label) => {
    if (!values.includes(value)) throw new Error(`${label}: unsupported value`);
  };
  const id = (value, label) => {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
      throw new Error(`${label}: use a bounded pseudonymous lowercase identifier`);
  };
  const count = (value, label, nullable = false) => {
    if (nullable && value === null) return;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(
        `${label}: expected nonnegative integer${nullable ? " or null" : ""}`,
      );
  };
  const list = (value, label) => {
    if (!Array.isArray(value) || value.length > 1000)
      throw new Error(`${label}: expected bounded array`);
  };
  const repositoryPath = (value, label) => {
    if (typeof value !== "string" || !value || value === ".")
      throw new Error(`${label}: expected explicit repository path`);
    safePath(root, value);
  };
  fields(
    ledger,
    [
      "protocolVersion",
      "kind",
      "studyId",
      "targetTaskCount",
      "hostedCI",
      "pilots",
      "tasks",
      "comparisons",
    ],
    "ledger",
  );
  oneOf(ledger.protocolVersion, ["pilot-0.1"], "protocolVersion");
  oneOf(ledger.kind, ["control-fixture", "application-study"], "kind");
  id(ledger.studyId, "studyId");
  count(ledger.targetTaskCount, "targetTaskCount");
  oneOf(ledger.hostedCI, ["manual-disabled", "not-evaluated"], "hostedCI");
  list(ledger.pilots, "pilots");
  list(ledger.tasks, "tasks");
  list(ledger.comparisons, "comparisons");
  const pilots = new Map();
  for (const pilot of ledger.pilots) {
    fields(pilot, ["id", "context", "recruitment", "authorizationReference"], "pilot");
    id(pilot.id, "pilot.id");
    if (pilots.has(pilot.id)) throw new Error("Duplicate pilot identity");
    oneOf(
      pilot.context,
      ["established", "smaller-newer", "legacy-other-language"],
      "pilot.context",
    );
    oneOf(pilot.recruitment, ["outstanding", "authorized"], "pilot.recruitment");
    if (pilot.authorizationReference !== null)
      id(pilot.authorizationReference, "authorizationReference");
    if ((pilot.recruitment === "authorized") !== (pilot.authorizationReference !== null))
      throw new Error(
        "Authorized pilots require a private inventory authorization reference",
      );
    pilots.set(pilot.id, pilot);
  }
  const metrics = [
    "setupActiveSeconds",
    "contextInterventions",
    "firstPassVerification",
    "verificationRetries",
    "reviewActiveSeconds",
    "reviewRejected",
    "reverted",
    "escapedDefects",
    "elapsedSeconds",
  ];
  const booleans = ["firstPassVerification", "reviewRejected", "reverted"];
  const confounders = [
    "different-size",
    "different-maintainer",
    "different-tools",
    "learning-order",
    "interrupted",
    "parallel-work",
    "scope-changed",
    "other-recorded-privately",
  ];
  const tasks = new Map();
  const evidence = [];
  for (const task of ledger.tasks) {
    fields(
      task,
      [
        "id",
        "pilotId",
        "category",
        "risk",
        "scope",
        "workflow",
        "inclusion",
        "selectionReason",
        "tools",
        "observationWindow",
        "observations",
        "confounders",
        "taskReference",
        "attempts",
        "selectedAttempt",
        "metricsReferences",
      ],
      "task",
    );
    id(task.id, "task.id");
    if (tasks.has(task.id)) throw new Error("Duplicate task identity");
    const pilot = pilots.get(task.pilotId);
    if (!pilot) throw new Error("Unknown task pilot");
    if (ledger.kind === "application-study" && pilot.recruitment !== "authorized")
      throw new Error(
        "Application observations require an authorized actual pilot inventory",
      );
    oneOf(task.category, ["feature", "bug", "refactor", "docs"], "category");
    oneOf(task.risk, ["R0", "R1", "R2", "R3", "R4"], "risk");
    oneOf(task.workflow, ["baseline", "arrs-assisted"], "workflow");
    oneOf(task.inclusion, ["included", "excluded"], "inclusion");
    oneOf(
      task.selectionReason,
      [
        "eligible",
        "no-access",
        "out-of-scope",
        "no-comparable-baseline",
        "missing-observations",
      ],
      "selectionReason",
    );
    if ((task.inclusion === "included") !== (task.selectionReason === "eligible"))
      throw new Error(
        "Included tasks must record eligibility; excluded tasks need a reason",
      );
    list(task.scope, "scope");
    if (!task.scope.length) throw new Error("Task scope must be explicit");
    for (const path of task.scope) repositoryPath(path, "scope");
    list(task.tools, "tools");
    for (const tool of task.tools) id(tool, "tool");
    list(task.confounders, "confounders");
    for (const confounder of task.confounders)
      oneOf(confounder, confounders, "confounder");
    fields(
      task.observationWindow,
      ["plannedDays", "completedDays", "complete"],
      "observationWindow",
    );
    count(task.observationWindow.plannedDays, "plannedDays");
    count(task.observationWindow.completedDays, "completedDays");
    if (
      typeof task.observationWindow.complete !== "boolean" ||
      task.observationWindow.completedDays > task.observationWindow.plannedDays ||
      (task.observationWindow.complete &&
        task.observationWindow.completedDays !== task.observationWindow.plannedDays)
    )
      throw new Error(
        "Observation window must disclose completed days and truthful completeness",
      );
    fields(task.observations, metrics, "observations");
    for (const metric of metrics) {
      const value = task.observations[metric];
      if (booleans.includes(metric)) {
        if (value !== null && typeof value !== "boolean")
          throw new Error(`${metric}: expected boolean or null`);
      } else count(value, metric, true);
    }
    if (
      !task.observationWindow.complete &&
      ["reverted", "escapedDefects"].some((metric) => task.observations[metric] !== null)
    )
      throw new Error(
        "Incomplete follow-up must leave final revert/defect outcomes unknown",
      );
    if (task.taskReference !== null) repositoryPath(task.taskReference, "taskReference");
    list(task.attempts, "attempts");
    list(task.metricsReferences, "metricsReferences");
    for (const reference of task.metricsReferences) id(reference, "metricsReference");
    if (task.selectedAttempt !== null && !task.attempts.includes(task.selectedAttempt))
      throw new Error("Selected attempt must appear in retained attempt history");
    if (new Set(task.attempts).size !== task.attempts.length)
      throw new Error("Duplicate attempt reference");
    for (const reference of task.attempts) {
      repositoryPath(reference, "attempt");
      const absolute = safePath(root, reference);
      if (statSync(absolute).size > 1024 * 1024)
        throw new Error("Proof exceeds read bound");
      const manifest = JSON.parse(readFileSync(absolute, "utf8"));
      if (validate("proof", manifest).length) throw new Error("Malformed proof manifest");
      const canonical = `${readConfig(root).proof.evidenceDir}/${manifest.id}/proof.json`;
      if (absolute !== safePath(root, canonical))
        throw new Error("Attempt must use canonical local proof location");
      if (
        manifest.task !== task.id ||
        manifest.category !== task.category ||
        manifest.risk !== task.risk ||
        JSON.stringify([...manifest.scope].sort()) !==
          JSON.stringify([...task.scope].sort())
      )
        throw new Error(
          "Proof task/category/risk/scope differs from observation identity",
        );
      const technicalErrors = validateEvidence(root, manifest, baseline);
      const acceptedErrors = validateAcceptedEvidence(root, reference, baseline);
      evidence.push({
        task: task.id,
        attempt: manifest.id,
        selected: reference === task.selectedAttempt,
        capturedStatus: manifest.status,
        technical: technicalErrors.length ? "invalid" : "valid",
        acceptance: acceptedErrors.length ? "pending-or-invalid" : "accepted",
        manifestSha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        commands: manifest.results.map((result) => ({
          command: result.command,
          targetSha256: result.target
            ? createHash("sha256").update(result.target).digest("hex")
            : null,
          phase: result.phase,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })),
      });
    }
    tasks.set(task.id, task);
  }
  const comparisons = ledger.comparisons.map((comparison) => {
    fields(comparison, ["baselineTask", "assistedTask"], "comparison");
    const before = tasks.get(comparison.baselineTask);
    const after = tasks.get(comparison.assistedTask);
    if (!before || !after) throw new Error("Comparison references an unknown task");
    const reasons = [];
    if (before.workflow !== "baseline" || after.workflow !== "arrs-assisted")
      reasons.push("workflow-mismatch");
    for (const field of ["pilotId", "category", "risk"])
      if (before[field] !== after[field]) reasons.push(`${field}-mismatch`);
    if (before.scope.length !== after.scope.length) reasons.push("scope-size-mismatch");
    if (
      before.observationWindow.plannedDays !== after.observationWindow.plannedDays ||
      before.observationWindow.complete !== after.observationWindow.complete ||
      before.observationWindow.completedDays !== after.observationWindow.completedDays
    )
      reasons.push("window-mismatch");
    if ([before, after].some((task) => task.inclusion !== "included"))
      reasons.push("excluded-task");
    if ([before, after].some((task) => task.confounders.length))
      reasons.push("recorded-confounders");
    return { ...comparison, status: reasons.length ? "excluded" : "comparable", reasons };
  });
  const included = [...tasks.values()].filter((task) => task.inclusion === "included");
  const observations = Object.fromEntries(
    metrics.map((metric) => {
      const values = included
        .map((task) => task.observations[metric])
        .filter((value) => value !== null);
      const total = values.reduce((sum, value) => sum + Number(value), 0);
      return [
        metric,
        {
          observed: values.length,
          missing: included.length - values.length,
          total: values.length ? total : null,
          mean: values.length ? total / values.length : null,
        },
      ];
    }),
  );
  const report = {
    protocolVersion: ledger.protocolVersion,
    kind: ledger.kind,
    studyId: ledger.studyId,
    ledgerSha256: createHash("sha256").update(bytes).digest("hex"),
    hostedCI: ledger.hostedCI,
    targetTaskCount: ledger.targetTaskCount,
    taskCount: tasks.size,
    includedTaskCount: included.length,
    excludedTaskCount: tasks.size - included.length,
    authorizedPilotCount: [...pilots.values()].filter(
      (pilot) => pilot.recruitment === "authorized",
    ).length,
    outstandingContexts: ["established", "smaller-newer", "legacy-other-language"].filter(
      (context) =>
        ![...pilots.values()].some(
          (pilot) => pilot.context === context && pilot.recruitment === "authorized",
        ),
    ),
    incompleteFollowUp: included
      .filter((task) => !task.observationWindow.complete)
      .map((task) => task.id),
    observations,
    comparisons,
    evidence,
    exportRequested,
    limitations: [
      "Self-reported observations; local proof is not authenticated execution.",
      "Control fixtures are not application findings.",
      "Observed denominators vary; missing data remains unknown.",
      "No causal or autonomy conclusion follows from this sample.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `Pilot protocol failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
