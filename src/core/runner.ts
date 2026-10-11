import standalone from "../../assets/repo.cjs";
import type { ArrsConfig, Command, CommandName } from "./types.js";

export interface CommandResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
export function resolveCommand(
  config: ArrsConfig,
  name: CommandName,
  target?: string,
): Command {
  return standalone.resolveCommand(config, name, target);
}
export function runCommand(root: string, command: Command): Promise<CommandResult> {
  return standalone.execute(root, command);
}
