import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { safePath } from "./files.js";
import type { ArchitecturePolicy } from "./types.js";

export const pythonContract = "candidate-python-ast-0.1";
type Import = { module: string; level: number; names: string[]; line: number };
// Isolated stdlib parsing only: no application import, eval, compilation or execution.
const parser = String.raw`
import ast, json, sys
request = json.load(sys.stdin)
tree = ast.parse(request["source"], filename=request["path"])
imports, unsupported = [], []
sys_aliases = {"sys"}
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for name in node.names:
            if name.name == "sys": sys_aliases.add(name.asname or name.name)
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for name in node.names:
            imports.append({"module": name.name, "level": 0, "names": [], "line": node.lineno})
            if name.name.split(".")[0] in {"importlib", "runpy", "pkgutil"}:
                unsupported.append({"line": node.lineno, "mechanism": "custom-or-dynamic-loader"})
    elif isinstance(node, ast.ImportFrom):
        if node.module == "sys" and any(name.name in {"path", "meta_path", "path_hooks", "modules"} for name in node.names):
            unsupported.append({"line": node.lineno, "mechanism": "custom-resolver"})
        imports.append({"module": node.module or "", "level": node.level, "names": [name.name for name in node.names], "line": node.lineno})
        if (node.module or "").split(".")[0] in {"importlib", "runpy", "pkgutil"}:
            unsupported.append({"line": node.lineno, "mechanism": "custom-or-dynamic-loader"})
    elif isinstance(node, ast.Name) and node.id in {"__import__", "eval", "exec"}:
        unsupported.append({"line": node.lineno, "mechanism": "computed-or-dynamic-loading"})
    elif isinstance(node, ast.Attribute):
        if node.attr == "__import__" or (isinstance(node.value, ast.Name) and node.value.id in sys_aliases and node.attr in {"path", "meta_path", "path_hooks", "modules"}):
            unsupported.append({"line": node.lineno, "mechanism": "custom-resolver"})
print(json.dumps({"version": "candidate-python-ast-0.1", "imports": imports, "unsupported": unsupported}))
`;

export function parsePython(
  root: string,
  policy: ArchitecturePolicy,
  path: string,
  source: string,
): { imports: Import[]; errors: string[] } {
  resolvePython(root, policy, path, {
    module: pythonModuleName(root, policy, path),
    level: 0,
    names: [],
    line: 1,
  });
  const runtime = policy.adapter?.runtime;
  if (!runtime?.argv.length)
    throw new Error("Python adapter requires literal runtime argv");
  if (Buffer.byteLength(source) > 2 * 1024 * 1024)
    throw new Error(`${path}: Python source exceeds 2 MiB analysis bound`);
  const result = spawnSync(runtime.argv[0]!, ["-I", "-S", "-c", parser], {
    cwd: safePath(root, "."),
    input: JSON.stringify({ path, source }),
    encoding: "utf8",
    timeout: (runtime.timeoutSeconds ?? 5) * 1000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `${path}: Python parser failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`}); no coverage awarded`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${path}: malformed Python parser output`);
  }
  const record = value as { version?: unknown; imports?: unknown; unsupported?: unknown };
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(",") !== "imports,unsupported,version" ||
    record.version !== pythonContract ||
    !Array.isArray(record.imports) ||
    !Array.isArray(record.unsupported) ||
    record.imports.length > 10000 ||
    record.unsupported.length > 10000
  )
    throw new Error(`${path}: incomplete or unsupported Python parser output`);
  for (const entry of record.imports) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "level,line,module,names" ||
      typeof entry.module !== "string" ||
      !Number.isSafeInteger(entry.level) ||
      entry.level < 0 ||
      !Number.isSafeInteger(entry.line) ||
      entry.line < 1 ||
      !Array.isArray(entry.names) ||
      entry.names.some((name: unknown) => typeof name !== "string")
    )
      throw new Error(`${path}: malformed Python import diagnostic`);
  }
  const errors: string[] = [];
  for (const entry of record.unsupported) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "line,mechanism" ||
      !Number.isSafeInteger(entry.line) ||
      entry.line < 1 ||
      ![
        "custom-or-dynamic-loader",
        "computed-or-dynamic-loading",
        "custom-resolver",
      ].includes(entry.mechanism)
    )
      throw new Error(`${path}: malformed Python unsupported diagnostic`);
    errors.push(`${path}:${entry.line}: unsupported Python ${entry.mechanism}`);
  }
  return { imports: record.imports as Import[], errors };
}

