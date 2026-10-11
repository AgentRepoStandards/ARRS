import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { readJson, safePath } from "../core/files.js";
import { validate } from "../core/schema.js";
import { evidenceIgnoreProtection } from "../core/evidence-ignore.js";
import { summarizeOutcomes, type OutcomeFilters } from "../core/outcomes.js";
interface Event {
  risk: string;
  scopeSize: number;
  outcome: {
    firstPassVerification: boolean;
    humanInterventions: number;
    reviewRejected: boolean;
    reverted: boolean;
    escapedDefects: number;
    architectureGateFailures: number;
    verificationCompleteness: number;
  };
  failureCategories: string[];
}
export interface LegacyMetricEvent extends Event {
  schemaVersion: "0.1";
  id: string;
  task: string;
  category: string;
  workflow: { id: string; model?: string; agent?: string };
  recordedAt: string;
}
export function readLegacyMetrics(root: string): LegacyMetricEvent[] {
  const path = safePath(root, ".arrs/metrics/events.jsonl");
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new Error("Legacy metrics exceed bounded regular-file storage.");
  const text = readFileSync(path, "utf8");
  if (text && !text.endsWith("\n"))
    throw new Error(
      "Interrupted trailing legacy metric; retain the file and repair explicitly before summarizing.",
    );
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > 10000)
    throw new Error("Legacy metrics exceed 10000 records; archive locally.");
  const ids = new Set<string>();
  return lines.map((line) => {
    const value = JSON.parse(line) as { id: string; recordedAt: string };
    const errors = validate("metrics", value);
    if (errors.length || !Number.isFinite(Date.parse(value.recordedAt)))
      throw new Error(`Invalid stored metric: ${errors.join("; ")}`);
    if (ids.has(value.id)) throw new Error("Duplicate stored legacy metric identity.");
    ids.add(value.id);
    return value as unknown as LegacyMetricEvent;
  });
}
export function recordMetric(
  root: string,
  file: string,
): { path: string; recorded: boolean } {
  const value = readJson(root, file),
    errors = validate("metrics", value);
  if (errors.length) throw new Error(`Invalid metrics event: ${errors.join("; ")}`);
  if (!Number.isFinite(Date.parse((value as { recordedAt: string }).recordedAt)))
    throw new Error("Metric recordedAt must be a valid timestamp.");
  const path = ".arrs/metrics/events.jsonl",
    absolute = safePath(root, path);
  evidenceIgnoreProtection(root, ".arrs/metrics");
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const lock = safePath(root, ".arrs/metrics/.legacy-write-lock");
  let locked: number;
  try {
    locked = openSync(lock, "wx", 0o600);
  } catch (error) {
    throw new Error(
      `Legacy metrics writer lock unavailable; retry or inspect a retained interrupted lock: ${String(error)}`,
    );
  }
  try {
    const events = readLegacyMetrics(root);
    if (
      events.some(
        (event) =>
          (event as unknown as { id: string }).id === (value as { id: string }).id,
      )
    )
      throw new Error("Metric event id already recorded; use a distinct outcome event.");
    if (events.length >= 10000) throw new Error("Legacy metric inventory is full.");
    const handle = openSync(absolute, "a", 0o600);
    try {
      appendFileSync(handle, JSON.stringify(value) + "\n");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } finally {
    closeSync(locked);
    unlinkSync(lock);
  }
  return { path, recorded: true };
}
export function summarizeMetrics(root: string, filters: OutcomeFilters = {}): unknown {
  const events = readLegacyMetrics(root);
  const n = events.length;
  const rate = (predicate: (event: Event) => boolean): number | null =>
    n ? events.filter(predicate).length / n : null;
  const failures = new Map<string, number>();
  for (const event of events)
    for (const category of event.failureCategories)
      failures.set(category, (failures.get(category) ?? 0) + 1);
  return {
    schemaVersion: "0.1",
    events: n,
    firstPassVerificationRate: rate((event) => event.outcome.firstPassVerification),
    humanInterventionRate: rate((event) => event.outcome.humanInterventions > 0),
    reviewRejectionRate: rate((event) => event.outcome.reviewRejected),
    revertRate: rate((event) => event.outcome.reverted),
    escapedDefects: events.reduce((sum, event) => sum + event.outcome.escapedDefects, 0),
    architectureGateFailures: events.reduce(
      (sum, event) => sum + event.outcome.architectureGateFailures,
      0,
    ),
    verificationCompleteness: n
      ? events.reduce((sum, event) => sum + event.outcome.verificationCompleteness, 0) / n
      : null,
    averageScopeSize: n
      ? events.reduce((sum, event) => sum + event.scopeSize, 0) / n
      : null,
    byRisk: Object.fromEntries(
      ["R0", "R1", "R2", "R3", "R4"].map((risk) => [
        risk,
        events.filter((event) => event.risk === risk).length,
      ]),
    ),
    failureCategories: Object.fromEntries(failures),
    lifecycle: summarizeOutcomes(root, filters),
    legacyLimitations:
      "v0.1 rates retain their recorded-event denominator; no observation windows are invented. Cohort filters apply to the lifecycle result only.",
  };
}
