import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { readArchitecture, readConfig } from "./config.js";
import { safePath, walkFiles } from "./files.js";
import type { ArchitecturePolicy } from "./types.js";
import { parsePython, resolvePython, pythonMutation, pythonContract } from "./python.js";

type Module = ArchitecturePolicy["modules"][number];
const sourcePattern = /\.[cm]?[jt]sx?$/;
const recognizedSource =
  /\.(?:[cm]?[jt]sx?|pyi?|go|rs|rb|java|kt|kts|cs|c|h|cpp|hpp|swift|php|scala|dart|ex|exs)$/;

function adapter(policy: ArchitecturePolicy): {
  id: string;
  version: string;
  pattern: RegExp;
  qualification: string;
} {
  const selected = policy.adapter ?? {
    id: "javascript-typescript",
    version: "js-ts-0.1",
  };
  if (selected.id === "javascript-typescript" && selected.version === "js-ts-0.1") {
    if (selected.packageRoots || selected.runtime)
      throw new Error("unsupported JS/TS adapter runtime/package options");
    return { ...selected, pattern: sourcePattern, qualification: "bounded-reference" };
  }
  if (selected.id === "python" && selected.version === pythonContract)
    return { ...selected, pattern: /\.py$/, qualification: "provisional-no-real-pilot" };
  throw new Error(
    `unsupported architecture adapter ${selected.id}@${selected.version}; choose javascript-typescript@js-ts-0.1 or python@${pythonContract}`,
  );
}

function owns(root: string, module: Module, file: string): boolean {
  const path = safePath(root, module.path);
  return file === path || file.startsWith(path + sep);
}
function owner(
  root: string,
  policy: ArchitecturePolicy,
  file: string,
): Module | undefined {
  return policy.modules
    .filter((module) => owns(root, module, file))
    .sort((a, b) => safePath(root, b.path).length - safePath(root, a.path).length)[0];
}
function imports(source: ts.SourceFile): Array<{ specifier?: string; line: number }> {
  const results: Array<{ specifier?: string; line: number }> = [];
  const add = (expression: ts.Node | undefined, node: ts.Node): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (
      expression &&
      (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    )
      results.push({ specifier: expression.text, line });
    else results.push({ line });
  };
  const visit = (node: ts.Node): void => {
    // Alternative loaders and require aliases otherwise bypass direct import analysis.
    if (
      (ts.isIdentifier(node) && node.text === "createRequire") ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "createRequire") ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "require" ||
          (ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "require"))) ||
      (ts.isIdentifier(node) &&
        node.text === "require" &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node)
    ) {
      results.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      add(node.moduleSpecifier, node);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression, node);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal, node);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0], node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}
