import { existsSync } from "node:fs";
import { readConfig } from "./config.js";
import { readJson, safePath, walkFiles } from "./files.js";
import { validateWorkItem } from "./work.js";
import type { ArrsConfig, PolicyBaseline } from "./types.js";

export function workLocation(config: ArrsConfig): { provider: string; path: string } {
  return config.work ?? { provider: "local", path: ".agent/work-items" };
}

function providerError(config: ArrsConfig): string | undefined {
  const { provider } = workLocation(config);
  return provider === "local"
    ? undefined
    : `Unsupported work provider ${provider}; v0.1 supports local structured work items only`;
}

/** A configured external provider cannot imply locally implemented transition support. */
export function requireLocalWorkProvider(root: string): void {
  const error = providerError(readConfig(root));
  if (error) throw new Error(error);
}

/** Assess the configured local reference model with the same readiness/completion validator. */
export function workControl(
  root: string,
  config: ArrsConfig,
  baseline?: PolicyBaseline,
): string[] {
  const unsupported = providerError(config);
  if (unsupported) return [unsupported];
  const { path } = workLocation(config);
  const errors: string[] = [];
  try {
    if (!existsSync(safePath(root, path)))
      return [
        `Missing local work-item location ${path}; configure work.path or add a real structured reference item`,
      ];
    const files = walkFiles(root, path).filter((file) => file.endsWith(".json"));
    if (!files.length)
      errors.push(`No schema-validated reference work item exists at ${path}`);
    for (const file of files)
      errors.push(
        ...validateWorkItem(root, readJson(root, file), baseline).map(
          (error) => `${file}: ${error}`,
        ),
      );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
