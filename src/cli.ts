#!/usr/bin/env node
import { resolve, relative, isAbsolute } from "node:path";
import { planAdoption, writeAdoptionProposal, applyAdoption } from "./workflows/adopt.js";
import { initRepository } from "./workflows/init.js";
import {
  runProof,
  startProof,
  finishProof,
  validateProof,
  reviewProof,
} from "./workflows/proof.js";
import { validateAcceptedEvidence } from "./core/evidence.js";
import {
  explainProof,
  proofHistory,
  proofExplanationText,
} from "./core/proof-explanation.js";
import { reportProof } from "./workflows/proof-report.js";
import { verifyReceipt, type ReceiptSelections } from "./core/receipt.js";
import { exportReceipt, importReceipt } from "./workflows/receipt.js";
import { recordMetric, summarizeMetrics } from "./workflows/metrics.js";
import {
  observeOutcome,
  previewOutcomeExport,
  type OutcomeFilters,
} from "./core/outcomes.js";
import { validateWork, transitionWork } from "./workflows/work.js";
import { garden, proposeGarden } from "./workflows/gardener.js";
import { skillsCommand } from "./workflows/skills.js";
import { audit } from "./core/audit.js";
import { doctor } from "./core/doctor.js";
import { readConfig } from "./core/config.js";
import { readJson } from "./core/files.js";
import { prepareTask, comparePreparedTask, renderPreparedTask } from "./core/prepare.js";
import { checkPreparationOutput, writePreparedTask } from "./workflows/prepare.js";
import { assessReadiness, renderReadiness } from "./core/readiness.js";
import {
  queryCapabilityGraph,
  renderCapabilityGraph,
  capabilityGraphHtml,
} from "./core/capability-graph.js";
import {
  inspectChangeset,
  inspectManualScope,
  checkChangesetScope,
} from "./core/changeset.js";
import { validate, type SchemaKind } from "./core/schema.js";
import { checkArchitecture } from "./core/architecture.js";
import { checkSecurity } from "./core/security.js";
import {
  inspectPolicyBaseline,
  policyRequirements,
  policyMode,
  candidatePolicyLimitation,
} from "./core/policy-baseline.js";
import { effectiveRisk } from "./core/risk.js";
import { runCommand, resolveCommand } from "./core/runner.js";
import {
  commandNames,
  risks,
  type CommandName,
  type Risk,
  type PolicyBaseline,
} from "./core/types.js";

