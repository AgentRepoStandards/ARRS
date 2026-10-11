declare const standalone: {
  resolveCommand(
    config: {
      schemaVersion: string;
      commands: Partial<Record<string, { argv: string[]; timeoutSeconds?: number }>>;
      verifyTargets: Record<string, { argv: string[]; timeoutSeconds?: number }>;
    },
    name: string,
    target?: string,
  ): { argv: string[]; timeoutSeconds?: number };
  execute(
    root: string,
    command: { argv: string[]; timeoutSeconds?: number },
    options?: { stream: boolean },
  ): Promise<{
    argv: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
};
export = standalone;
