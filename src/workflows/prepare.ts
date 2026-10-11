import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { safePath } from "../core/files.js";
import { renderPreparedTask, type PreparedTask } from "../core/prepare.js";

/** No process probes: output requires the explicit canonical scoped ignore convention. */
export function checkPreparationOutput(root: string, directory: string): string {
  const destination = safePath(root, directory);
  if (!destination.startsWith(safePath(root, ".arrs") + sep))
    throw new Error(
      "Preparation output must be a new directory strictly below repository-root .arrs/",
    );
  if (existsSync(destination))
    throw new Error(
      "Preparation output already exists; choose a new directory to preserve prior packets",
    );
  const marker = safePath(root, ".arrs/.gitignore");
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.size > 65536)
    throw new Error("Scoped ignore marker must be a regular file at most 64 KiB");
  const text = readFileSync(marker, "utf8");
  if (Buffer.byteLength(text) > 65536)
    throw new Error("Scoped ignore marker exceeds 64 KiB");
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  if (
    !lines.some((line) => line === "*" || line === "/*") ||
    lines.some((line) => !["*", "/*", "!.gitignore"].includes(line))
  )
    throw new Error(
      "Preparation output requires canonical .arrs/.gitignore '*\\n!.gitignore\\n'; existing ignore files are preserved",
    );
  return relative(safePath(root, "."), destination).replaceAll(sep, "/");
}

export function writePreparedTask(
  root: string,
  directory: string,
  packet: PreparedTask,
): { directory: string; files: string[] } {
  const normalized = checkPreparationOutput(root, directory);
  const contents: Array<[string, string]> = [
    ["packet.json", JSON.stringify(packet, null, 2) + "\n"],
    ["packet.md", renderPreparedTask(packet)],
    ["work.json", JSON.stringify(packet.drafts.work, null, 2) + "\n"],
    [
      packet.drafts.proof ? "proof-plan.json" : "proof-proposal.json",
      JSON.stringify(packet.drafts.proof ?? packet.drafts.proofProposal, null, 2) + "\n",
    ],
  ];
  mkdirSync(safePath(root, normalized), { recursive: true });
  for (const [file, text] of contents)
    writeFileSync(safePath(root, `${normalized}/${file}`), text, { flag: "wx" });
  return {
    directory: normalized,
    files: contents.map(([file]) => `${normalized}/${file}`),
  };
}
