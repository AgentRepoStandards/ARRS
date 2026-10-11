import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { readConfig } from "../core/config.js";
import { safePath } from "../core/files.js";
import { evidenceIgnoreProtection } from "../core/evidence-ignore.js";
import {
  explainProof,
  containedProofLogs,
  readProofJson,
  type ProofExplanation,
} from "../core/proof-explanation.js";
import type { PolicyBaseline, ProofManifest } from "../core/types.js";

export interface ProofReportOptions {
  output: string;
  excerpts?: boolean;
  redaction?: "heuristic" | "none";
  baseline?: PolicyBaseline;
}
interface Excerpt {
  index: number;
  originalSha256: string;
  exportSha256: string;
  redaction: "heuristic" | "none";
  truncated: boolean;
  text: string;
}
const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const escape = (value: unknown): string =>
  String(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\uFFFD")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Best-effort display redaction, never canonical evidence modification or secret certification. */
export function redactProofExcerpt(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(
      /\b((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;"'<>]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[^]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

function render(report: ProofExplanation, excerpts: Excerpt[]): string {
  const list = (texts: string[]): string =>
    `<ul>${texts.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>`;
  const resultRows = report.steps
    .map(
      (step) =>
        `<tr id="step-${step.index}"><td>${step.index}</td><td>${escape(step.planned.phase)}</td><td>${escape(step.planned.command)} ${escape(step.planned.target ?? "")}</td><td>${escape(step.result?.exitCode ?? "missing")} / ${step.planned.expectExitCode}</td><td><code>${escape(JSON.stringify(step.result?.argv ?? []))}</code><br>Current binding: ${step.argvBound}</td><td><code>${escape(step.result?.log ?? "missing")}</code><br>SHA-256 ${escape(step.result?.sha256 ?? "missing")}</td></tr>`,
    )
    .join("");
  const criteria = report.acceptance
    .map(
      (criterion) =>
        `<li>${escape(criterion.criterion)} — ${criterion.satisfied ? "verified" : "unresolved"}; ${criterion.resultIndices.map((index) => `<a href="#step-${index}">result ${index}</a>`).join(", ") || "no successful scenario"}</li>`,
    )
    .join("");
  const baseline = report.baseline.map(
    (pair) =>
      `Before result ${pair.beforeIndex}: identical after argv ${pair.identicalArgv}; after results ${pair.afterIndices.join(", ") || "none"}`,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; img-src 'none'; connect-src 'none'"><title>Proof report: ${escape(report.task ?? report.path)}</title><style>body{font:16px system-ui,sans-serif;line-height:1.5;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#17202a;background:#fff}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:.5rem;vertical-align:top;text-align:left}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}h1,h2{line-height:1.2}aside{border:1px solid #bbb;padding:1rem;background:#f5f5f5}</style></head><body>
<h1>${escape(report.task ?? "Unreadable proof")}</h1><aside>Local preview. No upload, telemetry, scripts, remote assets, or network requests. Evidence and exported text may contain private information. Heuristic redaction can miss secrets; inspect this preview before choosing to share it. Local hashes and review records are not authenticated attestations.</aside>
<p>Attempt <code>${escape(report.id ?? "unknown")}</code>; ${escape(report.category ?? "unknown")}; ${escape(report.risk ?? "unknown")}; ${escape(report.policyMode)}.</p>
<p>Technical: <strong>${report.technical.valid ? "passed" : "invalid"}</strong>. Review: <strong>${escape(report.review.status)}</strong>. Accepted: <strong>${report.review.accepted}</strong>.</p>
<p>Manifest <code>${escape(report.path)}</code>; SHA-256 <code>${escape(report.manifestSha256 ?? "unavailable")}</code>.</p>
<h2>Acceptance criteria</h2><ul>${criteria}</ul><h2>Required checks</h2>${list(report.requiredChecks)}
<h2>Declared source scope</h2>${list(report.scope.map((scope) => `${scope.path} — ${scope.fresh === true ? "current" : scope.fresh === false ? "stale" : "unavailable"}; SHA-256 ${scope.sha256}`))}
<h2>Changeset coverage</h2><p>${escape(report.coverage.assurance)}</p>${report.coverage.snapshot ? `<pre>${escape(JSON.stringify(report.coverage.snapshot, null, 2))}</pre>` : "<p>Legacy proof establishes declared scope only; discovered changes and uncovered paths are unavailable.</p>"}
<h2>Ordered results</h2><table><thead><tr><th>Result</th><th>Phase</th><th>Command</th><th>Exit / expected</th><th>Argument vector</th><th>Original log</th></tr></thead><tbody>${resultRows}</tbody></table>
<h2>Retained baseline</h2>${list(baseline)}<h2>Implementation review</h2><p>Required independent review: ${escape(report.review.required?.independent ?? "unknown")}; human acceptance: ${escape(report.review.required?.humanApproval ?? "unknown")}.</p>${list(report.review.attachments.map((attachment) => `${attachment.path}: ${attachment.valid ? "valid binding" : attachment.errors.join("; ")}`))}
<h2>Diagnostics</h2>${list([...report.technical.errors, ...report.review.errors])}<h2>Residual risks</h2>${list(report.residualRisks)}<h2>Deviations</h2>${list(report.deviations)}<h2>Limits</h2>${list(report.limitations)}
<h2>Log privacy choices</h2>${excerpts.length ? excerpts.map((excerpt) => `<section><h3>Result ${excerpt.index} excerpt</h3><p>Redaction: ${escape(excerpt.redaction)}; truncated: ${excerpt.truncated}. Original bytes verified against SHA-256 <code>${escape(excerpt.originalSha256)}</code>. Exported excerpt SHA-256 <code>${escape(excerpt.exportSha256)}</code>. Original evidence remains unchanged.</p><pre>${escape(excerpt.text)}</pre></section>`).join("") : "<p>Raw logs omitted. Use --excerpts to request bounded excerpts; heuristic redaction is the default.</p>"}
<p><a href="explanation.json">Contained structured explanation</a></p></body></html>\n`;
}

/** Explicit local exclusive export, strictly outside canonical attempts and source. */
export function reportProof(
  root: string,
  input: string,
  options: ProofReportOptions,
): {
  directory: string;
  path: string;
  explanation: ProofExplanation;
  excerpts: boolean;
  redaction: "heuristic" | "none";
  ignoreProtection: ReturnType<typeof evidenceIgnoreProtection>;
} {
  if (options.redaction && !options.excerpts)
    throw new Error("--redaction requires explicit --excerpts");
  if (options.redaction && !["heuristic", "none"].includes(options.redaction))
    throw new Error("Redaction must be heuristic or none");
  const output = safePath(root, options.output);
  const reports = safePath(root, ".arrs/reports");
  const evidence = safePath(root, readConfig(root).proof.evidenceDir);
  const overlaps = (a: string, b: string): boolean =>
    a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  if (!output.startsWith(reports + sep) || overlaps(output, evidence))
    throw new Error(
      "Report output must be strictly below .arrs/reports and cannot overlap evidence or source",
    );
  if (existsSync(output))
    throw new Error(
      "Report output already exists; choose a new directory to preserve prior artifacts",
    );
  const explanation = explainProof(root, input, options.baseline);
  const manifest = readProofJson(root, input);
  // Even an invalid default report cannot follow an escaping log reference.
  if (
    manifest &&
    typeof manifest === "object" &&
    "results" in manifest &&
    Array.isArray(manifest.results) &&
    "id" in manifest &&
    typeof manifest.id === "string"
  ) {
    containedProofLogs(root, manifest as ProofManifest);
  }
  const excerpts: Excerpt[] = [];
  if (options.excerpts) {
    const value = readProofJson(root, input) as ProofManifest;
    // No partial or invalid proof may direct excerpt reads. Verify original bytes first.
    if (!explanation.technical.valid)
      throw new Error("Log excerpts require current canonical technical evidence");
    containedProofLogs(root, value);
    if (value.results.length > 100)
      throw new Error("At most 100 log excerpts may be exported");
    for (const [index, result] of value.results.entries()) {
      const bytes = readFileSync(safePath(root, result.log));
      if (digest(bytes) !== result.sha256)
        throw new Error("Original log hash changed before excerpt export");
      const log = JSON.parse(bytes.toString("utf8")) as {
        stdout: string;
        stderr: string;
      };
      const raw = `${log.stdout}\n${log.stderr}`;
      const redaction = options.redaction ?? "heuristic";
      // Redact the entire bounded original before truncation so partial key blocks are not exposed.
      const redacted = redaction === "heuristic" ? redactProofExcerpt(raw) : raw;
      const encoded = Buffer.from(redacted);
      let end = Math.min(encoded.length, 8192);
      // Keep the prefix on a complete UTF-8 boundary. Decoding a partial sequence
      // could otherwise add a replacement character exceeding the export limit.
      while (end < encoded.length && end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
      const bounded = encoded.subarray(0, end).toString("utf8");
      excerpts.push({
        index: index + 1,
        originalSha256: result.sha256,
        exportSha256: digest(bounded),
        redaction,
        truncated: Buffer.byteLength(redacted) > 8192,
        text: bounded,
      });
    }
  }
  const html = render(explanation, excerpts);
  const directory = relative(safePath(root, "."), output).replaceAll(sep, "/");
  const ignoreProtection = evidenceIgnoreProtection(root, directory);
  // Every input/containment/privacy check above completes before artifact writes.
  mkdirSync(safePath(root, ".arrs/reports"), { recursive: true });
  evidenceIgnoreProtection(root, directory);
  mkdirSync(output);
  writeFileSync(
    safePath(root, `${directory}/explanation.json`),
    JSON.stringify(explanation, null, 2) + "\n",
    { flag: "wx" },
  );
  writeFileSync(safePath(root, `${directory}/index.html`), html, { flag: "wx" });
  return {
    directory,
    path: `${directory}/index.html`,
    explanation,
    excerpts: options.excerpts ?? false,
    redaction: options.redaction ?? "heuristic",
    ignoreProtection,
  };
}
