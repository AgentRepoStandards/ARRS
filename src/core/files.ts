import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Normalize a repository path without inspecting entries outside visited source. */
function repositoryPath(root: string, path: string): { base: string; target: string } {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(
      `Unsafe repository path: ${JSON.stringify(path)}; use a relative path with '/' separators`,
    );
  }
  if (path.split("/").includes(".."))
    throw new Error(`Repository path cannot contain '..': ${path}`);
  const base = realpathSync(resolve(root));
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error(`Path escapes repository: ${path}`);
  return { base, target };
}

/** Resolve an explicit repository path without allowing traversal or symlink escapes. */
export function safePath(root: string, path: string): string {
  const { base, target } = repositoryPath(root, path);
  let current = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink repository paths are not supported: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export function readJson(root: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(safePath(root, path), "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".arrs",
  ".next",
  "build",
  "vendor",
]);

/** Files (optionally directories) share bounded symlink-free traversal and portable paths. */
export function walkFiles(
  root: string,
  path = ".",
  options: {
    includeIgnored?: boolean;
    includeDirectories?: boolean;
    excludedPaths?: string[];
    maxFiles?: number;
  } = {},
): string[] {
  const results: string[] = [];
  const exclusions = (options.excludedPaths ?? []).map(
    (path) => repositoryPath(root, path).target,
  );
  const visit = (relativePath: string): void => {
    const absolute = repositoryPath(root, relativePath).target;
    if (exclusions.some((path) => absolute === path || absolute.startsWith(path + sep)))
      return;
    safePath(root, relativePath);
    const stat = lstatSync(absolute);
    if (stat.isFile() || (stat.isDirectory() && options.includeDirectories)) {
      results.push(relativePath.replaceAll(sep, "/"));
      if (results.length > (options.maxFiles ?? 30_000))
        throw new Error(`Too many files under ${path}; narrow the configured path`);
      if (stat.isFile()) return;
    }
    if (!stat.isDirectory())
      throw new Error(`Unsupported repository entry: ${relativePath}`);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!options.includeIgnored && ignoredDirectories.has(entry.name)) continue;
      visit(relativePath === "." ? entry.name : `${relativePath}/${entry.name}`);
    }
  };
  visit(path);
  return results;
}

export function hasMeaningfulText(root: string, path: string, minimum = 80): boolean {
  try {
    const files = walkFiles(root, path).filter((file) => /\.(md|txt)$/i.test(file));
    return files.some((file) => {
      const text = readFileSync(safePath(root, file), "utf8")
        .replace(/<!--[^]*?-->/g, "")
        .trim();
      return (
        text.length >= minimum &&
        !/\b(TODO|PLACEHOLDER|replace this|fill this in|Configuration requirement|Describe existing modules|Record consequential architecture decisions)\b/i.test(
          text,
        )
      );
    });
  } catch {
    return false;
  }
}

/** Hash declared scope completely, excluding only root metadata, dependencies and evidence. */
export function hashScope(root: string, path: string): string {
  const hash = createHash("sha256");
  const absolute = safePath(root, path);
  if (lstatSync(absolute).isFile())
    return hash.update(readFileSync(absolute)).digest("hex");
  for (const file of walkFiles(root, path, {
    includeIgnored: true,
    excludedPaths: [".git", ".arrs", "node_modules"],
  })) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(safePath(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
