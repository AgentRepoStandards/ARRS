import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readJson, safePath } from "./files.js";
import type { ArrsConfig } from "./types.js";

type Line = { indent: number; text: string; number: number };
type Field = { key: string; value: string; line: Line };
const defaultWorkflow = ".github/workflows/ci.yml";
const workflowPath = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function scalar(value: string): string {
  // This is a bounded block-mapping inspector, not a general YAML parser.
  // Quoted scalar commands are supported; flow mappings and aliases are not.
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function field(line: Line): Field | undefined {
  const match = /^(?:["']([^"']+)["']|([\w.-]+)):\s*(.*)$/.exec(line.text);
  if (!match) return undefined;
  return { key: match[1] ?? match[2] ?? "", value: match[3] ?? "", line };
}

function below(lines: Line[], parent: Line): Line[] {
  const start = lines.indexOf(parent) + 1;
  let end = start;
  while (end < lines.length && (lines[end]?.indent ?? 0) > parent.indent) end++;
  return lines.slice(start, end);
}

function direct(lines: Line[]): Line[] {
  const indent = Math.min(...lines.map((line) => line.indent));
  return lines.filter((line) => line.indent === indent);
}

function fields(lines: Line[], errors: string[], location: string): Field[] {
  const result: Field[] = [];
  for (const line of direct(lines)) {
    const value = field(line);
    if (!value) {
      errors.push(
        `Unsupported CI YAML at ${location}:${line.number}; use block mappings`,
      );
      continue;
    }
    if (result.some((prior) => prior.key === value.key))
      errors.push(
        `Invalid CI YAML: duplicate ${value.key} at ${location}:${line.number}`,
      );
    result.push(value);
  }
  return result;
}

// Establish ownership for all descendants before selecting semantic fields.
// Empty values admit nested block mappings/sequences; literal blocks own opaque
// contents. Ordinary scalar/inline values cannot own a deeper YAML block.
function structure(
  lines: Line[],
  sourceLines: string[],
  errors: string[],
  location: string,
): void {
  const pending: { lines: Line[]; indent?: number }[] = [{ lines }];
  while (pending.length) {
    const block = pending.pop()!;
    if (!block.lines.length) continue;
    const members = direct(block.lines);
    const indent = block.indent ?? members[0]!.indent;
    if (block.lines[0]!.indent !== indent || members[0]!.indent !== indent) {
      errors.push(
        `Unsupported CI YAML at ${location}:${block.lines[0]!.number}; inconsistent block indentation`,
      );
      continue;
    }
    const sequence = /^-($|\s)/.test(members[0]!.text);
    const keys = new Set<string>();
    for (const [index, line] of members.entries()) {
      const end = members[index + 1];
      const content = block.lines.slice(
        block.lines.indexOf(line) + 1,
        end ? block.lines.indexOf(end) : undefined,
      );
      let source: string;
      if (sequence) {
        if (!/^-($|\s)/.test(line.text)) {
          errors.push(
            `Unsupported CI YAML at ${location}:${line.number}; mixed mapping and sequence entries`,
          );
          continue;
        }
        source = line.text.replace(/^-\s*/, "");
        const first = { ...line, indent: line.indent + 2, text: source };
        if (field(first)) {
          pending.push({ lines: [first, ...content], indent: first.indent });
          continue;
        }
      } else {
        const value = field(line);
        if (!value) {
          errors.push(
            `Unsupported CI YAML at ${location}:${line.number}; expected a block mapping field`,
          );
          continue;
        }
        if (keys.has(value.key))
          errors.push(
            `Invalid CI YAML: duplicate ${value.key} at ${location}:${line.number}`,
          );
        keys.add(value.key);
        source = value.value;
      }
      const value = source.replace(/\s+#.*$/, "").trim();
      if (/^[|>][+-]?$/.test(value)) {
        // Comments inside a literal are scalar contents. Use physical lines so
        // their indentation still establishes the block even when script
        // inspection later ignores them as shell comments.
        let firstContent: { indent: number; number: number } | undefined;
        let leadingBlank: { indent: number; number: number } | undefined;
        let terminatedAt: number | undefined;
        for (let index = line.number; index < sourceLines.length; index++) {
          const source = sourceLines[index]!;
          const indent = source.match(/^ */)?.[0].length ?? 0;
          if (!source.trim()) {
            if (!firstContent && (!leadingBlank || indent > leadingBlank.indent))
              leadingBlank = { indent, number: index + 1 };
            continue;
          }
          const comment = source.trimStart().startsWith("#");
          if (!comment && indent <= line.indent) break;
          if (
            comment &&
            (terminatedAt !== undefined ||
              indent <= line.indent ||
              (firstContent && indent < firstContent.indent))
          ) {
            terminatedAt ??= index + 1;
            continue;
          }
          if (terminatedAt !== undefined) {
            errors.push(
              `Unsupported CI YAML at ${location}:${index + 1}; literal contents resume after the dedented comment at line ${terminatedAt}`,
            );
            break;
          }
          firstContent ??= { indent, number: index + 1 };
          if (leadingBlank && leadingBlank.indent > firstContent.indent) {
            errors.push(
              `Unsupported CI YAML at ${location}:${leadingBlank.number}; leading blank indentation exceeds literal contents established at line ${firstContent.number}`,
            );
            break;
          }
          if (indent < firstContent.indent) {
            errors.push(
              `Unsupported CI YAML at ${location}:${index + 1}; literal contents must retain the indentation established at line ${firstContent.number}`,
            );
            break;
          }
        }
        continue;
      }
      if (!content.length) continue;
      if (value) {
        errors.push(
          `Unsupported CI YAML at ${location}:${content[0]!.number}; scalar/inline value at line ${line.number} cannot own indented descendants`,
        );
      } else pending.push({ lines: content });
    }
  }
}

const jobIdentifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function needsText(source: string): string {
  let quote: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (quote === '"' && character === "\\") index++;
      else if (character === quote) {
        if (quote === "'" && source[index + 1] === "'") index++;
        else quote = undefined;
      }
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(source[index - 1] ?? "")))
      return source.slice(0, index).trim();
  }
  if (quote) throw new Error("unterminated quoted identifier");
  return source.trim();
}

