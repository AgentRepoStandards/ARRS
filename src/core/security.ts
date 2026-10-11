import { existsSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { readConfig } from "./config.js";
import { readJson, safePath, walkFiles } from "./files.js";
import { assertValid } from "./schema.js";

interface Exceptions {
  schemaVersion: "0.1";
  exceptions: Array<{
    path: string;
    rule: "suppression" | "remote-execution";
    match: string;
    reason: string;
    expires: string;
    approvedBy: string;
  }>;
  dependencies: Array<{ name: string; reason: string }>;
}
function maskRegexLiterals(path: string, text: string): string {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return text;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node))
      spans.push([node.getStart(source), node.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [start, end] of spans.reverse())
    text =
      text.slice(0, start) +
      text.slice(start, end).replace(/[^\n]/g, " ") +
      text.slice(end);
  return text;
}
const sourceText = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|bash|env|toml)$/i;

/** Local heuristics are guardrails, not a general security assessment. Secrets cannot be waived. */
export function checkSecurity(root: string): string[] {
  const errors: string[] = [];
  try {
    const config = readConfig(root);
    const exceptions = readJson(root, config.security.exceptions);
    assertValid<Exceptions>("exceptions", exceptions);
    const exceptionKeys = new Set<string>();
    for (const exception of exceptions.exceptions) {
      const key = `${exception.path}:${exception.rule}:${exception.match}`;
      if (exceptionKeys.has(key)) errors.push(`Duplicate security exception: ${key}`);
      exceptionKeys.add(key);
      if (!existsSync(safePath(root, exception.path)))
        errors.push(`Security exception path does not exist: ${exception.path}`);
      const expiration = Date.parse(`${exception.expires}T23:59:59Z`);
      if (
        !Number.isFinite(expiration) ||
        new Date(expiration).toISOString().slice(0, 10) !== exception.expires ||
        expiration < Date.now()
      )
        errors.push(
          `Security exception expired or invalid: ${key} (${exception.expires})`,
        );
    }
    const waived = (
      path: string,
      rule: Exceptions["exceptions"][number]["rule"],
      line: string,
    ): boolean =>
      exceptions.exceptions.some(
        (entry) =>
          entry.path === path &&
          entry.rule === rule &&
          line.includes(entry.match) &&
          Date.parse(`${entry.expires}T23:59:59Z`) >= Date.now(),
      );
    for (const path of walkFiles(root)) {
      if (
        (!sourceText.test(path) && !/(?:^|\/)\.env(?:\.[^/]+)*$/i.test(path)) ||
        path.endsWith("package-lock.json")
      )
        continue;
      const absolute = safePath(root, path);
      if (statSync(absolute).size > 2_000_000) {
        errors.push(
          `${path}: security scan text exceeds 2 MB; narrow source or separate generated output`,
        );
        continue;
      }
      const lines = maskRegexLiterals(path, readFileSync(absolute, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        const prefix = `${path}:${index + 1}`;
        if (
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(
            line,
          )
        )
          errors.push(
            `${prefix}: suspected credential/private key; remove it and rotate any exposed secret`,
          );
        if (
          /\b(?:password|api[_-]?key|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*["'][^"']{8,}["']/i.test(
            line,
          ) &&
          !/\b(?:example|placeholder|dummy|fixture|changeme)\b/i.test(line)
        )
          errors.push(
            `${prefix}: suspected hard-coded credential; use an environment or secret-provider reference`,
          );
        if (
          path !== config.security.exceptions &&
          /@ts-(?:ignore|nocheck)\b|\beslint-disable\b|\bprettier-ignore\b/.test(line) &&
          !waived(path, "suppression", line)
        )
          errors.push(
            `${prefix}: unapproved compiler/lint suppression; fix the cause or add a scoped expiring exception`,
          );
        if (
          path !== config.security.exceptions &&
          /\b(?:curl|wget)\b[^]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(line) &&
          !waived(path, "remote-execution", line)
        )
          errors.push(
            `${prefix}: unreviewed download-to-shell execution; pin and inspect the source or record an expiring review`,
          );
        if (
          /\bcontinue-on-error\s*:\s*true\b|\b(?:test|it|describe)\.skip\s*\(|--passWithNoTests\b/.test(
            line,
          )
        )
          errors.push(`${prefix}: disabled validation/test; restore the gate`);
      }
    }
    const packagePath = safePath(root, "package.json");
    if (existsSync(packagePath)) {
      const pkg = readJson(root, "package.json") as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        optionalDependencies?: Record<string, unknown>;
        scripts?: Record<string, string>;
      };
      const recorded = new Set(exceptions.dependencies.map((entry) => entry.name));
      if (recorded.size !== exceptions.dependencies.length)
        errors.push("Dependency justifications contain duplicate package names");
      for (const name of Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
      }))
        if (!recorded.has(name))
          errors.push(
            `Dependency ${name} has no recorded justification in ${config.security.exceptions}.dependencies; review the manifest inventory and record a rationale (presence alone is not approval; .exceptions contains separate expiring policy waivers)`,
          );
      for (const gate of ["check", "test", "verify", "build"])
        if (
          pkg.scripts?.[gate] &&
          /^(?:true|echo\b|exit\s+0\b)/.test(pkg.scripts[gate].trim())
        )
          errors.push(
            `package.json script ${gate} is a trivial success command; configure meaningful verification`,
          );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
