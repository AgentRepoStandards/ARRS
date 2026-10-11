import { existsSync } from "node:fs";
import { architectureCoverage, checkArchitectureGuard } from "./architecture.js";
import { effectiveRisk, readConfig, readRiskPolicy, scanFeatures } from "./config.js";
import { validateAcceptedEvidence } from "./evidence.js";
import { readJson, safePath, walkFiles } from "./files.js";
import { resolveCommand, runCommand } from "./runner.js";
import { policyRequirements, candidatePolicyLimitation } from "./policy-baseline.js";
import { workControl } from "./work-provider.js";
import { contextControl, checkKnowledge } from "./context.js";
import { checkCI } from "./ci.js";
import { checkSecurity } from "./security.js";
import { checkSkills } from "./skills-check.js";
import type {
  ArrsConfig,
  AuditReport,
  CommandName,
  DiagnosticStatus,
  ProofManifest,
  RiskPolicy,
  PolicyBaseline,
} from "./types.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function proofEvidence(
  root: string,
  config: ArrsConfig,
  baseline?: PolicyBaseline,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    if (!existsSync(safePath(root, config.proof.evidenceDir)))
      return { errors: ["No proof evidence directory exists"], warnings };
    const files = walkFiles(root, config.proof.evidenceDir, {
      includeIgnored: true,
    }).filter((file) => file.endsWith("/proof.json"));
    if (!files.length)
      return { errors: ["No generated proof manifest exists"], warnings };
    let passed = 0;
    for (const file of files) {
      try {
        const value = readJson(root, file);
        const issues = validateAcceptedEvidence(root, file, baseline);
        if (!issues.length) {
          const manifest = value as ProofManifest;
          if (file !== `${config.proof.evidenceDir}/${manifest.id}/proof.json`)
            warnings.push(`${file}: proof is outside its canonical evidence location`);
          else passed++;
        } else warnings.push(`${file}: ${issues.join("; ")}`);
      } catch (error) {
        warnings.push(`${file}: ${message(error)}`);
      }
    }
    if (!passed)
      errors.push(
        "No current accepted proof manifest validates against commands, policy-required implementation review, logs and scope hashes",
      );
  } catch (error) {
    errors.push(message(error));
  }
  return { errors, warnings };
}
/** Cumulative capability audit. Project commands execute only with explicit opt-in. */
export async function audit(
  root: string,
  options: { execute?: boolean; baseline?: PolicyBaseline | undefined } = {},
): Promise<AuditReport> {
  // Pin the supplied trust context and every mapped command before any runtime effects.
  if (options.baseline) policyRequirements(root, ["."], "R0", options.baseline);
  const report: AuditReport = {
    schemaVersion: "0.1",
    level: 0,
    controls: [],
    warnings: [
      ...(!options.baseline ? [candidatePolicyLimitation] : []),
      "Local command success and evidence are not hostile-author attestation or a security certification.",
      "Architecture coverage is bounded to the selected versioned adapter and declared source; Python remains provisional pending actual pilot inventory, and no adapter proves test adequacy.",
      "Knowledge/context checks are bounded static heuristics, not proof of instruction adequacy. CI inspection establishes supported gate invocations, not a hosted run, required checks or branch protection.",
      "Incomplete adoption records unproven ARRS capability; it does not establish poor application engineering.",
    ],
  };
  const add = (
    id: string,
    level: number,
    errors: string[],
    detail: string,
    remediation: string,
    status: DiagnosticStatus = "failed",
    dependsOn?: string[],
  ): void => {
    report.controls.push({
      id,
      level,
      passed: errors.length === 0,
      status: errors.length ? status : "passed",
      ...(dependsOn ? { dependsOn } : {}),
      detail: errors.length ? errors.join("; ") : detail,
      remediation: errors.length ? remediation : "",
    });
  };
  let config: ArrsConfig;
  try {
    config = readConfig(root);
    add("config", 1, [], "Versioned config and repository paths validate", "");
  } catch (error) {
    add(
      "config",
      1,
      [message(error)],
      "",
      "Run arrs init or repair arrs.json and unsafe paths",
    );
    return report;
  }
  const commandErrors = (["check", "test", "build"] as const)
    .filter((name) => !config.commands[name])
    .map((name) => `commands.${name} is unconfigured`);
  add(
    "commands",
    1,
    commandErrors,
    "Standard check, test and build interface is configured",
    "Set project-specific argv arrays in arrs.json; never invent missing commands",
    "incomplete",
  );
  const knowledgeErrors = (["architecture", "product", "decisions"] as const).flatMap(
    (key) =>
      checkKnowledge(root, config.knowledge[key]).map((error) => `${key}: ${error}`),
  );
  add(
    "knowledge",
    1,
    knowledgeErrors,
    "Architecture, product and decisions contain substantive contextual knowledge",
    "Write concise repository-specific context and replace placeholders",
    knowledgeErrors.some((error) =>
      /(?:broken|invalid) repository reference/i.test(error),
    )
      ? "failed"
      : "incomplete",
  );
  const maps = scanFeatures(root, config);
  add(
    "features",
    1,
    maps.errors,
    `${maps.features.length} maps validate with real paths, ownership and verification targets`,
    "Repair Feature Maps and their module ownership, path references and verifyTargets",
    maps.errors.length > 0 &&
      maps.errors.every((error) => error.startsWith("Feature ownership is blocked:"))
      ? "blocked"
      : maps.errors.some((error) =>
            /No Feature Maps|unconfigured|Architecture is unconfigured/.test(error),
          )
        ? "incomplete"
        : "failed",
    maps.errors.length > 0 &&
      maps.errors.every((error) => error.startsWith("Feature ownership is blocked:"))
      ? ["architecture"]
      : undefined,
  );
  const coverage = architectureCoverage(root, {
    allowExternalRuntime: options.execute === true,
  });
  report.architecture = coverage;
  const architectureErrors = coverage.errors;
  const architectureStatus: DiagnosticStatus = architectureErrors.some((error) =>
    /not-evaluated/i.test(error),
  )
    ? "not-evaluated"
    : architectureErrors.some((error) => /unsupported/i.test(error))
      ? "unsupported"
      : architectureErrors.some((error) =>
            /unconfigured|has no .* source to enforce|Cannot read JSON.*ENOENT/.test(
              error,
            ),
          )
        ? "incomplete"
        : "failed";
  add(
    "architecture",
    2,
    architectureErrors,
    `${coverage.adapter}@${coverage.version}: ${coverage.scannedFileCount}/${coverage.sourceFileCount} source files scanned (${coverage.qualification})`,
    `Configure real boundaries at ${config.architecture.policy}; repair forbidden/unresolved imports`,
    architectureStatus,
  );
  const guardErrors = architectureErrors.length
    ? [
        "Blocked by architecture assessment; configure or repair the policy before exercising its mutation guard",
      ]
    : checkArchitectureGuard(root);
  report.architecture.guard = architectureErrors.length
    ? "blocked"
    : guardErrors.length
      ? "failed"
      : "passed";
  add(
    "architecture-guard",
    2,
    guardErrors,
    "The scanner rejects an injected forbidden dependency using real modules",
    "Declare a meaningful forbidden dependency with real supported source and preserve mutation protection",
    architectureErrors.length ? "blocked" : "failed",
    architectureErrors.length ? ["architecture"] : undefined,
  );
  add(
    "security",
    2,
    checkSecurity(root),
    "Secrets/unsafe shortcuts heuristics, dependency justifications and exceptions validate",
    `Review manifest dependency rationale in ${config.security.exceptions}.dependencies; maintain scoped expiring policy exceptions separately in .exceptions`,
  );
  async function execute(name: CommandName, target?: string): Promise<string[]> {
    try {
      const result = await runCommand(root, resolveCommand(config, name, target));
      return result.exitCode === 0
        ? []
        : [
            `${name}${target ? ` ${target}` : ""} exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-800)}`,
          ];
    } catch (error) {
      return [message(error)];
    }
  }
  const notExecuted =
    "Not evaluated: repository command execution was not authorized; review arrs.json, then use audit --execute";
  add(
    "check-executed",
    2,
    !config.commands.check
      ? ["Blocked by commands: check is unconfigured"]
      : !options.execute
        ? [notExecuted]
        : await execute("check"),
    "Configured check command executed successfully",
    "Configure check; run audit --execute and repair any actual failing static check",
    !config.commands.check ? "blocked" : !options.execute ? "not-evaluated" : "failed",
    !config.commands.check ? ["commands"] : undefined,
  );
  const missingVerification = (["test", "build", "verify"] as const).filter(
    (name) => !config.commands[name],
  );
  const verificationPrerequisites = [
    ...missingVerification.map((name) => `${name} is unconfigured`),
    ...(maps.errors.length ? ["Feature Maps assessment is incomplete or invalid"] : []),
  ];
  const verificationErrors: string[] = [];
  if (verificationPrerequisites.length)
    verificationErrors.push(`Blocked: ${verificationPrerequisites.join("; ")}`);
  else if (!options.execute) verificationErrors.push(notExecuted);
  else {
    for (const name of ["test", "build", "verify"] as const)
      verificationErrors.push(...(await execute(name)));
    for (const target of new Set(
      maps.features.map((feature) => feature.verification.target),
    ))
      verificationErrors.push(...(await execute("verify", target)));
  }
  add(
    "verification-executed",
    3,
    verificationErrors,
    "Test/build/verify and every mapped feature behavior target executed successfully",
    "Configure meaningful executable verification targets; run audit --execute and fix any actual failures",
    verificationPrerequisites.length
      ? "blocked"
      : !options.execute
        ? "not-evaluated"
        : "failed",
    verificationPrerequisites.length
      ? [
          ...(missingVerification.some((name) => name !== "verify") ? ["commands"] : []),
          ...(maps.errors.length ? ["features"] : []),
        ]
      : undefined,
  );
  const proof = proofEvidence(root, config, options.baseline);
  if (proof.warnings.length > 3) {
    report.proofHistoryWarnings = proof.warnings;
    report.warnings.push(
      `${proof.warnings.length} historical proof warnings; inspect proofHistoryWarnings in audit --json or arrs proof history --json for individual paths and reasons`,
    );
  } else report.warnings.push(...proof.warnings);
  add(
    "proof-evidence",
    3,
    proof.errors,
    "At least one current passing evidence package validates against policy, logs and source",
    "Create a complete plan and use arrs proof run/start/finish --execute; revalidate current scope",
    proof.errors.some((error) =>
      /No proof evidence directory|No generated proof manifest/.test(error),
    )
      ? "incomplete"
      : "failed",
  );
  let policy: RiskPolicy | undefined;
  const riskErrors: string[] = [];
  try {
    policy = readRiskPolicy(root, config);
    if (!policy.sensitivePaths.length)
      riskErrors.push(
        "Sensitive-path coverage is unconfigured: no sensitive paths are classified; engine support alone does not establish repository coverage",
      );
  } catch (error) {
    riskErrors.push(message(error));
  }
  add(
    "risk",
    4,
    riskErrors,
    "Risk policy governs autonomy, required verification and independent/human review",
    "Validate R0–R4 defaults and classify actual sensitive repository paths at R3/R4",
    policy && !policy.sensitivePaths.length ? "incomplete" : "failed",
  );
  const classificationErrors: string[] = [];
  if (riskErrors.length)
    classificationErrors.push(
      "Blocked by risk coverage or policy: there are no valid declared sensitive rules to exercise",
    );
  else if (maps.errors.length)
    classificationErrors.push(
      "Blocked by Feature Maps: effective scope classification requires valid ownership/risk maps",
    );
  else if (policy)
    for (const item of policy.sensitivePaths) {
      try {
        if (!existsSync(safePath(root, item.path)))
          classificationErrors.push(`Sensitive path is stale: ${item.path}`);
        else if (
          (options.baseline
            ? policyRequirements(root, [item.path], "R0", options.baseline).risk
            : effectiveRisk(root, [item.path], "R0")) < item.risk
        )
          classificationErrors.push(`Sensitive risk floor failed for ${item.path}`);
      } catch (error) {
        classificationErrors.push(message(error));
      }
    }
  else classificationErrors.push("Valid risk policy required");
  add(
    "sensitive-classification",
    4,
    classificationErrors,
    "Scope classification exercises declared rules and enforces their sensitive-path risk floors (not a coverage adequacy assessment)",
    "Repair sensitive path references and scope risk classification",
    riskErrors.length || maps.errors.length ? "blocked" : "failed",
    riskErrors.length ? ["risk"] : maps.errors.length ? ["features"] : undefined,
  );
  add(
    "context",
    4,
    contextControl(root, config),
    "Concise AGENTS.md maps context and preserves durable engineering rules",
    "Keep AGENTS.md concise, link the Feature Maps/architecture/risk policy and require proof without bypassing controls",
  );
  const skillErrors = checkSkills(root);
  add(
    "skills",
    4,
    skillErrors,
    "Installed skills pack integrity, behavior requirements and pinned provenance validate",
    "Install the ARRS skills pack; reconcile adaptations deliberately and retain attribution",
    skillErrors.some((error) => /Missing|ENOENT/.test(error)) ? "incomplete" : "failed",
  );
  const ciErrors = checkCI(root, config);
  add(
    "ci",
    4,
    ciErrors,
    "Supported GitHub workflow statically invokes unsuppressed gates and executed level 4 audit; hosted success is unobserved",
    "Configure an unsuppressed CI workflow with check, test, verify and audit --execute --require-level 4",
    ciErrors.some((error) => /unsupported/i.test(error))
      ? "unsupported"
      : ciErrors.some((error) => /^Missing/.test(error))
        ? "incomplete"
        : "failed",
  );
  const workErrors = workControl(root, config, options.baseline);
  add(
    "work-state",
    4,
    workErrors,
    "Reference work items validate readiness, context, risk and proof-backed review/completion",
    "Configure the local work provider/path; maintain self-contained items and use proof-aware arrs work transitions",
    config.work && config.work.provider !== "local"
      ? "unsupported"
      : workErrors.some((error) => /Missing|No schema|ENOENT/.test(error))
        ? "incomplete"
        : "failed",
  );
  for (let level = 1; level <= 4; level++) {
    if (
      !report.controls
        .filter((control) => control.level <= level)
        .every((control) => control.passed)
    )
      break;
    report.level = level;
  }
  return report;
}