const help = `ARRS 0.1 — Agent-Ready Repository Standard (Node >=22)

Usage: arrs <command> [arguments] [--root directory] [--json]
  init [directory] [--dry-run]    Preserve existing content; show generated changes
  adopt plan <input> [--output .arrs/adoption/<name>]
  adopt apply <proposal> [--authorization <file>] [--baseline <directory> --baseline-sha256 <digest>]
  doctor [directory]            Diagnose configuration, paths and tools
  audit [directory] [--execute] [--require-level 0..4]
  run setup|dev|check|test|verify [target]|build
  gate                          Enforce architecture and security controls
  validate <schema-kind> <file>  Validate a versioned JSON document
  baseline inspect <external-directory>  Inspect known-good pre-change controls
  risk [scope-paths...] [--risk R0..R4]
  scope inspect --base <revision> | --manual <scope-paths...>
  scope check <proof-plan> --base <revision> | --manual
  proof run <plan> --execute     Feature/documentation evidence
  proof start <plan> --execute   Bug/refactor before evidence
  proof finish <session> --execute
  proof validate <manifest> [--accepted]  Technical proof or accepted review
  proof review <manifest> <review-file>  Attach completed implementation review
  proof explain <manifest>      Read-only technical/review explanation
  proof history [--selected <manifest>]  Read-only canonical attempt history
  proof report <manifest> --output .arrs/reports/<new-directory>
    [--excerpts] [--redaction heuristic|none]  Local static private preview
  receipt verify|import <receipt> --trust <external-file> --trust-sha256 <pin>
    --context <external-file> --context-sha256 <pin> --artifacts .arrs/receipts/<name>
    [--output .arrs/receipts/<new-name>]  Offline provider conformance only
  receipt export <manifest> --output .arrs/receipts/<new-name> [--baseline pair]
  skills install|status|diff|sync|reconcile|test [options]
  metrics record <event-file> | observe <observation-file>
  metrics summary [--workflow alias] [--model alias] [--category category]
    [--risk R0..R4] [--feature id] [--controls sha256] [--window 14d | --start UTC --end UTC]
  metrics export --preview      Inspect local privacy-safe lifecycle records
  gardener                     Observe bounded substrate improvements
  gardener propose <candidate-id> --out <work-file>  Create one needs-triage draft
  work validate <file> | transition <file> --to <state>
  mcp --stdio                   Optional local read-only MCP server
  prepare <work-file> [--output .arrs/directory] [--scenarios file] [--compare packet]
  readiness feature <id> | work <file> [--base <explicit-commit>]
  impact [source-paths...] [--base local-revision] [--limit 1..1000] [--cursor token]
  context feature <id> | drift --base <local-revision> [--html]

Only configured argv commands execute; no shell evaluation by ARRS.
Audit/proof execution requires --execute; inspect trusted configuration first.
Paths in documents are relative to the repository. --json emits one JSON value.
--root applies to every command; --json is unavailable for the MCP protocol stream.
Other flags apply only where shown:
--dry-run: init; --execute: audit, proof run/start/finish; --require-level: audit;
--risk: risk, metrics summary; --to: work transition; --accepted: proof validate.
--output/--excerpts/--redaction: proof report; --selected: proof history.
--output: adopt plan; --authorization: adopt apply.
--output/--scenarios/--compare: prepare (default reads only; drafts never imply readiness).
risk/proof/work/audit/prepare/readiness/mcp/impact/context: --baseline <external-directory> --baseline-sha256 <digest>.
Select and retain known-good baseline controls independently before editing.
Without selection, local evaluation is candidate-only and cannot authorize policy transitions.
Unsupported options fail before repository writes or command execution.
`;
interface Options {
  stdio: boolean;
  root: string;
  json: boolean;
  execute: boolean;
  dryRun: boolean;
  accepted: boolean;
  requireLevel?: number;
  risk?: Risk;
  to?: string;
  out?: string;
  authorization?: string;
  baselineRoot?: string;
  baselineSha256?: string;
  baseline?: PolicyBaseline;
  output?: string;
  excerpts: boolean;
  redaction?: "heuristic" | "none";
  selected?: string;
  metricFilters: OutcomeFilters;
  preview: boolean;
  outputDirectory?: string;
  scenariosPath?: string;
  comparePath?: string;
  receiptTrust?: string;
  receiptTrustSha256?: string;
  receiptContext?: string;
  receiptContextSha256?: string;
  receiptArtifacts?: string;
  base?: string;
  manual: boolean;
  limit?: number;
  cursor?: string;
  html: boolean;
  args: string[];
  flags: Set<string>;
}
const valueFlags = new Set([
  "--authorization",
  "--trust",
  "--trust-sha256",
  "--context",
  "--context-sha256",
  "--artifacts",
  "--root",
  "--require-level",
  "--risk",
  "--to",
  "--out",
  "--baseline",
  "--baseline-sha256",
  "--output",
  "--redaction",
  "--selected",
  "--workflow",
  "--model",
  "--category",
  "--feature",
  "--controls",
  "--window",
  "--start",
  "--end",
  "--scenarios",
  "--compare",
  "--base",
  "--limit",
  "--cursor",
]);
const booleanFlags = new Set([
  "--json",
  "--execute",
  "--dry-run",
  "--accepted",
  "--excerpts",
  "--preview",
  "--manual",
  "--stdio",
  "--html",
]);
const supportedFlags = new Set([...valueFlags, ...booleanFlags]);
/** Match positional command selection even when value validation rejects startup. */
function selectedCommand(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (valueFlags.has(arg)) {
      index++;
      continue;
    }
    if (!booleanFlags.has(arg)) return arg;
  }
  return undefined;
}
function parse(argv: string[]): Options {
  const options: Options = {
    stdio: false,
    root: process.cwd(),
    json: false,
    execute: false,
    dryRun: false,
    accepted: false,
    excerpts: false,
    manual: false,
    html: false,
    args: [],
    metricFilters: {},
    preview: false,
    flags: new Set(),
  };
  const value = (index: number, flag: string): string => {
    const item = argv[index + 1];
    if (!item || item.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return item;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (
      [
        "--trust",
        "--trust-sha256",
        "--context",
        "--context-sha256",
        "--artifacts",
      ].includes(arg) &&
      options.flags.has(arg)
    )
      throw new Error(`Duplicate receipt selection ${arg} is unsupported`);
    if (
      ["--output", "--scenarios", "--compare", "--limit", "--cursor", "--html"].includes(
        arg,
      ) &&
      options.flags.has(arg)
    )
      throw new Error(`Duplicate preparation option ${arg} is unsupported`);
    if (
      ["--baseline", "--baseline-sha256", "--base"].includes(arg) &&
      options.flags.has(arg)
    )
      throw new Error(
        "Ambiguous policy baseline selection: select one baseline root/digest pair; duplicate trust flags are unsupported",
      );
    if (supportedFlags.has(arg)) options.flags.add(arg);
    if (arg === "--root") {
      options.root = resolve(value(index, arg));
      index++;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--preview") options.preview = true;
    else if (arg === "--stdio") options.stdio = true;
    else if (
      [
        "--workflow",
        "--model",
        "--category",
        "--feature",
        "--controls",
        "--window",
        "--start",
        "--end",
      ].includes(arg)
    ) {
      const name = arg.slice(2) as keyof OutcomeFilters;
      if (options.metricFilters[name]) throw new Error(`Duplicate metrics filter ${arg}`);
      options.metricFilters[name] = value(index, arg);
      index++;
    } else if (arg === "--execute") options.execute = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--accepted") options.accepted = true;
    else if (arg === "--manual") options.manual = true;
    else if (arg === "--html") options.html = true;
    else if (arg === "--cursor") {
      options.cursor = value(index, arg);
      index++;
    } else if (arg === "--limit") {
      const limit = Number(value(index, arg));
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("--limit must be 1..1000");
      options.limit = limit;
      index++;
    } else if (
      [
        "--trust",
        "--trust-sha256",
        "--context",
        "--context-sha256",
        "--artifacts",
      ].includes(arg)
    ) {
      const supplied = value(index, arg);
      if (arg === "--trust") options.receiptTrust = supplied;
      if (arg === "--trust-sha256") options.receiptTrustSha256 = supplied;
      if (arg === "--context") options.receiptContext = supplied;
      if (arg === "--context-sha256") options.receiptContextSha256 = supplied;
      if (arg === "--artifacts") options.receiptArtifacts = supplied;
      index++;
    } else if (arg === "--base") {
      options.base = value(index, arg);
      index++;
    } else if (arg === "--require-level") {
      const level = Number(value(index, arg));
      if (!Number.isInteger(level) || level < 0 || level > 4)
        throw new Error("--require-level must be 0..4");
      options.requireLevel = level;
      index++;
    } else if (arg === "--risk") {
      const risk = value(index, arg);
      if (!risks.includes(risk as Risk)) throw new Error("--risk must be R0..R4");
      options.risk = risk as Risk;
      index++;
    } else if (arg === "--output") {
      options.output = value(index, arg);
      options.outputDirectory = options.output;
      index++;
    } else if (arg === "--authorization") {
      options.authorization = value(index, arg);
      index++;
    } else if (arg === "--baseline") {
      options.baselineRoot = resolve(value(index, arg));
      index++;
    } else if (arg === "--baseline-sha256") {
      options.baselineSha256 = value(index, arg);
      index++;
    } else if (arg === "--scenarios" || arg === "--compare") {
      const supplied = value(index, arg);
      if (arg === "--scenarios") options.scenariosPath = supplied;
      if (arg === "--compare") options.comparePath = supplied;
      index++;
    } else if (arg === "--to") {
      options.to = value(index, arg);
      index++;
    } else if (arg === "--excerpts") options.excerpts = true;
    else if (arg === "--redaction") {
      const redaction = value(index, arg);
      if (redaction !== "heuristic" && redaction !== "none")
        throw new Error("--redaction must be heuristic or none");
      options.redaction = redaction;
      index++;
    } else if (arg === "--selected") {
      options.selected = value(index, arg);
      index++;
    } else if (arg === "--out") {
      options.out = value(index, arg);
      index++;
    } else options.args.push(arg);
  }
  if (Boolean(options.baselineRoot) !== Boolean(options.baselineSha256))
    throw new Error(
      "Protected evaluation requires both --baseline and independently retained --baseline-sha256; no candidate-only fallback",
    );
  if (options.baselineRoot && options.baselineSha256)
    options.baseline = { root: options.baselineRoot, sha256: options.baselineSha256 };
  return options;
}
function filePath(root: string, input: string | undefined): string {
  if (!input) throw new Error("Expected a repository file path.");
  return isAbsolute(input) ? relative(root, input).replaceAll("\\", "/") : input;
}
function emit(value: unknown, options: Options): void {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "proof-explanation"
  ) {
    console.log(proofExplanationText(value as ReturnType<typeof explainProof>));
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "proof-history"
  ) {
    const history = value as ReturnType<typeof proofHistory>;
    console.log(`Proof history: ${JSON.stringify(history.summary)}`);
    for (const entry of history.entries.filter(
      (entry) =>
        entry.selected || ["accepted", "ready-for-review"].includes(entry.status),
    ))
      console.log(
        `${entry.status}: ${entry.path} (${entry.task ?? "unknown"})`.replace(
          /[\u0000-\u001f\u007f-\u009f]/g,
          "\uFFFD",
        ),
      );
    console.log(
      "Full failed, stale, interrupted and malformed history with diagnostics: arrs proof history --json",
    );
    for (const error of history.errors)
      console.log(`ERROR: ${error}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD"));
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    "controls" in value &&
    Array.isArray(value.controls) &&
    "level" in value &&
    typeof value.level === "number"
  ) {
    const report = value as Awaited<ReturnType<typeof audit>>;
    console.log(
      `ARRS ${report.level} — ${["Unmanaged", "Mapped", "Constrained", "Self-Verifying", "Delegatable"][report.level]}`,
    );
    for (const control of report.controls)
      console.log(
        `${control.status.toUpperCase()} [L${control.level}] ${control.id}: ${control.detail}${control.passed ? "" : `\n  Remediation: ${control.remediation}`}`,
      );
    for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  } else if (
    value &&
    typeof value === "object" &&
    "created" in value &&
    Array.isArray(value.created) &&
    "detected" in value
  ) {
    const report = value as ReturnType<typeof initRepository>;
    console.log(`${report.dryRun ? "Planned" : "Initialized"} ${report.root}`);
    report.detected.forEach((item) => console.log(`Detected: ${item}`));
    report.created.forEach((item) => console.log(`+ ${item}`));
    report.preserved.forEach((item) => console.log(`Preserved: ${item}`));
    report.requirements.forEach((item) => console.log(`Configure: ${item}`));
  } else console.log(JSON.stringify(value, null, 2));
}
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    console.log(help);
    return;
  }
  if (argv[0] === "--version") {
    console.log("0.1.0");
    return;
  }
  const options = parse(argv),
    [command, ...args] = options.args;
  const allowed = new Set(["--root", "--json"]);
  if (
    [
      "risk",
      "proof",
      "work",
      "audit",
      "prepare",
      "readiness",
      "mcp",
      "impact",
      "context",
    ].includes(command ?? "")
  ) {
    allowed.add("--baseline");
    allowed.add("--baseline-sha256");
  }
  if (command === "adopt" && args[0] === "plan") allowed.add("--output");
  if (command === "adopt" && args[0] === "apply") {
    allowed.add("--authorization");
    allowed.add("--baseline");
    allowed.add("--baseline-sha256");
  }
  if (command === "receipt") {
    if (["verify", "import"].includes(args[0] ?? ""))
      for (const flag of [
        "--trust",
        "--trust-sha256",
        "--context",
        "--context-sha256",
        "--artifacts",
      ])
        allowed.add(flag);
    if (["export", "import"].includes(args[0] ?? "")) allowed.add("--output");
    if (args[0] === "export") {
      allowed.add("--baseline");
      allowed.add("--baseline-sha256");
    }
  }
  if (command === "init") allowed.add("--dry-run");
  if (command === "mcp") {
    allowed.add("--stdio");
    allowed.delete("--json");
  }
  if (command === "audit") {
    allowed.add("--execute");
    allowed.add("--require-level");
  }
  if (command === "risk") allowed.add("--risk");
  if (command === "metrics" && args[0] === "summary")
    for (const flag of [
      "--workflow",
      "--model",
      "--category",
      "--risk",
      "--feature",
      "--controls",
      "--window",
      "--start",
      "--end",
    ])
      allowed.add(flag);
  if (command === "metrics" && args[0] === "export") allowed.add("--preview");
  if (command === "prepare")
    for (const flag of ["--output", "--scenarios", "--compare"]) allowed.add(flag);
  if (command === "scope") {
    allowed.add("--base");
    allowed.add("--manual");
  }
  if (command === "readiness" && args[0] === "work") allowed.add("--base");
  if (["impact", "context"].includes(command ?? ""))
    for (const flag of ["--base", "--limit", "--cursor", "--html"]) allowed.add(flag);
  if (command === "work" && args[0] === "transition") allowed.add("--to");
  if (command === "gardener" && args[0] === "propose") allowed.add("--out");
  if (command === "proof") {
    if (["run", "start", "finish"].includes(args[0] ?? "")) allowed.add("--execute");
    if (args[0] === "validate") allowed.add("--accepted");
    if (args[0] === "history") allowed.add("--selected");
    if (args[0] === "report")
      for (const flag of ["--output", "--excerpts", "--redaction"]) allowed.add(flag);
  }
  for (const flag of options.flags)
    if (!allowed.has(flag))
      throw new Error(
        `Unsupported option ${flag} for arrs ${command}${["proof", "work", "skills", "metrics"].includes(command ?? "") && args[0] ? ` ${args[0]}` : ""}. Use arrs --help.`,
      );
  const rejectExtra = (max: number): void => {
    if (args.length > max) throw new Error("Unexpected arguments. Use arrs --help.");
  };
  if (command !== "skills" && args.some((arg) => arg.startsWith("--")))
    throw new Error(`Unknown option ${args.find((arg) => arg.startsWith("--"))}`);
  let root = options.root;
  if (["init", "doctor", "audit"].includes(command ?? "") && args[0])
    root = resolve(options.root, args[0]);
  let output: unknown;
  switch (command) {
    case "impact":
    case "context": {
      if (options.html && options.json) throw new Error("Choose --html or --json output");
      let feature: string | undefined;
      if (command === "context") {
        if (args[0] === "feature") {
          rejectExtra(2);
          if (!args[1]) throw new Error("Use context feature <id>");
          if (options.base)
            throw new Error(
              "Use context drift --base for comparison; feature context reads current facts",
            );
          feature = args[1];
        } else if (args[0] === "drift") {
          rejectExtra(1);
          if (!options.base)
            throw new Error("context drift requires --base <local-revision>");
        } else
          throw new Error(
            "Use context feature <id> or context drift --base <local-revision>",
          );
      } else if (!args.length && !options.base)
        throw new Error(
          "impact requires explicit source paths or --base <local-revision>",
        );
      const result = await queryCapabilityGraph(root, {
        ...(feature ? { feature } : {}),
        ...(command === "impact" && args.length
          ? { paths: args.map((path) => filePath(root, path)) }
          : {}),
        ...(options.base ? { base: options.base } : {}),
        ...(options.baseline ? { baseline: options.baseline } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      if (result.status !== "complete") process.exitCode = 1;
      if (!options.json) {
        process.stdout.write(
          options.html ? capabilityGraphHtml(result) : renderCapabilityGraph(result),
        );
        return;
      }
      output = result;
      break;
    }

    case "receipt": {
      rejectExtra(2);
      const path = filePath(root, args[1]);
      if (args[0] === "export") {
        if (!options.output)
          throw new Error("Receipt export requires --output .arrs/receipts/<new-name>");
        output = exportReceipt(root, path, options.output, options.baseline);
      } else if (["verify", "import"].includes(args[0] ?? "")) {
        if (
          !options.receiptTrust ||
          !options.receiptTrustSha256 ||
          !options.receiptContext ||
          !options.receiptContextSha256 ||
          !options.receiptArtifacts
        )
          throw new Error(
            "Receipt verification/import requires independently selected --trust/--trust-sha256, --context/--context-sha256 and contained --artifacts",
          );
        const selections: ReceiptSelections = {
          trust: options.receiptTrust,
          trustSha256: options.receiptTrustSha256,
          context: options.receiptContext,
          contextSha256: options.receiptContextSha256,
          artifacts: options.receiptArtifacts,
        };
        if (args[0] === "import") {
          if (!options.output)
            throw new Error("Receipt import requires --output .arrs/receipts/<new-name>");
          output = importReceipt(root, path, selections, options.output);
        } else {
          const verification = verifyReceipt(root, path, selections);
          output = verification;
          if (!verification.valid) process.exitCode = 1;
        }
      } else throw new Error("Use receipt verify, export or import");
      break;
    }
    case "readiness": {
      rejectExtra(2);
      if (!["feature", "work"].includes(args[0] ?? "") || !args[1])
        throw new Error(
          "Use readiness feature <id> or readiness work <file> [--base <explicit-commit>]",
        );
      const report = await assessReadiness(
        root,
        args[0] === "feature"
          ? { kind: "feature", id: args[1] }
          : { kind: "work", path: filePath(root, args[1]) },
        {
          ...(options.baseline ? { baseline: options.baseline } : {}),
          ...(options.base ? { base: options.base } : {}),
        },
      );
      if (
        report.dimensions.some((entry) =>
          ["failed", "blocked", "unsupported"].includes(entry.status),
        )
      )
        process.exitCode = 1;
      if (options.json) output = report;
      else console.log(renderReadiness(report));
      break;
    }
    case "mcp": {
      rejectExtra(0);
      if (!options.stdio)
        throw new Error(
          "Start the local MCP adapter with mcp --stdio --root <repository>",
        );
      const { serveReadonlyMcp } = await import("./workflows/mcp.js");
      await serveReadonlyMcp(root, options.baseline);
      return;
    }
    case "prepare": {
      rejectExtra(1);
      if (options.outputDirectory) checkPreparationOutput(root, options.outputDirectory);
      const packet = prepareTask(root, filePath(root, args[0]), {
        ...(options.baseline ? { baseline: options.baseline } : {}),
        ...(options.scenariosPath
          ? { scenariosPath: filePath(root, options.scenariosPath) }
          : {}),
      });
      const comparison = options.comparePath
        ? comparePreparedTask(readJson(root, filePath(root, options.comparePath)), packet)
        : undefined;
      const saved = options.outputDirectory
        ? writePreparedTask(root, options.outputDirectory, packet)
        : undefined;
      output =
        comparison || saved
          ? {
              ...packet,
              ...(comparison ? { comparison } : {}),
              ...(saved ? { output: saved } : {}),
            }
          : packet;
      if (packet.blockers.length || comparison?.stale) process.exitCode = 1;
      if (!options.json) {
        console.log(renderPreparedTask(packet));
        if (saved) console.log(`Saved ${saved.files.join(", ")}`);
        if (comparison) console.log(JSON.stringify(comparison));
        output = undefined;
      }
      break;
    }
    case "init":
      rejectExtra(1);
      output = initRepository(root, options.dryRun);
      break;
    case "adopt": {
      rejectExtra(2);
      if (!args[1]) throw new Error("Expected adoption input/proposal path");
      if (args[0] === "plan") {
        const proposal = planAdoption(root, args[1]);
        output = options.output
          ? { ...proposal, output: writeAdoptionProposal(root, proposal, options.output) }
          : proposal;
      } else if (args[0] === "apply") {
        output = applyAdoption(root, args[1], options.authorization, options.baseline);
      } else throw new Error("Unknown adoption action");
      break;
    }
    case "doctor": {
      rejectExtra(1);
      const report = await doctor(root);
      output = report;
      if (!report.healthy) process.exitCode = 1;
      break;
    }
    case "audit": {
      rejectExtra(1);
      const report = await audit(root, {
        execute: options.execute,
        baseline: options.baseline,
      });
      output = report;
      if (options.requireLevel !== undefined && report.level < options.requireLevel)
        process.exitCode = 1;
      break;
    }
    case "run": {
      rejectExtra(2);
      const name = args[0] as CommandName;
      if (!commandNames.includes(name)) throw new Error("Unknown repo command.");
      const result = await runCommand(
        root,
        resolveCommand(readConfig(root), name, args[1]),
      );
      if (options.json) output = result;
      else {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      process.exitCode = result.exitCode;
      break;
    }
    case "validate": {
      rejectExtra(2);
      if (!args[0]) throw new Error("Expected schema kind.");
      const errors = validate(
        args[0] as SchemaKind,
        readJson(root, filePath(root, args[1])),
      );
      output = { valid: errors.length === 0, errors };
      if (errors.length) process.exitCode = 1;
      break;
    }
    case "gate": {
      rejectExtra(0);
      const errors = [...checkArchitecture(root), ...checkSecurity(root)];
      output = { passed: errors.length === 0, errors };
      if (errors.length) process.exitCode = 1;
      break;
    }
    case "baseline":
      rejectExtra(2);
      if (args[0] !== "inspect" || !args[1])
        throw new Error(
          "Use baseline inspect <known-good external directory> before editing; retain the returned digest independently",
        );
      output = {
        selection: inspectPolicyBaseline(root, resolve(options.root, args[1])),
        limitation:
          "Inspection pins control bytes and source identities; a human or trusted workflow must independently establish pre-change selection. Candidate-derived post-edit snapshots are ineligible.",
      };
      break;
    case "risk":
      output = {
        requested: options.risk ?? "R0",
        effective: options.baseline
          ? policyRequirements(root, args, options.risk ?? "R0", options.baseline).risk
          : effectiveRisk(root, args, options.risk ?? "R0"),
        scope: args,
      };
      break;
    case "proof": {
      rejectExtra(args[0] === "review" ? 3 : 2);
      if (args[0] === "history") {
        rejectExtra(1);
        output = proofHistory(
          root,
          options.baseline,
          options.selected ? filePath(root, options.selected) : undefined,
        );
        if ((output as ReturnType<typeof proofHistory>).errors.length)
          process.exitCode = 1;
        break;
      }
      const path = filePath(root, args[1]);
      if (args[0] === "explain") {
        output = explainProof(root, path, options.baseline);
        if (!(output as ReturnType<typeof explainProof>).technical.valid)
          process.exitCode = 1;
      } else if (args[0] === "report") {
        if (!options.output)
          throw new Error("Expected --output .arrs/reports/<new-directory>");
        output = reportProof(root, path, {
          output: options.output,
          excerpts: options.excerpts,
          ...(options.redaction ? { redaction: options.redaction } : {}),
          ...(options.baseline ? { baseline: options.baseline } : {}),
        });
      } else if (args[0] === "validate") {
        const errors = options.accepted
          ? validateAcceptedEvidence(root, path, options.baseline)
          : validateProof(root, readJson(root, path), options.baseline);
        output = { valid: errors.length === 0, errors };
        if (errors.length) process.exitCode = 1;
      } else if (args[0] === "review") {
        output = reviewProof(root, path, filePath(root, args[2]), options.baseline);
      } else if (args[0] === "run") {
        const result = await runProof(root, path, options.execute, options.baseline);
        output = result;
        if (result.errors.length) process.exitCode = 1;
      } else if (args[0] === "start")
        output = await startProof(root, path, options.execute, options.baseline);
      else if (args[0] === "finish") {
        const result = await finishProof(root, path, options.execute, options.baseline);
        output = result;
        if (result.errors.length) process.exitCode = 1;
      } else throw new Error("Unknown proof action.");
      break;
    }
    case "scope": {
      if (Boolean(options.base) === options.manual)
        throw new Error("Choose exactly one explicit --base <revision> or --manual mode");
      if (args[0] === "inspect") {
        if (options.base) rejectExtra(1);
        const report = options.base
          ? inspectChangeset(root, options.base)
          : inspectManualScope(root, args.slice(1));
        output = report;
        if (report.status !== "complete") process.exitCode = 1;
      } else if (args[0] === "check") {
        rejectExtra(2);
        const value = readJson(root, filePath(root, args[1]));
        const errors = validate("proof-plan", value);
        if (errors.length) throw new Error(`Invalid proof plan: ${errors.join("; ")}`);
        const report = checkChangesetScope(
          root,
          value as import("./core/types.js").ProofPlan,
          options.base,
        );
        output = report;
        if (!report.passed) process.exitCode = 1;
      } else throw new Error("Use scope inspect or scope check <proof-plan>");
      break;
    }
    case "skills":
      output = await skillsCommand(root, args[0] ?? "status", args.slice(1));
      if (
        output &&
        typeof output === "object" &&
        "passed" in output &&
        output.passed === false
      )
        process.exitCode = 1;
      break;
    case "metrics":
      rejectExtra(2);
      if (args[0] === "record") output = recordMetric(root, filePath(root, args[1]));
      else if (args[0] === "observe")
        output = observeOutcome(root, readJson(root, filePath(root, args[1])));
      else if (args[0] === "summary") {
        rejectExtra(1);
        if (options.risk) options.metricFilters.risk = options.risk;
        if (
          options.metricFilters.category &&
          !["bug", "feature", "refactor", "docs"].includes(options.metricFilters.category)
        )
          throw new Error("Unknown metrics category.");
        if (
          options.metricFilters.controls &&
          !/^[a-f0-9]{64}$/.test(options.metricFilters.controls)
        )
          throw new Error("--controls requires a SHA-256 digest.");
        output = summarizeMetrics(root, options.metricFilters);
      } else if (args[0] === "export") {
        rejectExtra(1);
        if (!options.preview)
          throw new Error(
            "metrics export requires --preview; inspect aliases before sharing.",
          );
        output = previewOutcomeExport(root);
      } else throw new Error("Unknown metrics action.");
      break;
    case "gardener":
      rejectExtra(args[0] === "propose" ? 2 : 0);
      if (args[0] === "propose") {
        if (!args[1] || !options.out)
          throw new Error(
            "Use gardener propose <candidate-id> --out <configured-work-file>",
          );
        output = await proposeGarden(root, args[1], filePath(root, options.out));
      } else output = await garden(root);
      break;
    case "work": {
      rejectExtra(2);
      const file = filePath(root, args[1]);
      if (args[0] === "validate") {
        const errors = validateWork(root, file, options.baseline);
        output = { valid: errors.length === 0, errors };
        if (errors.length) process.exitCode = 1;
      } else if (args[0] === "transition") {
        if (!options.to) throw new Error("Expected --to state.");
        output = transitionWork(root, file, options.to, options.baseline);
      } else throw new Error("Unknown work action.");
      break;
    }
    default:
      throw new Error(`Unknown command ${command}. Use arrs --help.`);
  }
  if (
    output !== undefined &&
    ["risk", "proof", "work", "audit"].includes(command ?? "")
  ) {
    output = {
      ...(output as object),
      policyMode: policyMode(options.baseline),
      ...(!options.baseline
        ? { policyTransitionLimitation: candidatePolicyLimitation }
        : {}),
    };
  }
  if (output !== undefined) emit(output, options);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json") && selectedCommand(process.argv.slice(2)) !== "mcp")
    console.log(JSON.stringify({ error: message }));
  else console.error(`ARRS: ${message}`);
  process.exitCode = 1;
});