function resolveLocal(
  root: string,
  absolute: string,
  specifier: string,
): string | undefined {
  const source = ts.resolveModuleName(
    specifier,
    absolute,
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      resolveJsonModule: true,
    },
    ts.sys,
  ).resolvedModule;
  if (source) {
    const file = relative(safePath(root, "."), source.resolvedFileName).replaceAll(
      "\\",
      "/",
    );
    return safePath(root, file);
  }
  const direct = relative(
    safePath(root, "."),
    resolve(dirname(absolute), specifier),
  ).replaceAll("\\", "/");
  const candidate = safePath(root, direct);
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
}
function scanSource(
  root: string,
  policy: ArchitecturePolicy,
  path: string,
  text: string,
): string[] {
  const errors: string[] = [];
  const absolute = safePath(root, path);
  const sourceModule = owner(root, policy, absolute);
  if (!sourceModule) return [`${path}: source is outside declared architecture modules`];
  if (adapter(policy).id === "python") {
    const parsed = parsePython(root, policy, path, text);
    errors.push(...parsed.errors);
    for (const entry of parsed.imports) {
      try {
        for (const target of resolvePython(root, policy, path, entry)) {
          const targetModule = owner(root, policy, target);
          const prefix = `${path}:${entry.line}`;
          if (!targetModule)
            errors.push(
              `${prefix}: Python import targets a file outside declared modules`,
            );
          else if (targetModule.id !== sourceModule.id) {
            if (!sourceModule.allows.includes(targetModule.id))
              errors.push(
                `${prefix}: ${sourceModule.id} cannot depend on ${targetModule.id}`,
              );
            else if (
              !targetModule.public.some((entry) => {
                const publicPath = safePath(root, entry);
                return (
                  target === publicPath ||
                  (statSync(publicPath).isDirectory() &&
                    target.startsWith(publicPath + sep))
                );
              })
            )
              errors.push(
                `${prefix}: Python import bypasses public interfaces of ${targetModule.id}`,
              );
          }
        }
      } catch (error) {
        errors.push(
          `${path}:${entry.line}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return errors;
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const diagnostics = /\.d\.[cm]?ts$/.test(path)
    ? []
    : (ts.transpileModule(text, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.Preserve,
        },
      }).diagnostics ?? []);
  for (const diagnostic of diagnostics)
    if (diagnostic.category === ts.DiagnosticCategory.Error)
      errors.push(
        `${path}: cannot analyze malformed source: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
  for (const entry of imports(source)) {
    const prefix = `${path}:${entry.line}`;
    if (entry.specifier === undefined) {
      errors.push(
        `${prefix}: computed import/require cannot be checked; use a literal module path`,
      );
      continue;
    }
    const specifier = entry.specifier;
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith("/") || specifier.startsWith("file:")) {
      errors.push(`${prefix}: absolute imports are not supported`);
      continue;
    }
    if (!specifier.startsWith(".")) {
      // Aliases must not create a route around the declared relative-import adapter.
      const resolved = ts.resolveModuleName(
        specifier,
        absolute,
        {
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          module: ts.ModuleKind.NodeNext,
          allowJs: true,
        },
        ts.sys,
      ).resolvedModule;
      if (
        specifier.startsWith("#") ||
        (resolved && !resolved.resolvedFileName.includes("/node_modules/"))
      )
        errors.push(
          `${prefix}: repository aliases are unsupported; use explicit relative imports`,
        );
      continue;
    }
    let target: string | undefined;
    try {
      target = resolveLocal(root, absolute, specifier);
    } catch (error) {
      errors.push(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!target) {
      errors.push(`${prefix}: unresolved local import ${specifier}`);
      continue;
    }
    const targetModule = owner(root, policy, target);
    if (!targetModule) {
      errors.push(
        `${prefix}: import ${specifier} targets a file outside declared modules`,
      );
      continue;
    }
    if (targetModule.id === sourceModule.id) continue;
    if (!sourceModule.allows.includes(targetModule.id)) {
      errors.push(`${prefix}: ${sourceModule.id} cannot depend on ${targetModule.id}`);
      continue;
    }
    if (
      !targetModule.public.some((entry) => {
        const path = safePath(root, entry);
        return (
          target === path ||
          (statSync(path).isDirectory() && target.startsWith(path + sep))
        );
      })
    )
      errors.push(
        `${prefix}: ${specifier} bypasses public interfaces of ${targetModule.id}`,
      );
  }
  return errors;
}

function moduleFiles(root: string, policy: ArchitecturePolicy, module: Module): string[] {
  // Traverse each handwritten module independently so handwritten islands inside
  // generated parents remain covered without visiting the generated parent output.
  const base = safePath(root, module.path);
  const excludedPaths = policy.modules
    .filter(
      (candidate) =>
        candidate.generated &&
        owns(root, module, safePath(root, candidate.path)) &&
        safePath(root, candidate.path) !== base,
    )
    .map((candidate) => candidate.path);
  return walkFiles(root, module.path, { includeIgnored: true, excludedPaths }).filter(
    (path) => !owner(root, policy, safePath(root, path))?.generated,
  );
}

function moduleSources(
  root: string,
  policy: ArchitecturePolicy,
  module: Module,
): string[] {
  return moduleFiles(root, policy, module).filter((path) => recognizedSource.test(path));
}

function sources(root: string, policy: ArchitecturePolicy): string[] {
  const selected = adapter(policy);
  const files = [
    ...new Set(
      policy.modules
        .filter((module) => !module.generated)
        .flatMap((module) => moduleSources(root, policy, module)),
    ),
  ].sort();
  const unsupported = files.filter((path) => !selected.pattern.test(path));
  if (unsupported.length)
    throw new Error(
      `unsupported mixed-language source for ${selected.id}@${selected.version}: ${unsupported.join(", ")}; declare separately verified scopes`,
    );
  return files;
}

/** Enforces declared modules for TS/JS literal imports, exports, dynamic imports and require. */
export interface ArchitectureCoverage {
  adapter: string;
  version: string;
  qualification: string;
  sourceFileCount: number;
  scannedFileCount: number;
  unscannedFiles: string[];
  scope: string[];
  errors: string[];
}

export interface ArchitectureOptions {
  allowExternalRuntime?: boolean;
}

export function architectureCoverage(
  root: string,
  options: ArchitectureOptions = {},
): ArchitectureCoverage {
  let summary: ArchitectureCoverage = {
    adapter: "unsupported",
    version: "unknown",
    qualification: "none",
    sourceFileCount: 0,
    scannedFileCount: 0,
    unscannedFiles: [],
    scope: [],
    errors: [],
  };
  try {
    const config = readConfig(root);
    const policy = readArchitecture(root, config);
    const selected = adapter(policy);
    summary = {
      ...summary,
      adapter: selected.id,
      version: selected.version,
      qualification: selected.qualification,
      scope: policy.modules
        .filter((module) => !module.generated)
        .map((module) => module.path),
    };
    if (!policy.modules.length)
      throw new Error(
        `Architecture is unconfigured: declare real modules, public interfaces and dependency directions in ${config.architecture.policy}`,
      );
    summary.unscannedFiles = [
      ...new Set(
        policy.modules
          .filter((module) => !module.generated)
          .flatMap((module) => moduleFiles(root, policy, module)),
      ),
    ]
      .filter((path) => !recognizedSource.test(path))
      .sort();
    const files = sources(root, policy);
    summary.sourceFileCount = files.length;
    if (!files.length)
      throw new Error(
        `Architecture policy has no ${selected.id === "javascript-typescript" ? "TS/JS" : selected.id} source to enforce; configure real module paths`,
      );
    if (selected.id === "python" && options.allowExternalRuntime === false)
      throw new Error(
        "Python architecture analysis not-evaluated: configured external runtime execution is disabled for read-only assessment; explicitly execute a trusted gate or audit to analyze source",
      );
    const errors: string[] = [];
    // A configured paths/baseUrl resolver changes import meaning; v0.1 deliberately rejects it.
    for (const file of (adapter(policy).id === "python" ? [] : walkFiles(root)).filter(
      (path) => /(^|\/)tsconfig[^/]*\.json$/.test(path),
    )) {
      const config = ts.readConfigFile(safePath(root, file), ts.sys.readFile);
      if (config.error) {
        errors.push(`${file}: cannot parse TypeScript configuration`);
        continue;
      }
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(safePath(root, file)),
      );
      const options = parsed.options;
      if (options.paths || options.baseUrl)
        errors.push(
          `${file}: compilerOptions.paths/baseUrl are unsupported by the v0.1 architecture adapter`,
        );
    }
    for (const file of files) {
      try {
        errors.push(
          ...scanSource(root, policy, file, readFileSync(safePath(root, file), "utf8")),
        );
        summary.scannedFileCount++;
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...summary, errors };
  } catch (error) {
    return {
      ...summary,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function checkArchitecture(
  root: string,
  options: ArchitectureOptions = {},
): string[] {
  return architectureCoverage(root, options).errors;
}

/** Mutation guard uses the same AST scanner with a forbidden import injected into real source. */
export function checkArchitectureGuard(root: string): string[] {
  try {
    const config = readConfig(root);
    const policy = readArchitecture(root, config);
    if (!policy.modules.length)
      return [
        `Architecture is unconfigured: declare real modules, public interfaces and dependency directions in ${config.architecture.policy}`,
      ];
    const files = sources(root, policy);
    for (const source of files) {
      const sourceModule = owner(root, policy, safePath(root, source));
      if (!sourceModule) continue;
      const targetModule = policy.modules.find(
        (module) =>
          !module.generated &&
          module.id !== sourceModule.id &&
          !sourceModule.allows.includes(module.id),
      );
      if (!targetModule) continue;
      const target = moduleSources(root, policy, targetModule).find(
        (file) =>
          adapter(policy).pattern.test(file) &&
          owner(root, policy, safePath(root, file))?.id === targetModule.id,
      );
      if (!target) continue;
      let specifier = relative(
        dirname(safePath(root, source)),
        safePath(root, target),
      ).replaceAll("\\", "/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      const errors = scanSource(
        root,
        policy,
        source,
        readFileSync(safePath(root, source), "utf8") +
          (adapter(policy).id === "python"
            ? pythonMutation(root, policy, target)
            : `\nimport ${JSON.stringify(specifier)};\n`),
      );
      return errors.some((error) =>
        error.includes(`${sourceModule.id} cannot depend on ${targetModule.id}`),
      )
        ? []
        : ["Architecture mutation guard failed to reject a forbidden module dependency"];
    }
    return [
      "Architecture has no executable forbidden dependency to mutation-test; declare at least two real modules and an enforced dependency direction",
    ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
