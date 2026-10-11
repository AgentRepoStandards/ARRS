import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";

export const schemaKinds = [
  "config",
  "feature",
  "architecture",
  "risk",
  "proof-plan",
  "proof",
  "proof-review",
  "proof-explanation",
  "proof-history",
  "metrics",
  "outcome",
  "work-item",
  "exceptions",
  "receipt",
  "receipt-statement",
  "receipt-policy",
  "receipt-context",
  "receipt-run",
  "receipt-review",
  "receipt-bundle",
  "prepare-scenarios",
  "prepared-task",
  "adoption-input",
  "adoption-proposal",
  "adoption-authorization",
  "readiness",
  "mcp-inspection",
  "capability-graph",
] as const;
export type SchemaKind = (typeof schemaKinds)[number];
const ajv = new Ajv({ allErrors: true, strict: true });
const compiled = new Map<SchemaKind, ValidateFunction>();

/** Validate one registered versioned document. Unknown fields and schema versions are rejected. */
export function validate(kind: SchemaKind, value: unknown): string[] {
  if (!(schemaKinds as readonly string[]).includes(kind))
    throw new Error(
      `Unknown schema kind: ${String(kind)}; choose ${schemaKinds.join(", ")}`,
    );
  let validator = compiled.get(kind);
  if (!validator) {
    const path = new URL(`../../schemas/${kind}.schema.json`, import.meta.url);
    const schema = JSON.parse(readFileSync(path, "utf8")) as object;
    validator = ajv.compile(schema);
    compiled.set(kind, validator);
  }
  if (validator(value)) return [];
  return (validator.errors ?? []).map(
    (error) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}${error.params ? ` (${JSON.stringify(error.params)})` : ""}`,
  );
}

export function assertValid<T>(kind: SchemaKind, value: unknown): asserts value is T {
  const errors = validate(kind, value);
  if (errors.length) throw new Error(`Invalid ${kind}: ${errors.join("; ")}`);
}
