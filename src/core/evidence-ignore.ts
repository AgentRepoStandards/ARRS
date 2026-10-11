import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { safePath } from "./files.js";

export interface IgnoreProtection {
  method: "git" | "scoped-marker";
  detail: string;
}

/** Conservative subtree protection, not secret storage or removal of already tracked files. */
export function evidenceIgnoreProtection(
  root: string,
  directory: string,
): IgnoreProtection {
  const reserved = safePath(root, ".arrs");
  const absolute = safePath(root, directory);
  if (!absolute.startsWith(reserved + sep))
    throw new Error("Evidence must be strictly below repository-root .arrs/.");
  const normalized = relative(safePath(root, "."), absolute).replaceAll(sep, "/");
  const remediation =
    "Protect the whole evidence directory in Git ignore rules, or establish .arrs/.gitignore with '*\\n!.gitignore\\n'; existing user files are preserved.";
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 5000,
      maxBuffer: 65536,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  const probe = git(["rev-parse", "--is-inside-work-tree"]);
  const missing = (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const notWorktree =
    !probe.error &&
    ((probe.status === 0 && probe.stdout.trim() === "false") ||
      (probe.status === 128 && probe.stderr.includes("not a git repository")));
  let conventionReason = "Git ignore state was unavailable";
  if (!missing && !notWorktree) {
    if (probe.error || probe.status !== 0 || probe.stdout.trim() !== "true")
      throw new Error(
        `Cannot establish Git evidence ignore protection: ${probe.error?.message ?? probe.stderr.trim()}. ${remediation}`,
      );
    // Git treats absent paths as files, so directory-only negations can be missed.
    // Only an existing directory can establish measured subtree exclusion.
    let candidate = absolute;
    while (!existsSync(candidate)) candidate = dirname(candidate);
    if (!statSync(candidate).isDirectory())
      throw new Error(`Evidence parent is not a directory. ${remediation}`);
    const candidatePath =
      relative(safePath(root, "."), candidate).replaceAll(sep, "/") || ".";
    const ignored = git(["check-ignore", "--no-index", "--quiet", "--", candidatePath]);
    if (ignored.error || (ignored.status !== 0 && ignored.status !== 1))
      throw new Error(
        `Cannot establish Git evidence ignore protection: ${ignored.error?.message ?? ignored.stderr.trim()}. ${remediation}`,
      );
    if (ignored.status === 0)
      return {
        method: "git",
        detail:
          "Git confirms exclusion of the existing evidence directory or an existing ancestor, including inherited rules in a containing worktree. Already tracked files are not untracked.",
      };
    if (candidate === absolute)
      throw new Error(
        `Evidence directory ${normalized} is not verifiably ignored. ${remediation}`,
      );
    conventionReason =
      "The evidence directory is prospective and Git has not confirmed an ignored existing ancestor";
  }
  const marker = safePath(root, ".arrs/.gitignore");
  try {
    if (statSync(marker).size > 65536)
      throw new Error("Scoped ignore marker exceeds 64 KiB");
    const lines = readFileSync(marker, "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (
      !lines.some((line) => line === "*" || line === "/*") ||
      lines.some((line) => !["*", "/*", "!.gitignore"].includes(line))
    )
      throw new Error("Scoped marker has unsupported patterns or negations");
  } catch (error) {
    throw new Error(
      `${conventionReason}; the canonical scoped evidence convention cannot be established: ${error instanceof Error ? error.message : String(error)}. ${remediation}`,
    );
  }
  return {
    method: "scoped-marker",
    detail: `${conventionReason}. Destination Git ignore state was not measured. A canonical scoped wildcard establishes only the bounded local evidence convention; arbitrary ignore grammar is unsupported.`,
  };
}
