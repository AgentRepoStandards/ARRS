import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { hasMeaningfulText, safePath, walkFiles } from "./files.js";
import type { ArrsConfig } from "./types.js";

export interface References {
  paths: string[];
  documents: string[];
  errors: string[];
}
const visibleText = (text: string): string =>
  text.replace(/<!--[^]*?-->/g, "").replace(/```[^]*?```/g, "");

/** Markdown destinations are document-relative; inline repository paths are root-relative. */
export function references(
  root: string,
  file: string,
  text: string,
  configuredPaths: string[] = [],
): References {
  const result: References = { paths: [], documents: [], errors: [] };
  const add = (destination: string, documentRelative: boolean): void => {
    if (destination.startsWith("#")) return;
    try {
      const target = decodeURIComponent(destination.split(/[?#]/)[0] ?? "");
      if (/^(?:\/|[a-z]:|file:)/i.test(target) || target.includes("\\"))
        throw new Error("Use a relative repository reference");
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) return;
      const path = posix.normalize(
        posix.join(documentRelative ? posix.dirname(file) : ".", target),
      );
      const absolute = safePath(root, path);
      if (!existsSync(absolute))
        result.errors.push(`${file}: broken repository reference ${destination}`);
      else {
        result.paths.push(path);
        if (
          documentRelative &&
          /\.(?:md|txt)$/i.test(path) &&
          statSync(absolute).isFile()
        )
          result.documents.push(path);
      }
    } catch (error) {
      result.errors.push(
        `${file}: invalid repository reference ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const textWithoutComments = visibleText(text);
  for (const match of textWithoutComments.matchAll(
    /\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^]*?["'])?\s*\)/g,
  ))
    add(match[1] ?? match[2] ?? "", true);
  for (const match of textWithoutComments.matchAll(
    /^\s*\[[^\]\n]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm,
  ))
    add(match[1] ?? match[2] ?? "", true);
  for (const match of textWithoutComments.matchAll(/`([^`\n]+)`/g)) {
    const path = (match[1] ?? "").split(/\s/)[0] ?? "";
    const normalized = posix.normalize(path);
    if (
      (path.startsWith("./") ||
        ["arrs.json", "AGENTS.md", "repo"].includes(path) ||
        configuredPaths.some((configured) => {
          const base = posix.normalize(configured);
          return normalized === base || normalized.startsWith(`${base}/`);
        })) &&
      !/[*{}<>]/.test(path)
    )
      add(path, false);
  }
  return result;
}

/** Substance and local-reference checks are heuristics, not semantic knowledge validation. */
export function checkKnowledge(root: string, path: string): string[] {
  const errors: string[] = [];
  if (!hasMeaningfulText(root, path))
    errors.push(`No substantive knowledge at ${path}; replace placeholder-only context`);
  try {
    for (const file of walkFiles(root, path).filter((entry) =>
      /\.(md|txt)$/i.test(entry),
    ))
      errors.push(
        ...references(root, file, readFileSync(safePath(root, file), "utf8")).errors,
      );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

const rules: Array<[string, RegExp]> = [
  [
    "classify change risk",
    /\b(classif\w*|establish|assess|determine)\b[^.\n]*(risk|impact)/i,
  ],
  ["bounded changes", /\b(smallest|minimal|minimum|bounded)\b[^.\n]*(change|scope)/i],
  ["correct underlying causes", /\b(root causes?|underlying causes?)\b/i],
  [
    "protect secrets",
    /\b(protect|keep|exclude|never|do not)\b[^.\n]*(secret|credential)/i,
  ],
  [
    "justify dependencies",
    /\b(justif\w*|explain|review|rationale)\b[^.\n]*(dependenc\w*|package additions?)/i,
  ],
  ["preserve tests", /\b(test\w*|regression)\b/i],
  ["preserve static checks", /\b(check\w*|compiler|static)\b/i],
  ["record proof", /\b(proof|verification evidence|acceptance evidence)\b/i],
  [
    "prohibit control bypass",
    /\b(do not|never|must not)\b[^.\n]*(weaken|bypass|disable|suppress)/i,
  ],
];

/** Follow only bounded local navigation needed to discover the durable operating contract. */
export function contextControl(root: string, config: ArrsConfig): string[] {
  const errors: string[] = [];
  try {
    const rootText = readFileSync(safePath(root, "AGENTS.md"), "utf8");
    if (
      rootText.length < 250 ||
      rootText.length > 8000 ||
      rootText.split("\n").length > 120
    )
      errors.push(
        "AGENTS.md must be a substantive concise map (250–8000 characters, <=120 lines)",
      );
    const requiredPaths = [
      config.knowledge.features,
      config.knowledge.architecture,
      config.riskPolicy,
    ];
    const found = new Set<string>();
    const visited = new Set<string>();
    const queue = [{ file: "AGENTS.md", depth: 0 }];
    let text = "";
    let bytes = 0;
    const pointsTo = (configured: string): boolean => {
      const path = posix.normalize(configured);
      return [...found].some(
        (reference) => reference === path || reference.startsWith(`${path}/`),
      );
    };
    const complete = (): boolean =>
      rules.every(([, rule]) => rule.test(text)) &&
      requiredPaths.every(pointsTo) &&
      (found.has("arrs.json") || found.has("repo"));
    while (queue.length && !complete()) {
      const entry = queue.shift()!;
      if (visited.has(entry.file)) continue;
      const absolute = safePath(root, entry.file);
      const size = statSync(absolute).size;
      if (visited.size >= 16 || bytes + size > 64_000) {
        errors.push(
          "Operating contract navigation exceeds 16 documents or 64000 bytes; provide a concise route",
        );
        break;
      }
      visited.add(entry.file);
      bytes += size;
      const document =
        entry.file === "AGENTS.md" ? rootText : readFileSync(absolute, "utf8");
      text += `\n${visibleText(document)}`;
      const refs = references(root, entry.file, document, requiredPaths);
      errors.push(...refs.errors);
      for (const path of refs.paths) found.add(path);
      if (entry.depth < 2)
        queue.push(...refs.documents.map((file) => ({ file, depth: entry.depth + 1 })));
    }
    for (const [name, rule] of rules)
      if (!rule.test(text))
        errors.push(`Operating contract lacks discoverable rules to ${name}`);
    for (const path of requiredPaths)
      if (!pointsTo(path))
        errors.push(`Operating contract must resolve a contextual reference to ${path}`);
    if (!found.has("arrs.json") && !found.has("repo"))
      errors.push(
        "Operating contract must resolve arrs.json or the repo command interface",
      );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
