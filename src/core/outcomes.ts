import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { evidenceIgnoreProtection } from "./evidence-ignore.js";
import { readConfig, repositoryPathsOverlap, scanFeatures } from "./config.js";
import { safePath } from "./files.js";
import { validate } from "./schema.js";
import type { ProofPlan, Risk } from "./types.js";

export const outcomeMetrics = [
  "firstPassVerification",
  "humanInterventions",
  "reviewRejected",
  "reverted",
  "escapedDefects",
  "architectureGateFailures",
  "verificationCompleteness",
  "activeSeconds",
  "durationSeconds",
  "cost",
] as const;
export type OutcomeMetric = (typeof outcomeMetrics)[number];
export interface OutcomeRecord {
  schemaVersion: "0.2";
  id: string;
  task: string;
  category: ProofPlan["category"];
  risk: Risk;
  featureIds: string[];
  workflow: { id: string; model?: string };
  controls: { arrsVersion: string; sha256: string };
  recordedAt: string;
  source: { kind: "arrs-proof" | "arrs-work" | "maintainer"; ref: string };
  failureCategories: string[];
  kind: "lifecycle" | "observation";
  event?: {
    kind: "proof-allocated" | "proof-completed" | "review-attached" | "work-transition";
    attemptId?: string;
    phase?: "baseline" | "verification";
    status?: "passed" | "failed";
    from?: string;
    to?: string;
  };
  window?: { start: string; end: string };
  values?: Partial<Record<OutcomeMetric, boolean | number | null>>;
  supersedes?: string[];
}
export interface OutcomeFilters {
  workflow?: string;
  model?: string;
  category?: string;
  risk?: string;
  feature?: string;
  controls?: string;
  window?: string;
  start?: string;
  end?: string;
}
const directory = ".arrs/metrics/outcomes";
const maxRecordBytes = 65536;
const maxRecords = 10000;
export const outcomeDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const outcomeIdentity = (value: unknown): string =>
  outcomeDigest(canonical(value));
function validTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
export function validateOutcome(value: unknown): asserts value is OutcomeRecord {
  const errors = validate("outcome", value);
  if (errors.length) throw new Error(`Invalid outcome record: ${errors.join("; ")}`);
  const record = value as OutcomeRecord;
  if (!validTimestamp(record.recordedAt))
    throw new Error("Invalid outcome timestamp; use UTC ISO time.");
  if (record.kind === "observation") {
    const window = record.window!;
    if (
      !validTimestamp(window.start) ||
      !validTimestamp(window.end) ||
      Date.parse(window.start) >= Date.parse(window.end) ||
      Date.parse(window.end) > Date.parse(record.recordedAt)
    )
      throw new Error(
        "Observation requires an elapsed start/end window before recordedAt.",
      );
    if (record.source.kind !== "maintainer")
      throw new Error("Observations require explicit maintainer provenance.");
  } else if (record.source.kind === "maintainer")
    throw new Error("Lifecycle facts must originate at their ARRS owning boundary.");
}
function readRecord(root: string, file: string): OutcomeRecord {
  const path = safePath(root, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxRecordBytes)
    throw new Error("Outcome entry is not a bounded regular file.");
  const record: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateOutcome(record);
  if (!file.endsWith(`/${record.id}.json`))
    throw new Error("Outcome identity does not match its immutable filename.");
  return record;
}
function sameCohort(a: OutcomeRecord, b: OutcomeRecord): boolean {
  return (
    a.task === b.task &&
    a.category === b.category &&
    a.risk === b.risk &&
    canonical(a.workflow) === canonical(b.workflow) &&
    canonical(a.controls) === canonical(b.controls) &&
    canonical(a.featureIds) === canonical(b.featureIds)
  );
}
function validateHistory(records: OutcomeRecord[]): void {
  const replaced = new Set<string>();
  const sources = new Set<string>();
  const attempts = new Set<string>();
  for (const record of records) {
    if (record.kind !== "lifecycle") continue;
    const source = canonical([record.source.kind, record.source.ref, record.event!.kind]);
    if (sources.has(source))
      throw new Error(
        "Duplicate or conflicting lifecycle source identity in immutable history.",
      );
    sources.add(source);
    if (["proof-allocated", "proof-completed"].includes(record.event!.kind)) {
      const attempt = canonical([record.event!.kind, record.event!.attemptId]);
      if (attempts.has(attempt))
        throw new Error(
          "Duplicate or conflicting lifecycle attempt fact across cohorts.",
        );
      attempts.add(attempt);
    }
  }
  for (const record of records)
    for (const id of record.supersedes ?? []) {
      const previous = records.find((candidate) => candidate.id === id);
      if (
        !previous ||
        previous.kind !== "observation" ||
        !sameCohort(previous, record) ||
        Date.parse(previous.recordedAt) >= Date.parse(record.recordedAt) ||
        replaced.has(id)
      )
        throw new Error(
          "Corrupt outcome supersession history: missing, conflicting or non-earlier same-cohort observation.",
        );
      replaced.add(id);
    }
  const current = records.filter(
    (record) => record.kind === "observation" && !replaced.has(record.id),
  );
  for (const [index, record] of current.entries())
    for (const other of current.slice(index + 1))
      if (
        sameCohort(record, other) &&
        canonical(record.window) === canonical(other.window) &&
        Object.keys(record.values!).some((metric) => Object.hasOwn(other.values!, metric))
      )
        throw new Error(
          "Conflicting current metric/window observations require explicit supersession.",
        );
}
/** Read-only, validated inventory. Temporary files are uncommitted, never observations. */
export function readOutcomeRecords(root: string): OutcomeRecord[] {
  const path = safePath(root, directory);
  if (!existsSync(path)) return [];
  const entries = readdirSync(path).sort();
  if (entries.length > maxRecords)
    throw new Error(
      "Outcome inventory exceeds 10000 entries; archive locally before collecting.",
    );
  const records: OutcomeRecord[] = [];
  let bytes = 0;
  for (const name of entries) {
    safePath(root, `${directory}/${name}`);
    if (/^\.pending-[a-f0-9-]{36}$/.test(name) || name === ".observation-write-lock")
      continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw new Error(`Unexpected outcome inventory entry: ${name}`);
    bytes += lstatSync(safePath(root, `${directory}/${name}`)).size;
    if (bytes > 32 * 1024 * 1024)
      throw new Error("Outcome inventory exceeds 32 MiB; archive locally.");
    records.push(readRecord(root, `${directory}/${name}`));
  }
  validateHistory(records);
  return records.sort(
    (a, b) =>
      Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id),
  );
}
/** Atomic exclusive publication: concurrent identical IDs are no-ops; conflicts fail. */
function publishOutcome(
  root: string,
  record: OutcomeRecord,
): { recorded: boolean; path: string } {
  validateOutcome(record);
  const text = canonical(record) + "\n";
  if (Buffer.byteLength(text) > maxRecordBytes)
    throw new Error("Outcome record exceeds 64 KiB.");
  const existing = readOutcomeRecords(root);
  validateHistory([...existing.filter((item) => item.id !== record.id), record]);
  if (existing.length >= maxRecords)
    throw new Error("Outcome inventory is full; archive locally first.");
  evidenceIgnoreProtection(root, directory);
  mkdirSync(safePath(root, ".arrs/metrics"), { recursive: true, mode: 0o700 });
  mkdirSync(safePath(root, directory), { recursive: true, mode: 0o700 });
  const path = `${directory}/${record.id}.json`;
  const temporary = `${directory}/.pending-${randomUUID()}`;
  let handle: number | undefined;
  try {
    handle = openSync(safePath(root, temporary), "wx", 0o600);
    writeFileSync(handle, text);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    try {
      linkSync(safePath(root, temporary), safePath(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (canonical(readRecord(root, path)) !== canonical(record))
        throw new Error("Conflicting outcome idempotency key; retained payload differs.");
      return { recorded: false, path };
    }
    const parent = openSync(safePath(root, directory), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return { recorded: true, path };
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(safePath(root, temporary))) unlinkSync(safePath(root, temporary));
  }
}
export function appendOutcome(
  root: string,
  record: OutcomeRecord,
): { recorded: boolean; path: string } {
  validateOutcome(record);
  if (record.kind === "lifecycle") return publishOutcome(root, record);
  evidenceIgnoreProtection(root, directory);
  mkdirSync(safePath(root, directory), { recursive: true, mode: 0o700 });
  const lockPath = safePath(root, `${directory}/.observation-write-lock`);
  let handle: number | undefined;
  for (let retry = 0; retry < 50; retry++) {
    try {
      handle = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Bounded synchronous contention wait; stale locks are never silently removed.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (handle === undefined)
    throw new Error(
      "Observation writer lock retained; retry or confirm no active writer before explicitly removing an interrupted lock.",
    );
  try {
    return publishOutcome(root, record);
  } finally {
    closeSync(handle);
    unlinkSync(lockPath);
  }
}

/** Minimal automatic context; supplied workflow/model observations remain separate cohorts. */
export function outcomeContext(
  root: string,
  plan: Pick<ProofPlan, "task" | "category" | "risk" | "scope">,
): Pick<
  OutcomeRecord,
  "task" | "category" | "risk" | "featureIds" | "workflow" | "controls"
> {
  const config = readConfig(root);
  const maps = scanFeatures(root, config);
  if (maps.errors.length)
    throw new Error(`Cannot collect outcome context: ${maps.errors.join("; ")}`);
  const featureIds = maps.features
    .filter((map) =>
      [...map.implementation, ...map.entryPoints].some((path) =>
        plan.scope.some((scope) => repositoryPathsOverlap(root, path, scope)),
      ),
    )
    .map((map) => map.id)
    .sort();
  const controls = outcomeDigest(
    canonical({
      config,
      policy: readFileSync(safePath(root, config.riskPolicy), "utf8"),
      architecture: readFileSync(safePath(root, config.architecture.policy), "utf8"),
      features: maps.features,
    }),
  );
  return {
    task: plan.task,
    category: plan.category,
    risk: plan.risk,
    featureIds,
    workflow: { id: "arrs-local" },
    controls: { arrsVersion: "0.1.0", sha256: controls },
  };
}
/** Collector errors are observable without changing canonical proof/work results. */
export function collectLifecycle(
  root: string,
  context: ReturnType<typeof outcomeContext>,
  event: NonNullable<OutcomeRecord["event"]>,
  sourceIdentity: string,
  timestamp: string,
  failureCategories: string[] = [],
): string[] {
  try {
    const source = {
      kind:
        event.kind === "work-transition"
          ? ("arrs-work" as const)
          : ("arrs-proof" as const),
      ref: outcomeDigest(sourceIdentity),
    };
    const id = outcomeDigest(`${event.kind}\0${source.ref}`);
    const existing = readOutcomeRecords(root).find((record) => record.id === id);
    appendOutcome(root, {
      schemaVersion: "0.2",
      id,
      ...context,
      recordedAt: existing?.recordedAt ?? timestamp,
      source,
      failureCategories,
      kind: "lifecycle",
      event,
    });
    return [];
  } catch (error) {
    return [
      `Outcome collection incomplete: ${error instanceof Error ? error.message : String(error)}. Canonical proof/work artifacts retain their own result; retry collection using the same source identity.`,
    ];
  }
}

export function collectPlanLifecycle(
  root: string,
  plan: Pick<ProofPlan, "task" | "category" | "risk" | "scope">,
  event: NonNullable<OutcomeRecord["event"]>,
  sourceIdentity: string,
  timestamp: string,
  failureCategories: string[] = [],
): string[] {
  try {
    return collectLifecycle(
      root,
      outcomeContext(root, plan),
      event,
      sourceIdentity,
      timestamp,
      failureCategories,
    );
  } catch (error) {
    return [
      `Outcome collection incomplete: ${error instanceof Error ? error.message : String(error)}. Canonical proof/work results are unchanged.`,
    ];
  }
}

export function observeOutcome(
  root: string,
  value: unknown,
): { recorded: boolean; path: string } {
  validateOutcome(value);
  if (value.kind !== "observation")
    throw new Error("metrics observe accepts explicit observations only.");
  const records = readOutcomeRecords(root);
  for (const id of value.supersedes ?? []) {
    const previous = records.find((record) => record.id === id);
    if (
      !previous ||
      previous.kind !== "observation" ||
      !sameCohort(previous, value) ||
      Date.parse(previous.recordedAt) >= Date.parse(value.recordedAt)
    )
      throw new Error(
        "Supersession requires an earlier observation for the same task and exact cohort.",
      );
    if (
      records.some((record) => record.id !== value.id && record.supersedes?.includes(id))
    )
      throw new Error(
        "Observation already superseded; supersede its current replacement.",
      );
  }
  const replaced = new Set(records.flatMap((record) => record.supersedes ?? []));
  for (const previous of records) {
    if (
      previous.id === value.id ||
      previous.kind !== "observation" ||
      replaced.has(previous.id) ||
      !sameCohort(previous, value) ||
      canonical(previous.window) !== canonical(value.window)
    )
      continue;
    if (
      Object.keys(value.values!).some((metric) =>
        Object.hasOwn(previous.values!, metric),
      ) &&
      !value.supersedes?.includes(previous.id)
    )
      throw new Error(
        "Overlapping metric/window update requires explicit supersession of the prior observation.",
      );
  }
  return appendOutcome(root, value);
}

function comparableWindow(filters: OutcomeFilters): {
  start?: number;
  end?: number;
  duration?: number;
} {
  if (filters.window && (filters.start || filters.end))
    throw new Error("Select --window or --start/--end, not both.");
  if (filters.window) {
    const match = /^([1-9][0-9]{0,3})d$/.exec(filters.window);
    if (!match)
      throw new Error("--window must be a positive number of days, for example 14d.");
    return { duration: Number(match[1]) * 86400000 };
  }
  if (Boolean(filters.start) !== Boolean(filters.end))
    throw new Error("Supply both --start and --end.");
  if (filters.start && filters.end) {
    if (
      !validTimestamp(filters.start) ||
      !validTimestamp(filters.end) ||
      Date.parse(filters.start) >= Date.parse(filters.end)
    )
      throw new Error("Invalid comparable observation window.");
    return { start: Date.parse(filters.start), end: Date.parse(filters.end) };
  }
  return {};
}
export function summarizeOutcomes(root: string, filters: OutcomeFilters = {}): unknown {
  const records = readOutcomeRecords(root);
  const window = comparableWindow(filters);
  const excluded: Record<string, number> = {
    cohort: 0,
    superseded: 0,
    incompatibleWindow: 0,
  };
  const superseded = new Set(records.flatMap((record) => record.supersedes ?? []));
  const selected = records.filter((record) => {
    const matches =
      (!filters.workflow || filters.workflow === record.workflow.id) &&
      (!filters.model || filters.model === record.workflow.model) &&
      (!filters.category || filters.category === record.category) &&
      (!filters.risk || filters.risk === record.risk) &&
      (!filters.feature || record.featureIds.includes(filters.feature)) &&
      (!filters.controls || filters.controls === record.controls.sha256);
    if (!matches) {
      excluded.cohort!++;
      return false;
    }
    if (superseded.has(record.id)) {
      excluded.superseded!++;
      return false;
    }
    return true;
  });
  const key = (record: OutcomeRecord) =>
    canonical({
      task: record.task,
      workflow: record.workflow,
      category: record.category,
      risk: record.risk,
      features: record.featureIds,
      controls: record.controls,
    });
  const groups = new Map<string, OutcomeRecord[]>();
  for (const record of selected)
    groups.set(key(record), [...(groups.get(key(record)) ?? []), record]);
  const metrics = Object.fromEntries(
    outcomeMetrics.map((metric) => [
      metric,
      {
        known: 0,
        unknown: 0,
        positive: 0,
        total: 0,
        rate: null as number | null,
        average: null as number | null,
      },
    ]),
  );
  let attempts = 0,
    incompleteAttempts = 0,
    passedAttempts = 0,
    completedTasks = 0,
    coveredTasks = 0;
  for (const group of groups.values()) {
    const allocations = group.filter(
      (record) =>
        record.event?.kind === "proof-allocated" && record.event.phase !== "baseline",
    );
    const completions = group.filter(
      (record) =>
        record.event?.kind === "proof-completed" && record.event.phase !== "baseline",
    );
    const attemptIds = new Set(
      [...allocations, ...completions].map((record) => record.event!.attemptId),
    );
    attempts += attemptIds.size;
    incompleteAttempts += [...attemptIds].filter(
      (id) => !completions.some((record) => record.event?.attemptId === id),
    ).length;
    passedAttempts += new Set(
      completions
        .filter((record) => record.event?.status === "passed")
        .map((record) => record.event!.attemptId),
    ).size;
    if (
      group.some(
        (record) =>
          record.event?.kind === "work-transition" && record.event.to === "completed",
      )
    )
      completedTasks++;
    const observations = group.filter((record) => {
      if (record.kind !== "observation") return false;
      const start = Date.parse(record.window!.start),
        end = Date.parse(record.window!.end);
      const compatible =
        (!window.duration || end - start === window.duration) &&
        (window.start === undefined || (start === window.start && end === window.end));
      if (!compatible) excluded.incompatibleWindow!++;
      return compatible;
    });
    if (observations.length) coveredTasks++;
    for (const metric of outcomeMetrics) {
      const candidates = observations.filter((record) =>
        Object.hasOwn(record.values!, metric),
      );
      let value = candidates.at(-1)?.values?.[metric];
      if (
        !filters.window &&
        !filters.start &&
        new Set(candidates.map((record) => canonical(record.window))).size > 1
      )
        value = undefined;
      // Without a follow-up-window request, the actual first allocated attempt establishes first pass.
      if (
        value === undefined &&
        metric === "firstPassVerification" &&
        !filters.window &&
        !filters.start
      ) {
        const first = allocations[0];
        value = first
          ? completions.find(
              (record) => record.event?.attemptId === first.event?.attemptId,
            )?.event?.status === "passed"
          : undefined;
        if (
          first &&
          !completions.some(
            (record) => record.event?.attemptId === first.event?.attemptId,
          )
        )
          value = undefined;
      }
      const result = metrics[metric]!;
      if (value === undefined || value === null) {
        result.unknown++;
        continue;
      }
      result.known++;
      const numeric = typeof value === "boolean" ? Number(value) : value;
      result.total += numeric;
      if (numeric > 0) result.positive++;
    }
  }
  for (const result of Object.values(metrics)) {
    result.rate = result.known ? result.positive / result.known : null;
    result.average = result.known ? result.total / result.known : null;
  }
  const inventory = existsSync(safePath(root, directory))
    ? readdirSync(safePath(root, directory))
    : [];
  const pending = inventory.filter((name) => name.startsWith(".pending-")).length;
  const cohorts = [
    ...new Set(
      selected.map((record) =>
        canonical({
          workflow: record.workflow,
          category: record.category,
          risk: record.risk,
          controls: record.controls,
        }),
      ),
    ),
  ]
    .sort()
    .map((item) => JSON.parse(item) as unknown);
  return {
    schemaVersion: "0.2",
    tasks: groups.size,
    attempts,
    incompleteAttempts,
    passedAttempts,
    completedTasks,
    events: selected.length,
    metrics,
    filters,
    observationWindow:
      filters.window ??
      (filters.start
        ? { start: filters.start, end: filters.end }
        : "unspecified; explicit observations retain their own windows"),
    windowCoverage: { known: coveredTasks, unknown: groups.size - coveredTasks },
    excluded,
    cohorts,
    observedWindows: [
      ...new Set(
        selected
          .filter((record) => record.window)
          .map((record) => canonical(record.window)),
      ),
    ]
      .sort()
      .map((item) => JSON.parse(item) as unknown),
    uncommittedTemporaryFiles: pending,
    retainedObservationWriterLock: inventory.includes(".observation-write-lock"),
    limitations: [
      "Local descriptive observations do not establish causal benefit, authenticated identity, approval or permission.",
      ...(groups.size < 30 ? ["Small sample: fewer than 30 task/cohort units."] : []),
      ...(cohorts.length > 1
        ? ["Multiple control/workflow/risk cohorts; compare separately using filters."]
        : []),
    ],
  };
}
export function previewOutcomeExport(root: string): unknown {
  return {
    schemaVersion: "0.2",
    preview: true,
    telemetrySent: false,
    records: readOutcomeRecords(root),
    limitation:
      "Task/workflow/model/category aliases are supplied locally; inspect aliases before sharing. Source references are digests; no source, logs, review text or personal reviewer names are exported.",
  };
}
