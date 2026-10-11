import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathsOverlap, readConfig } from "./config.js";
import { safePath } from "./files.js";
import { assertValid, type SchemaKind } from "./schema.js";
import { explainProof, readProofJson } from "./proof-explanation.js";
import { resolveCommand } from "./runner.js";
import type { PolicyBaseline, ProofManifest, ProofPhase, CommandName } from "./types.js";

export const receiptMediaType = "application/vnd.in-toto+json";
export const providerMediaType = "application/vnd.arrs.github-offline+json";
const maxBytes = 1_000_000;
export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
/** Deterministic compact JSON profile rejects duplicate-key and encoding ambiguity. */
export function canonicalReceiptJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReceiptJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReceiptJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function receiptSigningBytes(payloadType: string, payload: string): Buffer {
  const type = Buffer.from(payloadType),
    bytes = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `),
    type,
    Buffer.from(` ${bytes.length} `),
    bytes,
  ]);
}
interface Envelope {
  payloadType: string;
  payload: string;
  signatures: { keyid: string; sig: string }[];
}
interface Root {
  id: string;
  keyId: string;
  publicKey: string;
}
interface Workflow {
  repository: string;
  path: string;
  revision: string;
}
interface Controls {
  id: string;
  sha256: string;
  selectionSequence: number;
  requiredChecks: CommandName[];
  requiredIndependent: boolean;
  requiredHumanAcceptance: boolean;
}
interface Binding {
  command: CommandName;
  target?: string;
  argvSha256: string;
  timeoutSeconds: number;
}
export interface ReceiptCommand extends Binding {
  phase: ProofPhase;
  expectExitCode: number;
  exitCode: number;
  execution: "executed" | "skipped" | "unsupported";
  logSha256: string;
}
interface Criterion {
  criterionSha256: string;
  resultIndices: number[];
}
interface Artifact {
  name: string;
  sha256: string;
  bytes: number;
}
interface CompleteScope {
  assurance: "git-complete";
  fingerprint: string;
  base: string;
  revision: string;
}
export interface ReceiptPolicy {
  schemaVersion: "1";
  kind: "receipt-consumer-policy";
  provider: "github-offline-v1";
  repository: string;
  verifier: Root & { workflow: Workflow; toolSha256: string };
  providerAuthority: Root;
  reviewAuthority: Root;
  allowedTriggers: string[];
  reviewers: { independent: string[]; humanAcceptance: string[] };
  maximumAgeSeconds: number;
  allowInspectionReuse: boolean;
}
export interface ReceiptContext {
  schemaVersion: "1";
  kind: "receipt-consumer-context";
  mode: "admission" | "inspection";
  category: ProofManifest["category"];
  repository: string;
  revision: string;
  comparisonBase: string;
  controls: Controls;
  candidateSequence: number;
  requiredCommands: Binding[];
  requiredCriteria: string[];
  scopeFingerprint: string;
  attemptId: string;
  manifestSha256: string;
  nonce: string;
  now: string;
  consumedNonces: string[];
  consumedReceipts: string[];
}
export interface ProviderRun {
  schemaVersion: "1";
  kind: "github-offline-run";
  category: ProofManifest["category"];
  repository: string;
  revision: string;
  comparisonBase: string;
  runId: string;
  attemptId: string;
  manifestSha256: string;
  candidateAuthorId: string;
  workflow: Workflow;
  toolSha256: string;
  controls: Controls;
  candidateSequence: number;
  evaluationSequence: number;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  state: string;
  conclusion: string;
  commands: ReceiptCommand[];
  acceptance: Criterion[];
  scope: CompleteScope;
  artifacts: Artifact[];
  nonce: string;
}
export interface ProviderReview {
  schemaVersion: "1";
  kind: "github-offline-review";
  repository: string;
  revision: string;
  comparisonBase: string;
  runId: string;
  attemptId: string;
  manifestSha256: string;
  controlsSha256: string;
  role: "independent" | "humanAcceptance";
  actorId: string;
  reviewId: string;
  state: string;
  sequence: number;
  submittedAt: string;
}
export interface ReceiptStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: { name: string; digest: { gitCommit: string } }[];
  predicateType: "https://arrs.dev/predicates/trusted-receipt/v1";
  predicate: {
    schemaVersion: "1";
    assurance: "offline-provider-conformance";
    verifierId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    run: Envelope;
    reviews: Envelope[];
  };
}
export interface TrustedReceipt {
  schemaVersion: "1";
  kind: "trusted-receipt";
  envelope: Envelope;
}
export interface LocalReceiptBundle {
  schemaVersion: "1";
  kind: "local-receipt-bundle";
  assurance: "local-integrity";
  category: ProofManifest["category"];
  proofId: string;
  manifestSha256: string;
  technicalPassed: boolean;
  acceptedLocal: boolean;
  scope: {
    assurance: "declared-only" | "git-complete";
    fingerprint?: string;
    base?: string;
    revision?: string;
  };
  commands: ReceiptCommand[];
  acceptance: Criterion[];
}
interface Check {
  passed: boolean;
  errors: string[];
}

function uniqueJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens =
    text.match(
      /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ) ?? [];
  if (tokens.length > 100_000) throw new Error("Receipt JSON token bound exceeded");
  let index = 0;
  const visit = (depth: number): void => {
    if (depth > 64) throw new Error("Receipt JSON nesting bound exceeded");
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[index] !== "}") {
        const name = JSON.parse(tokens[index++]!) as string;
        if (keys.has(name))
          throw new Error("Ambiguous duplicate JSON field in receipt input");
        keys.add(name);
        index++; // Colon; JSON.parse already established valid grammar.
        visit(depth + 1);
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") {
        visit(depth + 1);
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    }
  };
  visit(0);
  return value;
}
export interface ReceiptVerification {
  schemaVersion: "1";
  kind: "receipt-verification";
  provider: "github-offline-v1";
  authenticity: Check;
  freshness: Check;
  policy: Check;
  scope: Check;
  evidence: Check;
  acceptance: Check;
  valid: boolean;
  conformancePassed: boolean;
  admission: false;
  hostedAssurance: "not-qualified";
  assurance: "offline-provider-conformance";
  receiptSha256?: string;
  limitations: string[];
}
export interface ReceiptSelections {
  trust: string;
  trustSha256: string;
  context: string;
  contextSha256: string;
  artifacts: string;
}
function boundedJson(path: string): { bytes: Buffer; value: unknown } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
    throw new Error("Receipt inputs must be singly linked regular files at most 1 MB");
  const bytes = readFileSync(path);
  return {
    bytes,
    value: uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  };
}
/** Caller-owned selection outside the candidate is required; never discover roots in a receipt. */
function externalSelection<T>(
  root: string,
  path: string,
  digest: string,
  kind: SchemaKind,
): T {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error(
      "Externally selected receipt policy/context requires an absolute path and independently retained SHA-256",
    );
  const absolute = resolve(path),
    candidate = realpathSync(root);
  if (absolute === candidate || absolute.startsWith(candidate + sep))
    throw new Error(
      "Receipt trust/context must be selected outside the candidate checkout; candidate-authored policy cannot authorize itself",
    );
  let parent = absolute;
  while (true) {
    if (lstatSync(parent).isSymbolicLink())
      throw new Error("External receipt selection cannot use symlink paths");
    const next = resolve(parent, "..");
    if (next === parent) break;
    parent = next;
  }
  const input = boundedJson(absolute);
  if (sha256(input.bytes) !== digest)
    throw new Error(`Externally selected ${kind} bytes drifted or pin mismatched`);
  assertValid<T>(kind, input.value);
  return input.value;
}
export function receiptArtifactDirectory(root: string, path: string): string {
  const absolute = safePath(root, path),
    normalized = relative(safePath(root, "."), absolute).replaceAll(sep, "/");
  if (
    path !== normalized ||
    !/^\.arrs\/receipts\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "Receipt artifacts require canonical contained .arrs/receipts/<name> paths",
    );
  if (pathsOverlap(path, readConfig(root).proof.evidenceDir))
    throw new Error("Receipt artifacts cannot overlap canonical proof evidence");
  return absolute;
}
function payload<T>(
  envelope: Envelope,
  type: string,
  kind: SchemaKind,
): { value: T; text: string } {
  if (envelope.payloadType !== type)
    throw new Error(`Unexpected signed payload type for ${kind}`);
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.toString("base64") !== envelope.payload || bytes.length > maxBytes)
    throw new Error("Malformed or oversized signed receipt payload");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    value: unknown = JSON.parse(text);
  if (canonicalReceiptJson(value) !== text)
    throw new Error(
      "Signed payload must use canonical compact ARRS JSON; duplicate/ambiguous fields reject",
    );
  assertValid<T>(kind, value);
  return { value, text };
}
function authentic(envelope: Envelope, root: Root, type: string): void {
  const signature = envelope.signatures[0];
  if (
    envelope.signatures.length !== 1 ||
    signature?.keyid !== root.keyId ||
    envelope.payloadType !== type
  )
    throw new Error(`Untrusted signer or ambiguous signatures for ${root.id}`);
  const sig = Buffer.from(signature.sig, "base64");
  if (sig.toString("base64") !== signature.sig || sig.length !== 64)
    throw new Error("Malformed Ed25519 receipt signature");
  const key = createPublicKey(root.publicKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(
      "Only the versioned Ed25519 offline conformance profile is supported",
    );
  if (
    !verify(
      null,
      receiptSigningBytes(type, Buffer.from(envelope.payload, "base64").toString("utf8")),
      key,
      sig,
    )
  )
    throw new Error(`Signature invalid for selected ${root.id}`);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalReceiptJson(a) === canonicalReceiptJson(b);
}
function binding(command: Binding): string {
  return canonicalReceiptJson({
    command: command.command,
    ...(command.target ? { target: command.target } : {}),
    argvSha256: command.argvSha256,
    timeoutSeconds: command.timeoutSeconds,
  });
}
function time(value: string): number {
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== normalized
  )
    throw new Error("Receipt timestamps require an explicit valid UTC instant");
  return Date.parse(value);
}
function check(
  report: ReceiptVerification,
  name: keyof Pick<
    ReceiptVerification,
    "authenticity" | "freshness" | "policy" | "scope" | "evidence" | "acceptance"
  >,
  action: () => void,
): void {
  try {
    action();
    report[name].passed = true;
  } catch (error) {
    report[name].errors.push(error instanceof Error ? error.message : String(error));
  }
}
export function verifyReceipt(
  root: string,
  receiptPath: string,
  selections: ReceiptSelections,
): ReceiptVerification {
  const policy = externalSelection<ReceiptPolicy>(
    root,
    selections.trust,
    selections.trustSha256,
    "receipt-policy",
  );
  const context = externalSelection<ReceiptContext>(
    root,
    selections.context,
    selections.contextSha256,
    "receipt-context",
  );
  const directory = receiptArtifactDirectory(root, selections.artifacts);
  const report: ReceiptVerification = {
    schemaVersion: "1",
    kind: "receipt-verification",
    provider: "github-offline-v1",
    authenticity: { passed: false, errors: [] },
    freshness: { passed: false, errors: [] },
    policy: { passed: false, errors: [] },
    scope: { passed: false, errors: [] },
    evidence: { passed: false, errors: [] },
    acceptance: { passed: false, errors: [] },
    valid: false,
    conformancePassed: false,
    admission: false,
    hostedAssurance: "not-qualified",
    assurance: "offline-provider-conformance",
    limitations: [
      "This adapter qualifies offline GitHub-provider fixtures and selected test identities only; it cannot establish real hosted execution or production admission.",
      "The consumer must independently select/pin external trust and expected context; candidate text and timestamps cannot establish those roots.",
      "Verification is read-only. A real consumer must atomically consume its challenge and receipt digest before admission; repeated same-request inspection is distinct from readmission.",
      "Trusted verifier/provider/review authorities can lie or be compromised. No SLSA certification, sandboxing or semantic adequacy of tests is claimed.",
    ],
  };
  let statement: ReceiptStatement | undefined, run: ProviderRun | undefined;
  let reviews: ProviderReview[] = [],
    receipt: TrustedReceipt | undefined;
  check(report, "authenticity", () => {
    const input = boundedJson(safePath(root, receiptPath));
    assertValid<TrustedReceipt>("receipt", input.value);
    receipt = input.value;
    report.receiptSha256 = sha256(input.bytes);
    statement = payload<ReceiptStatement>(
      receipt.envelope,
      receiptMediaType,
      "receipt-statement",
    ).value;
    authentic(receipt.envelope, policy.verifier, receiptMediaType);
    if (statement.predicate.verifierId !== policy.verifier.id)
      throw new Error(
        "Statement verifier does not match the consumer-selected verifier pair",
      );
    authentic(statement.predicate.run, policy.providerAuthority, providerMediaType);
    run = payload<ProviderRun>(
      statement.predicate.run,
      providerMediaType,
      "receipt-run",
    ).value;
    reviews = statement.predicate.reviews.map((envelope) => {
      authentic(envelope, policy.reviewAuthority, providerMediaType);
      return payload<ProviderReview>(envelope, providerMediaType, "receipt-review").value;
    });
    const roots = [policy.verifier, policy.providerAuthority, policy.reviewAuthority].map(
      (item) => {
        const key = createPublicKey(item.publicKey);
        if (key.asymmetricKeyType !== "ed25519")
          throw new Error("Unsupported trust-root algorithm");
        return sha256(key.export({ format: "der", type: "spki" }));
      },
    );
    if (
      new Set(roots).size !== 3 ||
      new Set([
        policy.verifier.keyId,
        policy.providerAuthority.keyId,
        policy.reviewAuthority.keyId,
      ]).size !== 3
    )
      throw new Error(
        "Verifier/provider/review authority roots must be independently selected distinct keys",
      );
  });
  if (!statement || !run || !receipt || !report.authenticity.passed) {
    for (const name of [
      "freshness",
      "policy",
      "scope",
      "evidence",
      "acceptance",
    ] as const)
      report[name].errors.push(
        "Authenticity of the bounded provider/review chain is unestablished; no protected claims evaluated",
      );
    return report;
  }
  const trustedStatement = statement,
    trustedRun = run,
    trustedReviews = reviews;
  check(report, "freshness", () => {
    const subject = trustedStatement.subject[0]!;
    if (
      policy.repository !== context.repository ||
      subject.name !== context.repository ||
      subject.digest.gitCommit !== context.revision ||
      trustedRun.repository !== context.repository ||
      trustedRun.revision !== context.revision ||
      trustedRun.comparisonBase !== context.comparisonBase
    )
      throw new Error(
        "Wrong repository, immutable candidate revision or explicit comparison base",
      );
    const now = time(context.now),
      issued = time(trustedStatement.predicate.issuedAt),
      expires = time(trustedStatement.predicate.expiresAt),
      started = time(trustedRun.startedAt),
      finished = time(trustedRun.finishedAt);
    if (
      started > finished ||
      finished > issued ||
      issued > now ||
      expires < now ||
      expires <= issued ||
      now - issued > policy.maximumAgeSeconds * 1000 ||
      expires - issued > policy.maximumAgeSeconds * 1000
    )
      throw new Error(
        "Receipt/provider run is stale, future-dated or has invalid lifetime ordering",
      );
    if (
      trustedStatement.predicate.nonce !== context.nonce ||
      trustedRun.nonce !== context.nonce
    )
      throw new Error(
        "Receipt challenge does not match this externally selected consumer request",
      );
    const consumed =
      context.consumedNonces.includes(context.nonce) ||
      context.consumedReceipts.includes(report.receiptSha256!);
    if (consumed && (context.mode !== "inspection" || !policy.allowInspectionReuse))
      throw new Error(
        "Stale/replayed receipt challenge or digest cannot be admitted again",
      );
  });
  check(report, "policy", () => {
    if (
      !same(trustedRun.workflow, policy.verifier.workflow) ||
      trustedRun.toolSha256 !== policy.verifier.toolSha256
    )
      throw new Error(
        "Provider workflow/tool revision does not match the independently selected protected verifier",
      );
    if (!policy.allowedTriggers.includes(trustedRun.trigger))
      throw new Error(`Unsupported/untrusted provider trigger ${trustedRun.trigger}`);
    if (
      trustedRun.category !== context.category ||
      !same(trustedRun.controls, context.controls)
    )
      throw new Error(
        "Retained governing control identity, gates or category mismatch; candidate weakening cannot replace selected requirements",
      );
    if (
      trustedRun.candidateSequence !== context.candidateSequence ||
      trustedRun.controls.selectionSequence >= trustedRun.candidateSequence ||
      trustedRun.candidateSequence > trustedRun.evaluationSequence
    )
      throw new Error(
        "Controls were selected after candidate creation or event ordering is invalid; a candidate cannot supply its own pre-change control selection",
      );
    if (
      new Set(context.controls.requiredChecks).size !==
        context.controls.requiredChecks.length ||
      new Set(context.requiredCommands.map(binding)).size !==
        context.requiredCommands.length
    )
      throw new Error("Ambiguous repeated required control/check bindings");
    for (const name of context.controls.requiredChecks)
      if (!context.requiredCommands.some((item) => item.command === name && !item.target))
        throw new Error(`External context omits retained required check ${name}`);
    for (const required of context.requiredCommands)
      if (
        !trustedRun.commands.some(
          (actual) =>
            binding(actual) === binding(required) &&
            actual.phase !== "before" &&
            actual.execution === "executed" &&
            actual.exitCode === 0 &&
            actual.expectExitCode === 0,
        )
      )
        throw new Error(
          `Missing, weakened, skipped or changed required command ${required.command}${required.target ? ` ${required.target}` : ""}`,
        );
  });
  check(report, "scope", () => {
    if (
      trustedRun.scope.assurance !== "git-complete" ||
      trustedRun.scope.base !== context.comparisonBase ||
      trustedRun.scope.revision !== context.revision ||
      trustedRun.scope.fingerprint !== context.scopeFingerprint
    )
      throw new Error(
        "Exact complete changeset coverage is unavailable or does not match the consumer-selected comparison",
      );
    if (
      trustedRun.attemptId !== context.attemptId ||
      trustedRun.manifestSha256 !== context.manifestSha256
    )
      throw new Error(
        "Receipt does not identify the selected exact proof attempt/manifest",
      );
  });
  check(report, "evidence", () => {
    if (trustedRun.state !== "completed" || trustedRun.conclusion !== "success")
      throw new Error("Provider execution is skipped, unsupported or unsuccessful");
    if (
      trustedRun.artifacts.length !== 1 ||
      trustedRun.artifacts[0]?.name !== "bundle.json"
    )
      throw new Error(
        "The bounded metadata profile supports exactly one bundle.json artifact; arbitrary source/log artifacts are unsupported",
      );
    let total = 0,
      bundle: LocalReceiptBundle | undefined;
    for (const artifact of trustedRun.artifacts) {
      const input = boundedJson(
        safePath(root, `${selections.artifacts}/${artifact.name}`),
      );
      total += input.bytes.length;
      if (
        total > 8 * maxBytes ||
        input.bytes.length !== artifact.bytes ||
        sha256(input.bytes) !== artifact.sha256
      )
        throw new Error(`Evidence artifact digest/length mismatch: ${artifact.name}`);
      if (artifact.name === "bundle.json") {
        assertValid<LocalReceiptBundle>("receipt-bundle", input.value);
        bundle = input.value;
      }
    }
    if (
      !bundle ||
      !bundle.technicalPassed ||
      bundle.category !== trustedRun.category ||
      bundle.proofId !== trustedRun.attemptId ||
      bundle.manifestSha256 !== trustedRun.manifestSha256 ||
      !same(bundle.commands, trustedRun.commands) ||
      !same(bundle.acceptance, trustedRun.acceptance) ||
      !same(bundle.scope, trustedRun.scope)
    )
      throw new Error(
        "Provider artifacts do not substantiate command/log digests, exact attempt, acceptance links and complete scope",
      );
    for (const command of trustedRun.commands)
      if (
        command.execution !== "executed" ||
        command.exitCode !== command.expectExitCode ||
        (command.expectExitCode !== 0 &&
          !(trustedRun.category === "bug" && command.phase === "before"))
      )
        throw new Error(
          "Skipped/unsupported/failed command cannot supply required execution evidence",
        );
    for (const before of trustedRun.commands.filter((item) => item.phase === "before"))
      if (
        !trustedRun.commands.some(
          (after) =>
            after.phase === "after" &&
            binding(after) === binding(before) &&
            after.exitCode === 0,
        )
      )
        throw new Error(
          "Before/after receipt scenarios must retain identical command bindings",
        );
    if (!existsSync(directory) || !lstatSync(directory).isDirectory())
      throw new Error("Contained evidence artifact directory is unavailable");
  });
  check(report, "acceptance", () => {
    if (
      new Set(context.requiredCriteria).size !== context.requiredCriteria.length ||
      new Set(trustedRun.acceptance.map((item) => item.criterionSha256)).size !==
        trustedRun.acceptance.length
    )
      throw new Error("Ambiguous repeated acceptance criteria");
    for (const criterion of context.requiredCriteria) {
      const linked = trustedRun.acceptance.find(
        (item) => item.criterionSha256 === criterion,
      );
      if (
        !linked ||
        !linked.resultIndices.some((index) => {
          const item = trustedRun.commands[index];
          return (
            item?.execution === "executed" &&
            item.exitCode === 0 &&
            item.expectExitCode === 0 &&
            (trustedRun.category === "docs"
              ? item.phase !== "before"
              : item.command === "verify" && ["behavior", "after"].includes(item.phase))
          );
        })
      )
        throw new Error(
          `Acceptance criterion ${criterion} lacks its exact successful behavioral result`,
        );
    }
    const latest = new Map<string, ProviderReview>();
    const observedSequences = new Set<string>();
    const observedReviews = new Set<string>();
    for (const review of trustedReviews) {
      const sequenceKey = `${review.role}:${review.sequence}`;
      if (observedSequences.has(sequenceKey) || observedReviews.has(review.reviewId))
        throw new Error("Ambiguous duplicate protected review sequence or identity");
      observedSequences.add(sequenceKey);
      observedReviews.add(review.reviewId);
      if (
        review.repository !== context.repository ||
        review.revision !== context.revision ||
        review.comparisonBase !== context.comparisonBase ||
        review.runId !== trustedRun.runId ||
        review.attemptId !== context.attemptId ||
        review.manifestSha256 !== context.manifestSha256 ||
        review.controlsSha256 !== context.controls.sha256
      )
        throw new Error(
          "Protected review does not bind exact repository/revision/base/run/attempt/manifest/retained controls",
        );
      if (
        time(review.submittedAt) < time(trustedRun.finishedAt) ||
        time(review.submittedAt) > time(trustedStatement.predicate.issuedAt)
      )
        throw new Error(
          "Protected implementation review must follow the selected run and precede receipt issuance",
        );
      const prior = latest.get(review.role);
      if (!prior || review.sequence > prior.sequence) latest.set(review.role, review);
    }
    for (const role of ["independent", "humanAcceptance"] as const) {
      const required =
        role === "independent"
          ? context.controls.requiredIndependent
          : context.controls.requiredHumanAcceptance;
      if (!required) continue;
      const review = latest.get(role);
      if (
        !review ||
        review.state !== "APPROVED" ||
        !policy.reviewers[role].includes(review.actorId) ||
        review.actorId === trustedRun.candidateAuthorId ||
        review.actorId === policy.verifier.id
      )
        throw new Error(
          `Actual protected ${role} approval is missing, revoked, untrusted or not independent; local names/approval text cannot replace it`,
        );
    }
  });
  report.valid = [
    report.authenticity,
    report.freshness,
    report.policy,
    report.scope,
    report.evidence,
    report.acceptance,
  ].every((item) => item.passed);
  report.conformancePassed = report.valid;
  return report;
}

/** Metadata-only local export remains local integrity, never authenticated execution. */
export function localReceiptBundle(
  root: string,
  manifestPath: string,
  baseline?: PolicyBaseline,
): LocalReceiptBundle {
  const explanation = explainProof(root, manifestPath, baseline);
  if (!explanation.technical.valid)
    throw new Error(
      `Local receipt export requires current canonical technical proof: ${explanation.technical.errors.join("; ")}`,
    );
  const manifest = readProofJson(root, explanation.path) as ProofManifest;
  const config = readConfig(root),
    snapshot = manifest.changesetSnapshot;
  if (snapshot && snapshot.layers.some((layer) => layer.layer !== "committed"))
    throw new Error(
      "Receipt bundle cannot identify an immutable candidate while staged, unstaged or untracked source layers remain; commit the candidate and recapture",
    );
  const bundle: LocalReceiptBundle = {
    schemaVersion: "1",
    kind: "local-receipt-bundle",
    assurance: "local-integrity",
    category: manifest.category,
    proofId: manifest.id,
    manifestSha256: explanation.manifestSha256!,
    technicalPassed: true,
    acceptedLocal: explanation.review.accepted,
    scope: snapshot
      ? {
          assurance: "git-complete",
          fingerprint: snapshot.fingerprint,
          base: snapshot.base,
          revision: snapshot.head,
        }
      : { assurance: "declared-only" },
    commands: manifest.results.map((result) => ({
      command: result.command,
      ...(result.target ? { target: result.target } : {}),
      phase: result.phase,
      argvSha256: sha256(canonicalReceiptJson(result.argv)),
      timeoutSeconds:
        resolveCommand(config, result.command, result.target).timeoutSeconds ?? 300,
      expectExitCode: result.expectExitCode,
      exitCode: result.exitCode,
      execution: "executed",
      logSha256: result.sha256,
    })),
    acceptance: explanation.acceptance.map((item) => ({
      criterionSha256: sha256(item.criterion),
      resultIndices: item.resultIndices.map((index) => index - 1),
    })),
  };
  assertValid<LocalReceiptBundle>("receipt-bundle", bundle);
  return bundle;
}