function needsIdentifier(source: string): string {
  const text = needsText(source);
  const quoted = text.startsWith('"') || text.startsWith("'");
  const value: unknown = text.startsWith('"')
    ? JSON.parse(text)
    : text.startsWith("'") && text.endsWith("'")
      ? text.slice(1, -1).replaceAll("''", "'")
      : text;
  if (
    typeof value !== "string" ||
    !jobIdentifier.test(value) ||
    (!quoted && /^(?:null|true|false)$/i.test(value))
  )
    throw new Error("expected a literal job identifier");
  return value;
}

function jobNeeds(
  job: string,
  values: Field[],
  lines: Line[],
  errors: string[],
): string[] {
  const needs = values.find((item) => item.key === "needs");
  if (!needs) return [];
  try {
    const text = needsText(needs.value);
    const children = below(lines, needs.line);
    if (text) {
      if (children.length) throw new Error("unexpected scalar/sequence continuation");
      if (text.startsWith("[")) {
        if (!text.endsWith("]")) throw new Error("unterminated inline sequence");
        const entries = text.slice(1, -1).trim();
        return entries ? entries.split(",").map(needsIdentifier) : [];
      }
      return [needsIdentifier(text)];
    }
    if (
      !children.length ||
      children.some(
        (line) => line.indent !== children[0]?.indent || !/^-\s+/.test(line.text),
      )
    )
      throw new Error("expected an indented literal sequence without nested children");
    return children.map((line) => needsIdentifier(line.text.replace(/^-\s+/, "")));
  } catch (error) {
    errors.push(
      `Unsupported CI needs in job ${job}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function dependencyGraph(graph: Map<string, string[]>, errors: string[]): void {
  for (const [job, dependencies] of graph)
    for (const dependency of dependencies) {
      if (!graph.has(dependency))
        errors.push(`Invalid CI job ${job}: unknown dependency ${dependency}`);
      else if (job === dependency)
        errors.push(`Invalid CI job ${job}: self-dependency ${dependency}`);
    }
  // Iterative traversal also checks disconnected/ungated jobs without consuming
  // the JavaScript call stack. Report a concrete first cycle, not downstream jobs.
  const state = new Map<string, number>();
  for (const initial of graph.keys()) {
    if (state.has(initial)) continue;
    const stack = [{ job: initial, next: 0 }];
    const positions = new Map([[initial, 0]]);
    state.set(initial, 1);
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      const dependency = graph.get(current.job)?.[current.next++];
      if (dependency === undefined) {
        state.set(current.job, 2);
        positions.delete(current.job);
        stack.pop();
      } else if (graph.has(dependency) && dependency !== current.job) {
        if (state.get(dependency) === 1) {
          const cycle = stack.slice(positions.get(dependency)).map((item) => item.job);
          errors.push(
            `Invalid CI dependency cycle: ${[...cycle, dependency].join(" -> ")}`,
          );
          return;
        }
        if (!state.has(dependency)) {
          positions.set(dependency, stack.length);
          state.set(dependency, 1);
          stack.push({ job: dependency, next: 0 });
        }
      }
    }
  }
}

function unrestricted(values: Field[], errors: string[], artifact = false): void {
  for (const item of values) {
    const value = scalar(item.value);
    if (item.key === "continue-on-error" && value !== "false")
      errors.push("CI gates must not suppress command failure through continue-on-error");
    if (
      item.key === "if" &&
      !(artifact && /^(?:always\(\)|\$\{\{\s*always\(\)\s*\}\})$/.test(value))
    )
      errors.push(
        "Unsupported CI condition: gating jobs/steps must be unconditional; only artifact-upload always() conditions are supported",
      );
  }
}

function scriptLines(value: Field, lines: Line[], errors: string[]): string[] {
  const source = scalar(value.value);
  if (/^\|[+-]?$/.test(source))
    return below(lines, value.line).map((line) => line.text.trim());
  if (
    /^[>|]/.test(source) ||
    !source ||
    /^[*&!{[]/.test(source) ||
    below(lines, value.line).length
  ) {
    errors.push("Unsupported CI run scalar; use a literal command or literal | block");
    return [];
  }
  return [source];
}

function commands(lines: string[], errors: string[]): string[] {
  const active = lines
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
  // Counting text inside shell branches, substitutions or commands with masked
  // status would assert more than this static adapter can establish.
  if (
    active.some(
      (line) =>
        /[;&|`\\<>(){}]|\$\(|\$\{\{|(?:^|\s)(?:if|then|else|fi|for|while|until|case|trap|exit|exec|return|set|function|cd|pushd|popd|alias|unalias|shopt|eval|source|enable|hash)(?:\s|$)|^(?:!|\.\s)/.test(
          line,
        ) || ["'", '"'].some((quote) => line.split(quote).length % 2 === 0),
    )
  ) {
    errors.push(
      "Unsupported CI shell control or failure suppression; expose unconditional direct gate commands",
    );
    return [];
  }
  return active;
}

function auditInvocation(line: string): boolean {
  const match =
    /^(?:npx(?: --no-install)? arrs|arrs|node dist\/cli\.js) audit\s+(.+)$/.exec(line);
  if (!match) return false;
  let executed = false;
  let required = false;
  const args = (match[1] ?? "").split(/\s+/);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--execute") executed = true;
    else if (arg === "--require-level" && args[index + 1] === "4") {
      required = true;
      index++;
    } else if (arg !== "--json") return false;
  }
  return executed && required;
}

function eventTriggers(
  lines: Line[],
  trigger: Field | undefined,
  errors: string[],
  path: string,
): void {
  if (!trigger) {
    errors.push("Invalid CI workflow: no GitHub Actions event triggers");
    return;
  }
  const value = scalar(trigger.value);
  const declarations = !value ? fields(below(lines, trigger.line), errors, path) : [];
  if (declarations.some((item) => !["", "null", "{}"].includes(scalar(item.value))))
    errors.push(
      "Unsupported CI block event trigger scalar; use an empty/null event declaration or a block mapping of event options",
    );
  const events = !value
    ? declarations.map((item) => item.key)
    : /^\[[^\[\]{}]*\]$/.test(value)
      ? value
          .slice(1, -1)
          .split(",")
          .map((event) => scalar(event))
      : [value];
  // This is an explicit adapter boundary, not GitHub's full event schema.
  const supported = ["push", "pull_request", "workflow_dispatch"];
  if (!events.length || events.every((event) => !event))
    errors.push("Invalid CI workflow: no GitHub Actions event triggers");
  else if (events.some((event) => !supported.includes(event)))
    errors.push(
      "Unsupported CI event trigger syntax/name; static inspection supports push, pull_request and workflow_dispatch in scalar, inline sequence or block mapping form",
    );
}

/** Static inspection of a supported GitHub Actions workflow; no commands run. */
export function checkCI(root: string, config: Pick<ArrsConfig, "ci">): string[] {
  const errors: string[] = [];
  const path = config.ci.workflow;
  try {
    const absolute = safePath(root, path);
    if (!workflowPath.test(path))
      return [
        `Unsupported CI provider/location ${path}; v0.1 inspects GitHub Actions .github/workflows/*.yml or *.yaml`,
      ];
    if (!existsSync(absolute))
      return [`Missing CI workflow: ${path}; configure ci.workflow`];
    const text = readFileSync(absolute, "utf8");
    if (text.length > 256_000)
      return [
        "Unsupported CI workflow size; maximum static inspection size is 256000 characters",
      ];
    const sourceLines = text.split(/\r?\n/);
    const lines: Line[] = sourceLines.flatMap((text, index) => {
      if (!text.trim() || text.trimStart().startsWith("#")) return [];
      if (/^\s*\t/.test(text))
        errors.push(`Unsupported CI tab indentation at ${path}:${index + 1}`);
      return [
        {
          indent: text.match(/^ */)?.[0].length ?? 0,
          text: text.trim(),
          number: index + 1,
        },
      ];
    });
    structure(lines, sourceLines, errors, path);
    const top = fields(lines, errors, path);
    if (
      top.some(
        (item) =>
          ![
            "name",
            "run-name",
            "on",
            "permissions",
            "env",
            "defaults",
            "concurrency",
            "jobs",
          ].includes(item.key),
      )
    )
      errors.push(
        "Unsupported CI top-level fields; use supported GitHub Actions workflow fields",
      );
    const jobs = top.find((item) => item.key === "jobs");
    eventTriggers(
      lines,
      top.find((item) => item.key === "on"),
      errors,
      path,
    );
    if (!jobs || scalar(jobs.value))
      return [...errors, "Unsupported CI jobs; use a block mapping of jobs"];
    const runCommands: string[] = [];
    const declaredJobs = fields(below(lines, jobs.line), errors, path);
    const graph = new Map(declaredJobs.map((job) => [job.key, [] as string[]]));
    for (const job of declaredJobs) {
      if (!jobIdentifier.test(job.key))
        errors.push(
          `Unsupported CI job identifier ${job.key}; use a literal GitHub job identifier`,
        );
      if (scalar(job.value)) {
        errors.push(`Unsupported CI job ${job.key}; use an explicit block mapping`);
        continue;
      }
      const jobFields = fields(below(lines, job.line), errors, path);
      graph.set(job.key, jobNeeds(job.key, jobFields, lines, errors));
      unrestricted(jobFields, errors);
      if (
        jobFields.some(
          (item) =>
            ![
              "name",
              "needs",
              "runs-on",
              "permissions",
              "environment",
              "concurrency",
              "outputs",
              "env",
              "defaults",
              "if",
              "steps",
              "timeout-minutes",
              "strategy",
              "continue-on-error",
              "container",
              "services",
              "uses",
              "with",
              "secrets",
            ].includes(item.key),
        )
      )
        errors.push(`Unsupported CI fields in job ${job.key}`);
      const strategy = jobFields.find((item) => item.key === "strategy");
      if (strategy) {
        if (scalar(strategy.value))
          errors.push(
            "Unsupported CI strategy; use explicit nonempty literal matrix dimensions",
          );
        else {
          const matrix = fields(below(lines, strategy.line), errors, path).find(
            (item) => item.key === "matrix",
          );
          if (matrix) {
            const dimensions = scalar(matrix.value)
              ? []
              : fields(below(lines, matrix.line), errors, path);
            if (
              !dimensions.length ||
              dimensions.some(
                (dimension) =>
                  ["include", "exclude"].includes(dimension.key) ||
                  !/^\[\s*[^\s\[\]{}][^\[\]{}]*\]$/.test(scalar(dimension.value)),
              )
            )
              errors.push(
                "Unsupported CI matrix; empty/dynamic dimensions and include/exclude conditions leave gate execution unestablished",
              );
          }
        }
      }
      if (jobFields.some((item) => item.key === "uses")) {
        errors.push(
          `Unsupported reusable CI workflow in job ${job.key}; expose required gates locally`,
        );
        continue;
      }
      if (!jobFields.some((item) => item.key === "runs-on" && scalar(item.value)))
        errors.push(`Invalid CI job ${job.key}: missing runs-on`);
      const steps = jobFields.find((item) => item.key === "steps");
      if (!steps || scalar(steps.value)) {
        errors.push(`Unsupported CI steps in job ${job.key}; use an explicit sequence`);
        continue;
      }
      const stepLines = below(lines, steps.line);
      const stepStarts = direct(stepLines);
      for (const [index, start] of stepStarts.entries()) {
        if (!start.text.startsWith("- ")) {
          errors.push(`Unsupported CI step at ${path}:${start.number}`);
          continue;
        }
        const end = stepStarts[index + 1];
        const content = stepLines.slice(
          stepLines.indexOf(start),
          end ? stepLines.indexOf(end) : undefined,
        );
        const first = { ...start, indent: start.indent + 2, text: start.text.slice(2) };
        const normalized = [first, ...content.slice(1)];
        const values = fields(normalized, errors, path);
        const uses = values.find((item) => item.key === "uses");
        const artifact = /^actions\/upload-artifact@/.test(scalar(uses?.value ?? ""));
        unrestricted(values, errors, artifact);
        const run = values.find((item) => item.key === "run");
        if (!run) continue;
        if (uses)
          errors.push(`Invalid CI step at ${path}:${start.number}: both uses and run`);
        if (values.some((item) => item.key === "shell"))
          errors.push(
            "Unsupported CI custom shell; default shell failure handling is required",
          );
        const commandLines = commands(scriptLines(run, normalized, errors), errors);
        const runner = scalar(
          jobFields.find((item) => item.key === "runs-on")?.value ?? "",
        );
        if (
          commandLines.length > 1 &&
          !/^(?:ubuntu|macos)-(?:latest|\d+(?:\.\d+)?)$/.test(runner)
        )
          errors.push(
            "Unsupported CI multiline commands on an unestablished default shell; use separate run steps so each gate preserves its exit status",
          );
        if (
          values.some((item) => item.key === "working-directory") ||
          jobFields.some((item) => item.key === "defaults") ||
          top.some((item) => item.key === "defaults")
        )
          errors.push(
            "Unsupported CI working directory/defaults; direct gates must run at the repository root",
          );
        if (
          values.some(
            (item) =>
              ![
                "name",
                "id",
                "run",
                "if",
                "continue-on-error",
                "shell",
                "working-directory",
                "env",
                "timeout-minutes",
              ].includes(item.key),
          )
        )
          errors.push(`Unsupported CI run step fields at ${path}:${start.number}`);
        runCommands.push(...commandLines);
      }
    }
    dependencyGraph(graph, errors);
    const usesNpmGates = runCommands.some((line) =>
      /^npm (?:run (?:check|test|verify|audit)|test)$/.test(line),
    );
    const pkg = usesNpmGates
      ? (readJson(root, "package.json") as { scripts?: Record<string, unknown> })
      : undefined;
    for (const gate of ["check", "test", "verify"])
      if (
        !runCommands.some((line) => {
          if (line === `npm run ${gate}` || (gate === "test" && line === "npm test")) {
            const script = pkg?.scripts?.[gate];
            return typeof script === "string" && script.trim().length > 0;
          }
          return new RegExp(
            `^(?:(?:\\./repo|node repo) ${gate}|(?:arrs|npx(?: --no-install)? arrs|node dist/cli\\.js) run ${gate})$`,
          ).test(line);
        })
      )
        errors.push(
          `CI must invoke an actual ${gate} gate (npm run ${gate} or ./repo ${gate})`,
        );
    let audited = runCommands.some(auditInvocation);
    if (runCommands.some((line) => /^npm run audit$/.test(line))) {
      const source = pkg?.scripts?.audit;
      const script =
        typeof source === "string" ? commands(source.split(/\r?\n/), errors) : [];
      if (script.length === 1 && auditInvocation(script[0] ?? "")) audited = true;
      else
        errors.push(
          "npm run audit must directly invoke audit --execute --require-level 4",
        );
    }
    if (!audited) errors.push("CI must invoke audit --execute --require-level 4");
  } catch (error) {
    errors.push(
      `Cannot assess CI workflow ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [...new Set(errors)];
}

/** Bounded bootstrap discovery. Existing explicit configuration is authoritative. */
export function discoverCIWorkflow(root: string): {
  workflow: string;
  warnings: string[];
} {
  try {
    if (!existsSync(root))
      return {
        workflow: defaultWorkflow,
        warnings: [
          "Configure ci.workflow to a GitHub Actions workflow that invokes the required gates",
        ],
      };
    const directory = safePath(root, ".github/workflows");
    if (!existsSync(directory))
      return {
        workflow: defaultWorkflow,
        warnings: [
          "Configure ci.workflow to a GitHub Actions workflow that invokes the required gates",
        ],
      };
    const workflows = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => /\.ya?ml$/.test(entry.name) && entry.isFile())
      .map((entry) => `.github/workflows/${entry.name}`)
      .sort();
    if (workflows.length > 100)
      return {
        workflow: defaultWorkflow,
        warnings: [
          "CI discovery is limited to 100 workflow files; configure ci.workflow explicitly",
        ],
      };
    if (workflows.length === 1)
      return { workflow: workflows[0] ?? defaultWorkflow, warnings: [] };
    const qualified = workflows.filter(
      (workflow) => !checkCI(root, { ci: { workflow } }).length,
    );
    if (qualified.length === 1)
      return { workflow: qualified[0] ?? defaultWorkflow, warnings: [] };
    return {
      workflow: defaultWorkflow,
      warnings: [
        workflows.length
          ? `Multiple GitHub Actions workflows found (${workflows.join(", ")}); configure ci.workflow explicitly`
          : "Configure ci.workflow to a GitHub Actions workflow that invokes the required gates",
      ],
    };
  } catch (error) {
    return {
      workflow: defaultWorkflow,
      warnings: [
        `Cannot discover CI workflows: ${error instanceof Error ? error.message : String(error)}; configure ci.workflow explicitly`,
      ],
    };
  }
}
