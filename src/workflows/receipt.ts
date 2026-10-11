import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { safePath } from "../core/files.js";
import { evidenceIgnoreProtection } from "../core/evidence-ignore.js";
import {
  canonicalReceiptJson,
  localReceiptBundle,
  receiptArtifactDirectory,
  sha256,
  verifyReceipt,
  type ReceiptSelections,
} from "../core/receipt.js";
import type { PolicyBaseline } from "../core/types.js";

function outputDirectory(root: string, output: string): string {
  const directory = receiptArtifactDirectory(root, output);
  if (existsSync(directory))
    throw new Error(
      "Receipt output already exists; choose a fresh directory to preserve prior artifacts",
    );
  evidenceIgnoreProtection(root, output);
  return directory;
}
function writeFiles(root: string, output: string, files: Array<[string, string]>): void {
  // Validate every destination and byte bound before the first output effect.
  const directory = outputDirectory(root, output);
  for (const [name, bytes] of files) {
    safePath(root, `${output}/${name}`);
    if (Buffer.byteLength(bytes) > 1_000_000)
      throw new Error("Receipt export/import file exceeds the 1 MB bound");
  }
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files)
    writeFileSync(safePath(root, `${output}/${name}`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
}
export function exportReceipt(
  root: string,
  manifest: string,
  output: string,
  baseline?: PolicyBaseline,
): unknown {
  outputDirectory(root, output);
  const bundle = localReceiptBundle(root, manifest, baseline);
  const bytes = canonicalReceiptJson(bundle) + "\n";
  writeFiles(root, output, [["bundle.json", bytes]]);
  return {
    schemaVersion: "1",
    kind: "receipt-export",
    assurance: "local-integrity",
    admission: false,
    directory: output,
    artifacts: [
      { name: "bundle.json", bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) },
    ],
    limitation:
      "Metadata-only local engineering evidence. No authenticated verifier or reviewer identity is established; inspect metadata before sharing.",
  };
}
export function importReceipt(
  root: string,
  receipt: string,
  selections: ReceiptSelections,
  output: string,
): unknown {
  outputDirectory(root, output);
  const verification = verifyReceipt(root, receipt, selections);
  if (!verification.valid)
    throw new Error(
      `Receipt import requires valid offline conformance: ${Object.entries(verification)
        .filter(([, value]) => value && typeof value === "object" && "errors" in value)
        .flatMap(([name, value]) =>
          (value as { errors: string[] }).errors.map((error) => `${name}: ${error}`),
        )
        .join("; ")}`,
    );
  // Reread and reverify immediately before writes: changed inputs cannot be imported
  // under the previous observation's digests.
  const receiptBytes = readFileSync(safePath(root, receipt));
  const bundleBytes = readFileSync(safePath(root, `${selections.artifacts}/bundle.json`));
  const final = verifyReceipt(root, receipt, selections);
  if (!final.valid || final.receiptSha256 !== sha256(receiptBytes))
    throw new Error("Receipt inputs changed during import; retry from stable inputs");
  const envelope = JSON.parse(receiptBytes.toString("utf8")) as {
    envelope: { payload: string };
  };
  const statement = JSON.parse(
    Buffer.from(envelope.envelope.payload, "base64").toString("utf8"),
  ) as { predicate: { run: { payload: string } } };
  const run = JSON.parse(
    Buffer.from(statement.predicate.run.payload, "base64").toString("utf8"),
  ) as { artifacts: { sha256: string; bytes: number }[] };
  if (
    run.artifacts[0]?.sha256 !== sha256(bundleBytes) ||
    run.artifacts[0].bytes !== bundleBytes.length
  )
    throw new Error("Bundle inputs changed during import; retry from stable inputs");
  writeFiles(root, output, [
    ["receipt.json", receiptBytes.toString("utf8")],
    ["bundle.json", bundleBytes.toString("utf8")],
    ["verification.json", canonicalReceiptJson(final) + "\n"],
  ]);
  return {
    schemaVersion: "1",
    kind: "receipt-import",
    directory: output,
    files: ["receipt.json", "bundle.json", "verification.json"],
    verification: final,
  };
}