/** Resolve ordinary local packages without importing them or executing initializers. */
export function resolvePython(
  root: string,
  policy: ArchitecturePolicy,
  source: string,
  entry: Import,
): string[] {
  const roots = policy.adapter?.packageRoots ?? [];
  const rootPaths = roots.map((path) => safePath(root, path));
  const sourcePath = safePath(root, source);
  const containing = rootPaths
    .filter((base) => sourcePath.startsWith(base + sep))
    .sort((a, b) => b.length - a.length)[0];
  if (!containing)
    throw new Error("unsupported Python source outside explicit package roots");
  let bases: string[];
  if (entry.level) {
    let base = dirname(sourcePath);
    for (let level = 1; level < entry.level; level++) base = dirname(base);
    if (base === containing || !base.startsWith(containing + sep))
      throw new Error("Python relative import escapes its configured package root");
    bases = [resolve(base, ...entry.module.split(".").filter(Boolean))];
  } else {
    bases = rootPaths.map((base) => resolve(base, ...entry.module.split(".")));
    const first = entry.module.split(".")[0]!;
    if (
      !rootPaths.some(
        (base) =>
          existsSync(
            safePath(
              root,
              relative(safePath(root, "."), resolve(base, first)).replaceAll("\\", "/"),
            ),
          ) ||
          existsSync(
            safePath(
              root,
              relative(safePath(root, "."), resolve(base, `${first}.py`)).replaceAll(
                "\\",
                "/",
              ),
            ),
          ),
      )
    )
      return [];
  }
  const found = new Set<string>();
  for (const base of bases) {
    const repo = relative(safePath(root, "."), base).replaceAll("\\", "/");
    const candidate = safePath(root, repo);
    const candidates = [
      safePath(root, `${repo}.py`),
      safePath(root, `${repo}/__init__.py`),
    ];
    const file = candidates.find((path) => existsSync(path) && statSync(path).isFile());
    if (!file) {
      if (existsSync(candidate) && statSync(candidate).isDirectory())
        throw new Error(`unsupported Python namespace package ${entry.module || "."}`);
      continue;
    }
    // Every intermediate package has an initializer. Its ownership is checked below.
    const packageRoot = rootPaths
      .filter((path) => file.startsWith(path + sep))
      .sort((a, b) => b.length - a.length)[0]!;
    let parent = dirname(file);
    const initializers: string[] = [];
    while (parent !== packageRoot) {
      const init = safePath(
        root,
        relative(safePath(root, "."), resolve(parent, "__init__.py")).replaceAll(
          "\\",
          "/",
        ),
      );
      if (!existsSync(init))
        throw new Error(
          `unsupported Python namespace package at ${relative(packageRoot, parent)}`,
        );
      initializers.push(init);
      parent = dirname(parent);
    }
    for (const init of initializers) {
      if (
        !policy.modules.some((module) => {
          const path = safePath(root, module.path);
          return init === path || init.startsWith(path + sep);
        })
      )
        throw new Error("Python import activates unowned local package initializer");
      found.add(init);
    }
    found.add(file);
    if (file.endsWith(`${sep}__init__.py`))
      for (const name of entry.names) {
        if (name === "*") throw new Error("unsupported Python wildcard package import");
        const child = safePath(
          root,
          relative(safePath(root, "."), resolve(base, name)).replaceAll("\\", "/"),
        );
        for (const target of [child + ".py", resolve(child, "__init__.py")]) {
          const safe = safePath(
            root,
            relative(safePath(root, "."), target).replaceAll("\\", "/"),
          );
          if (existsSync(safe) && statSync(safe).isFile()) found.add(safe);
        }
      }
  }
  if (!found.size)
    throw new Error(`unresolved repository Python import ${entry.module || "."}`);
  // Distinct configured roots must not resolve the same import to different sources.
  if (
    bases.filter(
      (base) => existsSync(`${base}.py`) || existsSync(resolve(base, "__init__.py")),
    ).length > 1
  )
    throw new Error("unsupported ambiguous Python package roots");
  return [...found];
}

function pythonModuleName(
  root: string,
  policy: ArchitecturePolicy,
  target: string,
): string {
  const absolute = safePath(root, target);
  const base = (policy.adapter?.packageRoots ?? [])
    .map((path) => safePath(root, path))
    .filter((path) => absolute.startsWith(path + sep))
    .sort((a, b) => b.length - a.length)[0];
  if (!base) throw new Error("Python guard target is outside configured package roots");
  const module = relative(base, absolute)
    .replaceAll("\\", "/")
    .replace(/\/__init__\.py$/, "")
    .replace(/\.py$/, "")
    .split("/")
    .join(".");
  if (!module.split(".").every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)))
    throw new Error("unsupported Python module/package identifier");
  return module;
}

export function pythonMutation(
  root: string,
  policy: ArchitecturePolicy,
  target: string,
): string {
  return `\nimport ${pythonModuleName(root, policy, target)}\n`;
}
