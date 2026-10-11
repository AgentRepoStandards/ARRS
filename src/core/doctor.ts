import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { architectureCoverage } from "./architecture.js";
import { readConfig, readRiskPolicy, scanFeatures } from "./config.js";
import { safePath } from "./files.js";
import { checkKnowledge } from "./context.js";
import { checkSecurity } from "./security.js";
import { checkSkills } from "./skills-check.js";
import type { DiagnosticStatus, DoctorReport } from "./types.js";

function available(root: string, executable: string): boolean {
  const candidates =
    executable.includes("/") || executable.includes("\\")
      ? [isAbsolute(executable) ? executable : safePath(root, executable)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .flatMap((directory) =>
            process.platform === "win32"
              ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
                  .split(";")
                  .map((extension) => join(directory, executable + extension))
              : [join(directory, executable)],
          );
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/** Diagnose static repository readiness without executing project scripts. */
export async function doctor(root: string): Promise<DoctorReport> {
  const report: DoctorReport = {
    schemaVersion: "0.1",
    healthy: false,
    checks: [],
    warnings: [
      "Doctor inspects configuration, paths and installed tools; audit --execute verifies actual command behavior.",
      "Instruction and CI file presence checks do not establish the delegation contract or CI gate invocation; audit assesses those separately.",
    ],
  };
  const add = (
    id: string,
    passed: boolean,
    detail: string,
    remediation: string,
    status: DiagnosticStatus = "failed",
  ): void => {
    report.checks.push({
      id,
      passed,
      status: passed ? "passed" : status,
      detail,
      remediation: passed ? "" : remediation,
    });
  };
  try {
    const config = readConfig(root);
    add(
      "config",
      true,
      "arrs.json validates against schema 0.1 and all configured paths are safe",
      "",
    );
    const node = Number(process.versions.node.split(".")[0]);
    add(
      "runtime",
      node >= 22,
      `Node ${process.versions.node}; ARRS requires Node >=22`,
      "Install a supported Node >=22 runtime",
    );
    for (const [name, version] of Object.entries(config.project.runtimes ?? {})) {
      const present = name === "node" ? node >= 22 : available(root, name);
      const minimum = version.match(/^(?:>=)?(\d+)(?:\.\d+){0,2}$/)?.[1];
      add(
        `tool:${name}`,
        present && (name !== "node" || minimum === undefined || node >= Number(minimum)),
        `Runtime ${name}: ${present ? "available" : "missing"} (project requests ${version})`,
        `Install ${name} ${version} and expose it on PATH`,
      );
      if (name !== "node")
        report.warnings.push(
          `Version requirement ${name} ${version} is declared; doctor only checks executable availability for non-Node runtimes.`,
        );
      if (!minimum)
        report.warnings.push(
          `Runtime range ${name} ${version} cannot be interpreted by the v0.1 minimum-version check.`,
        );
    }
    for (const name of ["setup", "dev", "check", "test", "verify", "build"] as const) {
      const command = config.commands[name];
      if (!command && (name === "setup" || name === "dev")) continue;
      add(
        `command:${name}`,
        command !== undefined && available(root, command.argv[0] ?? ""),
        command ? `${name}: ${command.argv.join(" ")}` : `${name} is unconfigured`,
        `Configure commands.${name} in arrs.json and install its executable`,
        command ? "failed" : "incomplete",
      );
    }
    for (const [target, command] of Object.entries(config.verifyTargets))
      add(
        `verify:${target}`,
        available(root, command.argv[0] ?? ""),
        `Target ${target}: ${command.argv.join(" ")}`,
        `Install ${command.argv[0] ?? "the required tool"} or correct verifyTargets.${target}`,
      );
    for (const key of ["architecture", "product", "decisions"] as const) {
      const errors = checkKnowledge(root, config.knowledge[key]);
      add(
        `knowledge:${key}`,
        errors.length === 0,
        errors.join("; ") || `${key} knowledge passes static substance/reference checks`,
        `Write substantive knowledge at ${config.knowledge[key]}; replace placeholder text`,
        errors.some((error) => /(?:broken|invalid) repository reference/i.test(error))
          ? "failed"
          : "incomplete",
      );
    }
    const maps = scanFeatures(root, config);
    add(
      "features",
      maps.errors.length === 0,
      maps.errors.length
        ? maps.errors.join("; ")
        : `${maps.features.length} Feature Maps validate with existing references and configured targets`,
      "Repair malformed Feature Maps, missing references and verification targets",
      maps.errors.length > 0 &&
        maps.errors.every((error) => error.startsWith("Feature ownership is blocked:"))
        ? "blocked"
        : maps.errors.some((error) => /No Feature Maps|unconfigured/.test(error))
          ? "incomplete"
          : "failed",
    );
    const coverage = architectureCoverage(root, { allowExternalRuntime: false });
    report.architecture = coverage;
    if (coverage.qualification === "provisional-no-real-pilot")
      report.warnings.push(
        "Python adapter is provisional: actual pilot inventory and application qualification remain outstanding.",
      );
    const architecture = coverage.errors;
    add(
      "architecture",
      architecture.length === 0,
      architecture.join("; ") ||
        `${coverage.adapter}@${coverage.version}: ${coverage.scannedFileCount} scanned source files respect declared interfaces (${coverage.qualification})`,
      `Fix ${config.architecture.policy} or the violating imports`,
      architecture.some((error) => /not-evaluated/i.test(error))
        ? "not-evaluated"
        : architecture.some((error) => /unsupported/i.test(error))
          ? "unsupported"
          : architecture.some((error) =>
                /unconfigured|has no .* source to enforce|Cannot read JSON.*ENOENT/.test(
                  error,
                ),
              )
            ? "incomplete"
            : "failed",
    );
    try {
      const policy = readRiskPolicy(root, config);
      const required = new Set([
        ...config.proof.requiredChecks,
        ...Object.values(policy.classes).flatMap((item) => item.requiredChecks),
      ]);
      const missing = [...required].filter((check) => !config.commands[check]);
      add(
        "risk",
        !missing.length,
        missing.length
          ? `Risk/proof requires unconfigured commands: ${missing.join(", ")}`
          : "Risk policy classes and command prerequisites validate; sensitive-path coverage is assessed by audit",
        "Configure commands required by risk policy and proof",
        "incomplete",
      );
    } catch (error) {
      add(
        "risk",
        false,
        String(error),
        `Repair ${config.riskPolicy} and configure its required checks`,
      );
    }
    const security = checkSecurity(root);
    add(
      "security",
      security.length === 0,
      security.join("; ") || "Local security heuristics and exceptions pass",
      `Review flagged shortcuts; dependency rationale is in ${config.security.exceptions}.dependencies and expiring exceptions are in .exceptions`,
    );
    const skills = checkSkills(root);
    add(
      "skills",
      skills.length === 0,
      skills.join("; ") || "Installed skills pack integrity and provenance pass",
      `Run arrs skills install; deliberately reconcile changed adaptations at ${config.skills.path}`,
      skills.some((error) => /Missing|ENOENT/.test(error)) ? "incomplete" : "failed",
    );
    const workflowIsFile =
      existsSync(safePath(root, config.ci.workflow)) &&
      statSync(safePath(root, config.ci.workflow)).isFile();
    add(
      "ci",
      workflowIsFile,
      `CI workflow file ${workflowIsFile ? "present" : "missing or not a regular file"}: ${config.ci.workflow}; gate invocation and hosted execution are not checked by doctor`,
      "Set ci.workflow to a supported GitHub workflow; audit inspects required gate invocations",
      "incomplete",
    );
    const agentsIsFile =
      existsSync(safePath(root, "AGENTS.md")) &&
      statSync(safePath(root, "AGENTS.md")).isFile();
    add(
      "agents",
      agentsIsFile,
      `Root AGENTS.md file ${agentsIsFile ? "present" : "missing or not a regular file"}; instruction adequacy is not assessed by this presence check`,
      "Create concise root AGENTS.md with contextual pointers",
      "incomplete",
    );
  } catch (error) {
    add(
      "config",
      false,
      error instanceof Error ? error.message : String(error),
      "Create or repair arrs.json; run arrs init for missing structure",
    );
  }
  report.healthy = report.checks.every((check) => check.passed);
  return report;
}
