import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { posix } from "node:path";
import {
  readConfig,
  readRiskPolicy,
  repositoryPathsOverlap,
  scanFeatures,
  classifyRisk,
} from "./config.js";
import {
  inspectChangeset,
  checkChangesetScope,
  readComparisonContracts,
  type ChangesetSnapshot,
  type ScopeCheck,
} from "./changeset.js";
import { safePath, walkFiles } from "./files.js";
import {
  policyRequirements,
  policyMode,
  candidatePolicyLimitation,
} from "./policy-baseline.js";
import { assessReadiness, type ReadinessReport } from "./readiness.js";
import { validate } from "./schema.js";
import { workLocation } from "./work-provider.js";
import type { WorkItem } from "./work.js";
import type { ArrsConfig, FeatureMap, PolicyBaseline, Risk } from "./types.js";

export const graphLimits = {
  features: 2000,
  workItems: 64,
  nodes: 20_000,
  edges: 50_000,
  fileBytes: 1024 * 1024,
  metadataBytes: 64 * 1024 * 1024,
  page: 1000,
  criterionRecords: 20_000,
  drift: 20_000,
  outputBytes: 16 * 1024 * 1024,
} as const;
export interface GraphSource {
  path: string;
  pointer: string;
  sha256: string | null;
  revision: string | null;
}
export interface GraphNode {
  id: string;
  kind:
    | "feature"
    | "source"
    | "invariant"
    | "criterion"
    | "target"
    | "decision"
    | "work"
    | "proof"
    | "review";
  label: string;
  featureId: string | null;
  facts: Array<{ name: string; value: string | string[] | boolean | null }>;
  sources: GraphSource[];
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  origin: "maintained" | "observed" | "candidate";
  sources: GraphSource[];
}
export interface GraphDrift {
  featureId: string | null;
  field: string;
  before: unknown;
  after: unknown;
  sources: GraphSource[];
}
export interface GraphCriterionEvidence {
  featureId: string;
  criterionId: string;
  criterion: string;
  workId: string | null;
  proof: string | null;
  status:
    | "missing"
    | "unknown"
    | "failed"
    | "stale"
    | "invalid"
    | "unrelated"
    | "technical"
    | "accepted";
  qualifies: boolean;
  assurance: "declared-only" | "git-complete" | "unknown";
  diagnostics: string[];
  sources: GraphSource[];
}
export interface CapabilityGraphResult {
  schemaVersion: "1";
  kind: "capability-graph";
  identity: string;
  status: "complete" | "incomplete";
  query: { feature: string | null; paths: string[]; base: string | null };
  affectedFeatureIds: string[];
  effectiveRisk: Risk;
  verificationTargets: string[];
  policyEvaluation: {
    mode: ReturnType<typeof policyMode>;
    baseline: PolicyBaseline | null;
    limitations: string[];
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  criteria: GraphCriterionEvidence[];
  drift: GraphDrift[];
  changeset: ChangesetSnapshot | null;
  scope: ScopeCheck | null;
  readiness: Array<{
    path: string;
    identity: string;
    dimensions: ReadinessReport["dimensions"];
    eligibility: ReadinessReport["eligibility"];
  }>;
  page: { offset: number; limit: number; totalNodes: number; nextCursor: string | null };
  analysis: { status: "not-evaluated"; gaps: string[] };
  diagnostics: string[];
  limits: typeof graphLimits;
  inputs: GraphSource[];
}
export interface GraphQuery {
  feature?: string;
  paths?: string[];
  base?: string;
  baseline?: PolicyBaseline;
  limit?: number;
  cursor?: string;
}
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: string[]): string[] => [...new Set(values)].sort(compare);
const nodeId = (kind: string, identity: string): string => `${kind}:${hash(identity)}`;
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);

/** Both initial and final reads allocate at most the fixed metadata bound. */
function graphBytes(root: string, path: string): Buffer {
  const descriptor = openSync(
    safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > graphLimits.fileBytes)
      throw new Error(`Graph metadata must be a regular file at most 1 MiB: ${path}`);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(`Graph input changed during bounded read: ${path}`);
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

class Facts {
  bytes = 0;
  outputBytes = 0;
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();
  inputs = new Map<string, GraphSource>();
  diagnostics: string[] = [];
  constructor(readonly root: string) {}
  account(value: unknown): void {
    this.outputBytes += Buffer.byteLength(JSON.stringify(value));
    if (this.outputBytes > graphLimits.outputBytes)
      throw new Error(
        "Graph records exceed 16 MiB output collection bound; narrow the query",
      );
  }
  read(path: string): { bytes: Buffer; source: GraphSource } {
    const bytes = graphBytes(this.root, path);
    this.bytes += bytes.length;
    if (this.bytes > graphLimits.metadataBytes)
      throw new Error("Graph metadata exceeds 64 MiB");
    const source = { path, pointer: "", sha256: hash(bytes), revision: null };
    if (!this.inputs.has(path)) this.account(source);
    this.inputs.set(path, source);
    return { bytes, source };
  }
  reference(path: string, requirePresent = true): GraphSource {
    const absolute = safePath(this.root, path),
      stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.size <= graphLimits.fileBytes) {
      const existing = this.inputs.get(path);
      return existing ?? this.read(path).source;
    }
    const source = {
      path,
      pointer: "",
      sha256: null,
      revision: null,
    };
    if (!stat) {
      if (requirePresent) this.diagnostics.push(`Broken maintained reference: ${path}`);
    } else if (!stat.isFile() && !stat.isDirectory())
      throw new Error(`Unsupported graph reference: ${path}`);
    if (!this.inputs.has(path)) this.account(source);
    this.inputs.set(path, source);
    return source;
  }
  add(
    kind: GraphNode["kind"],
    identity: string,
    label: string,
    featureId: string | null,
    facts: GraphNode["facts"],
    source: GraphSource,
  ): string {
    const id = nodeId(kind, identity),
      old = this.nodes.get(id);
    if (old) {
      if (!old.sources.some((item) => JSON.stringify(item) === JSON.stringify(source)))
        old.sources.push(source);
      return id;
    }
    if (this.nodes.size >= graphLimits.nodes)
      throw new Error("Graph exceeds 20000 nodes");
    const node = { id, kind, label, featureId, facts, sources: [source] };
    this.account(node);
    this.nodes.set(id, node);
    return id;
  }
  link(
    from: string,
    to: string,
    relation: string,
    origin: GraphEdge["origin"],
    source: GraphSource,
  ): void {
    const id = nodeId("edge", JSON.stringify([from, to, relation, origin, source]));
    if (this.edges.has(id)) return;
    if (this.edges.size >= graphLimits.edges)
      throw new Error("Graph exceeds 50000 edges");
    const edge = { id, from, to, relation, origin, sources: [source] };
    this.account(edge);
    this.edges.set(id, edge);
  }
}

async function selectedEvidence(
  facts: Facts,
  maps: MapFact[],
  config: ArrsConfig,
  selected: Set<string>,
  options: GraphQuery,
  result: CapabilityGraphResult,
): Promise<void> {
  const location = workLocation(config);
  if (location.provider !== "local") {
    facts.diagnostics.push(
      `Unsupported work provider ${location.provider}; selected criterion evidence is unknown`,
    );
    return;
  }
  if (!existsSync(safePath(facts.root, location.path))) return;
  const files = walkFiles(facts.root, location.path, {
    includeIgnored: true,
    maxFiles: graphLimits.workItems,
  })
    .filter((path) => path.endsWith(".json"))
    .sort(compare);
  const workIds = new Set<string>();
  for (const path of files) {
    const { bytes, source } = facts.read(path),
      value: unknown = JSON.parse(bytes.toString("utf8")),
      errors = validate("work-item", value);
    if (errors.length) {
      facts.diagnostics.push(`Malformed work item ${path}: ${errors.join("; ")}`);
      continue;
    }
    const work = value as WorkItem;
    if (workIds.has(work.id)) {
      facts.diagnostics.push(`Duplicate work identity ${work.id}`);
      continue;
    }
    workIds.add(work.id);
    if (!work.featureIds.some((id) => selected.has(id))) continue;
    const workId = facts.add(
      "work",
      work.id,
      work.title,
      null,
      [
        { name: "task", value: work.id },
        { name: "state", value: work.state },
        { name: "risk", value: work.risk },
      ],
      source,
    );
    // Query scope is assessed separately; it never upgrades captured assurance.
    const readiness = await assessReadiness(
      facts.root,
      { kind: "work", path },
      {
        ...(options.baseline ? { baseline: options.baseline } : {}),
        ...(options.base ? { base: options.base } : {}),
      },
    );
    const projected = {
      path,
      identity: readiness.identity,
      dimensions: readiness.dimensions,
      eligibility: readiness.eligibility,
    };
    facts.account(projected);
    result.readiness.push(projected);
    const explanation = readiness.selectedProof;
    const additionalRequirements: string[] = [],
      fullInventoryRisk = classifyRisk(
        facts.root,
        work.context,
        readiness.requirements?.risk ?? work.risk,
        readRiskPolicy(facts.root, config),
        maps.map((item) => item.map),
      ),
      inventoryMatches = maps.filter((item) =>
        work.context.some((path) =>
          [...item.map.implementation, ...item.map.entryPoints].some((reference) =>
            repositoryPathsOverlap(facts.root, path, reference),
          ),
        ),
      ),
      fullInventoryTargets = sorted(
        inventoryMatches.map((item) => item.map.verification.target),
      );
    if (work.risk < fullInventoryRisk)
      additionalRequirements.push(
        `Graph full map inventory requires ${fullInventoryRisk}; selected work declares ${work.risk}`,
      );
    for (const target of fullInventoryTargets) {
      if (!work.verificationTargets.includes(target))
        additionalRequirements.push(
          `Selected work omits full graph inventory target ${target}`,
        );
      if (
        explanation?.technical.valid &&
        !explanation.steps.some(
          (step) =>
            step.argvBound &&
            step.result?.command === "verify" &&
            step.result.target === target &&
            step.result.phase !== "before" &&
            step.result.exitCode === 0 &&
            step.result.expectExitCode === 0,
        )
      )
        additionalRequirements.push(
          `Selected proof lacks passing full graph inventory target ${target}`,
        );
    }
    let proofId: string | undefined, proofSource: GraphSource | undefined;
    if (work.proof) {
      const proofDocument = JSON.parse(
          facts.read(work.proof).bytes.toString("utf8"),
        ) as unknown,
        proofErrors = validate("proof", proofDocument);
      if (proofErrors.length)
        facts.diagnostics.push(
          `Malformed selected proof ${work.proof}: ${proofErrors.join("; ")}`,
        );
      proofSource = facts.reference(work.proof);
      proofId = facts.add(
        "proof",
        work.proof,
        explanation?.id ?? work.proof,
        null,
        [
          { name: "task", value: explanation?.task ?? null },
          { name: "technicalValid", value: explanation?.technical.valid ?? false },
          { name: "accepted", value: explanation?.review.accepted ?? false },
          {
            name: "scopedWorkReadyForReview",
            value: readiness.eligibility.readyForReview === true,
          },
          {
            name: "fullInventoryRequirementsSatisfied",
            value: additionalRequirements.length === 0,
          },
        ],
        proofSource,
      );
      facts.link(
        workId,
        proofId,
        "selected-proof",
        "maintained",
        field(source, "/proof"),
      );
      for (const review of explanation?.review.attachments ?? []) {
        const reviewSource = facts.reference(review.path),
          id = facts.add(
            "review",
            review.path,
            review.path,
            null,
            [{ name: "valid", value: review.valid }],
            reviewSource,
          );
        facts.link(proofId, id, "implementation-review", "observed", reviewSource);
      }
    }
    for (const item of maps.filter(
      (item) => selected.has(item.map.id) && work.featureIds.includes(item.map.id),
    )) {
      facts.link(
        nodeId("feature", item.map.id),
        workId,
        "declared-work",
        "maintained",
        field(source, "/featureIds"),
      );
      for (const criterion of item.map.acceptance.filter((text) =>
        work.acceptance.includes(text),
      )) {
        const id = criterionId(item.map.id, criterion),
          witness = explanation?.acceptance.find((item) => item.criterion === criterion);
        const stale =
          explanation?.scope.some((item) => item.fresh === false) ||
          explanation?.technical.errors.some((error) =>
            /scope changed|changeset state drifted|log hash does not match|argv differs/.test(
              error,
            ),
          );
        const associated =
          readiness.admission.readyForReview.length === 0 &&
          explanation?.task === work.id;
        const qualifies = Boolean(
          explanation?.technical.valid &&
          associated &&
          additionalRequirements.length === 0 &&
          readiness.eligibility.readyForReview === true &&
          witness?.satisfied,
        );
        const status: GraphCriterionEvidence["status"] = !explanation
          ? work.proof
            ? "unknown"
            : "missing"
          : explanation.recordedStatus === "failed"
            ? "failed"
            : stale
              ? "stale"
              : !explanation.technical.valid
                ? "invalid"
                : !associated
                  ? "unrelated"
                  : qualifies &&
                      readiness.eligibility.completed === true &&
                      explanation.review.accepted
                    ? "accepted"
                    : qualifies
                      ? "technical"
                      : "invalid";
        const evidence: GraphCriterionEvidence = {
          featureId: item.map.id,
          criterionId: id,
          criterion,
          workId: work.id,
          proof: work.proof ?? null,
          status,
          qualifies,
          assurance: explanation?.coverage.assurance ?? "unknown",
          diagnostics: [
            ...(explanation?.technical.errors ?? []),
            ...readiness.admission.readyForReview,
            ...additionalRequirements,
            ...readiness.dimensions
              .filter(
                (entry) =>
                  [
                    "scope",
                    "scope-verification",
                    "risk",
                    "feature-contracts",
                    "verification-configuration",
                  ].includes(entry.id) && entry.status !== "passed",
              )
              .map((entry) => `${entry.id}: ${entry.reason}`),
          ]
            .slice(0, 40)
            .map((value) => value.slice(0, 4000)),
          sources: [
            field(item.source, "/acceptance"),
            field(source, "/acceptance"),
            ...(proofSource ? [proofSource] : []),
            ...inventoryMatches.map((match) => match.source),
          ],
        };
        if (result.criteria.length >= graphLimits.criterionRecords)
          throw new Error("Graph exceeds 20000 criterion evidence records");
        facts.account(evidence);
        result.criteria.push(evidence);
        if (proofId)
          facts.link(
            id,
            proofId,
            qualifies ? "current-criterion-evidence" : "selected-unqualified-evidence",
            "observed",
            proofSource!,
          );
      }
    }
  }
}

/** Compose maintained references, scoped readiness and explicit changeset facts without project execution or writes. */
export async function queryCapabilityGraph(
  root: string,
  options: GraphQuery = {},
): Promise<CapabilityGraphResult> {
  const result: CapabilityGraphResult = {
    schemaVersion: "1",
    kind: "capability-graph",
    identity: "",
    status: "incomplete",
    query: {
      feature: options.feature ?? null,
      paths: sorted(options.paths ?? []),
      base: options.base ?? null,
    },
    affectedFeatureIds: [],
    effectiveRisk: "R0",
    verificationTargets: [],
    policyEvaluation: {
      mode: policyMode(options.baseline),
      baseline: options.baseline ?? null,
      limitations: options.baseline ? [] : [candidatePolicyLimitation],
    },
    nodes: [],
    edges: [],
    criteria: [],
    drift: [],
    changeset: null,
    scope: null,
    readiness: [],
    page: { offset: 0, limit: options.limit ?? 200, totalNodes: 0, nextCursor: null },
    analysis: {
      status: "not-evaluated",
      gaps: [
        "Maintained references and path overlaps do not establish transitive runtime impact or semantic prose freshness.",
        "Runtime reachability, computed imports and language-specific effects were not analysed.",
      ],
    },
    diagnostics: [],
    limits: graphLimits,
    inputs: [],
  };
  const facts = new Facts(root);
  try {
    if (
      !Number.isInteger(result.page.limit) ||
      result.page.limit < 1 ||
      result.page.limit > graphLimits.page
    )
      throw new Error("Graph page limit must be 1..1000");
    const configSource = facts.read("arrs.json").source,
      config = readConfig(root);
    facts.read(config.riskPolicy);
    facts.read(config.architecture.policy);
    readRiskPolicy(root, config);
    if (options.baseline) policyRequirements(root, ["."], "R0", options.baseline);
    const maps = loadMaps(facts, config);
    let paths = result.query.paths;
    if (options.base) {
      const snapshot = inspectChangeset(root, options.base);
      if (snapshot.status !== "complete")
        throw new Error(snapshot.diagnostics.join("; "));
      result.changeset = snapshot;
      for (const record of [...snapshot.endpoints, ...snapshot.layers])
        facts.account(record);
      result.query.base = snapshot.base;
      paths = sorted([
        ...paths,
        ...snapshot.endpoints.filter((item) => !item.excluded).map((item) => item.path),
      ]);
      result.drift = driftContracts(facts, maps, config, snapshot);
      if (paths.length) {
        const probe = checkChangesetScope(
          root,
          { scope: paths, risk: "R0" },
          snapshot.base,
        );
        result.scope =
          probe.effectiveRisk > "R0"
            ? checkChangesetScope(
                root,
                { scope: paths, risk: probe.effectiveRisk },
                snapshot.base,
              )
            : probe;
        for (const record of [...snapshot.endpoints, ...snapshot.layers])
          facts.account(record);
        result.effectiveRisk = result.scope.effectiveRisk;
        result.verificationTargets = result.scope.verificationTargets;
        if (!result.scope.passed) facts.diagnostics.push(...result.scope.diagnostics);
      }
    }
    for (const path of paths) safePath(root, path);
    const selected = new Set<string>();
    if (options.feature) {
      if (!maps.some((item) => item.map.id === options.feature))
        throw new Error(`Unknown feature ${options.feature}`);
      selected.add(options.feature);
    } else if (paths.length) {
      for (const item of maps)
        if (
          paths.some((path) =>
            [...item.map.implementation, ...item.map.entryPoints].some((reference) =>
              repositoryPathsOverlap(root, path, reference),
            ),
          )
        )
          selected.add(item.map.id);
      for (const historical of result.scope?.features ?? []) selected.add(historical.id);
    } else if (!options.base) for (const item of maps) selected.add(item.map.id);
    result.affectedFeatureIds = sorted([...selected]);
    // Classify all overlaps under the unchanged shared admission contract.
    const selectionPaths = paths.length
      ? paths
      : maps
          .filter((item) => selected.has(item.map.id))
          .flatMap((item) => [...item.map.implementation, ...item.map.entryPoints]);
    if (selectionPaths.length) {
      result.effectiveRisk = classifyRisk(
        root,
        selectionPaths,
        result.effectiveRisk,
        readRiskPolicy(root, config),
        maps.map((item) => item.map),
      );
      const requirements = policyRequirements(
        root,
        selectionPaths,
        result.effectiveRisk,
        options.baseline,
      );
      result.effectiveRisk = requirements.risk;
      const overlapping = maps.filter((item) =>
        selectionPaths.some((path) =>
          [...item.map.implementation, ...item.map.entryPoints].some((reference) =>
            repositoryPathsOverlap(root, path, reference),
          ),
        ),
      );
      result.verificationTargets = sorted([
        ...result.verificationTargets,
        ...requirements.verificationTargets,
        ...overlapping.map((item) => item.map.verification.target),
      ]);
    }
    const contextIds = new Set(selected);
    // Overlapping maps explain additional floor/target obligations without asserting runtime dependency.
    for (const item of maps)
      if (
        selectionPaths.some((path) =>
          [...item.map.implementation, ...item.map.entryPoints].some((reference) =>
            repositoryPathsOverlap(root, path, reference),
          ),
        )
      )
        contextIds.add(item.map.id);
    const queue = [...contextIds];
    for (let at = 0; at < queue.length; at++)
      for (const dependency of maps.find((item) => item.map.id === queue[at])?.map
        .dependencies ?? [])
        if (!contextIds.has(dependency)) {
          contextIds.add(dependency);
          queue.push(dependency);
        }
    for (const item of maps.filter((item) => contextIds.has(item.map.id)))
      addMap(facts, item, config);
    // Removed maps retain comparison-side statements and obligations explicitly.
    if (result.changeset) {
      const before = readComparisonContracts(root, result.changeset, graphLimits);
      for (const map of before.features.filter(
        (map) => selected.has(map.id) && !maps.some((item) => item.map.id === map.id),
      )) {
        const record = before.featureSources.find((source) => source.id === map.id)!,
          source: GraphSource = {
            path: record.path,
            sha256: record.sha256,
            pointer: "",
            revision: result.changeset.base,
          },
          feature = facts.add(
            "feature",
            map.id,
            map.id,
            map.id,
            [
              { name: "comparisonOnly", value: true },
              { name: "risk", value: map.risk },
              { name: "goal", value: map.goal },
            ],
            source,
          );
        for (const path of [...map.entryPoints, ...map.implementation]) {
          const id = facts.add(
            "source",
            posix.normalize(path),
            path,
            null,
            [{ name: "present", value: existsSync(safePath(root, path)) }],
            { path, pointer: "", sha256: null, revision: result.changeset.base },
          );
          facts.link(feature, id, "comparison-implementation", "maintained", source);
        }
        const targetSource = field(
            {
              path: "arrs.json",
              pointer: "",
              sha256: before.sources.find((item) => item.path === "arrs.json")!.sha256,
              revision: result.changeset.base,
            },
            `/verifyTargets/${pointerPart(map.verification.target)}`,
          ),
          target = facts.add(
            "target",
            map.verification.target,
            map.verification.target,
            null,
            [
              { name: "comparisonOnly", value: true },
              {
                name: "argv",
                value: before.config.verifyTargets[map.verification.target]!.argv,
              },
            ],
            targetSource,
          );
        facts.link(
          feature,
          target,
          "comparison-verification",
          "maintained",
          field(source, "/verification/target"),
        );
      }
    }
    for (const path of paths) {
      const source = facts.reference(path, false),
        id = facts.add(
          "source",
          posix.normalize(path),
          path,
          null,
          [{ name: "present", value: existsSync(safePath(root, path)) }],
          source,
        );
      for (const item of maps.filter((item) => selected.has(item.map.id)))
        if (
          [...item.map.implementation, ...item.map.entryPoints].some((reference) =>
            repositoryPathsOverlap(root, path, reference),
          )
        )
          facts.link(
            nodeId("feature", item.map.id),
            id,
            "path-overlap",
            "observed",
            item.source,
          );
    }
    await selectedEvidence(facts, maps, config, selected, options, result);
    for (const item of maps.filter((item) => selected.has(item.map.id)))
      for (const criterion of item.map.acceptance)
        if (
          !result.criteria.some(
            (evidence) =>
              evidence.featureId === item.map.id && evidence.criterion === criterion,
          )
        ) {
          const evidence: GraphCriterionEvidence = {
            featureId: item.map.id,
            criterionId: criterionId(item.map.id, criterion),
            criterion,
            workId: null,
            proof: null,
            status: "missing",
            qualifies: false,
            assurance: "unknown",
            diagnostics: [
              "No explicitly related work item selects current evidence for this criterion",
            ],
            sources: [field(item.source, "/acceptance")],
          };
          if (result.criteria.length >= graphLimits.criterionRecords)
            throw new Error("Graph exceeds 20000 criterion evidence records");
          facts.account(evidence);
          result.criteria.push(evidence);
        }
    // Dangling edges remain diagnostics rather than silently omitted relationships.
    for (const edge of facts.edges.values())
      if (!facts.nodes.has(edge.from) || !facts.nodes.has(edge.to))
        facts.diagnostics.push(
          `Graph relationship references an unselected or missing node: ${edge.relation} ${edge.from} -> ${edge.to}`,
        );
    result.nodes = [...facts.nodes.values()].sort((a, b) => compare(a.id, b.id));
    result.edges = [...facts.edges.values()].sort((a, b) => compare(a.id, b.id));
    result.criteria.sort((a, b) =>
      compare(
        JSON.stringify([a.featureId, a.criterion, a.workId]),
        JSON.stringify([b.featureId, b.criterion, b.workId]),
      ),
    );
    result.inputs = [...facts.inputs.values()].sort((a, b) =>
      compare(JSON.stringify([a.revision, a.path]), JSON.stringify([b.revision, b.path])),
    );
    // Re-read exactly the bytes used by this projection before calling it complete.
    for (const source of result.inputs.filter(
      (source) => !source.revision && source.sha256,
    ))
      if (hash(graphBytes(root, source.path)) !== source.sha256)
        throw new Error(`Graph input changed during collection: ${source.path}`);
    result.diagnostics = sorted(facts.diagnostics)
      .slice(0, 40)
      .map((value) => value.slice(0, 4000));
    result.status = result.diagnostics.length ? "incomplete" : "complete";
    if (result.status === "incomplete") withholdQualification(result);
    result.identity = hash(
      JSON.stringify({
        query: result.query,
        nodes: result.nodes,
        edges: result.edges,
        criteria: result.criteria,
        drift: result.drift,
        inputs: result.inputs,
        baseline: options.baseline ?? null,
        diagnostics: result.diagnostics,
        status: result.status,
      }),
    );
    let offset = 0;
    if (options.cursor) {
      if (options.cursor.length > 1024)
        throw new Error("Graph cursor exceeds 1024 bytes");
      const cursor = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString("utf8"),
      ) as { version?: unknown; identity?: unknown; offset?: unknown };
      if (
        cursor.version !== "1" ||
        cursor.identity !== result.identity ||
        !Number.isInteger(cursor.offset) ||
        Number(cursor.offset) < 0
      )
        throw new Error(
          "Graph cursor is malformed or stale for these exact inputs/query",
        );
      offset = Number(cursor.offset);
    }
    result.page.totalNodes = result.nodes.length;
    result.page.offset = offset;
    if (offset > result.nodes.length)
      throw new Error("Graph cursor offset exceeds the current graph");
    result.nodes = result.nodes.slice(offset, offset + result.page.limit);
    const next = offset + result.nodes.length;
    result.page.nextCursor =
      result.status === "complete" && next < result.page.totalNodes
        ? Buffer.from(
            JSON.stringify({ version: "1", identity: result.identity, offset: next }),
          ).toString("base64url")
        : null;
    // Edges reference full stable node IDs; page node presence is an explicit view limit.
    void configSource;
  } catch (error) {
    result.diagnostics = sorted([
      ...facts.diagnostics,
      ...result.diagnostics,
      message(error),
    ])
      .slice(0, 40)
      .map((value) => value.slice(0, 4000));
    if (facts.outputBytes > graphLimits.outputBytes) {
      result.nodes = [];
      result.edges = [];
      result.criteria = [];
      result.drift = [];
      result.readiness = [];
      result.inputs = [];
      result.changeset = null;
      result.scope = null;
      result.affectedFeatureIds = [];
      result.verificationTargets = [];
      result.page.totalNodes = 0;
      result.page.nextCursor = null;
    }
    result.status = "incomplete";
    withholdQualification(result);
    result.identity = hash(
      JSON.stringify({
        query: result.query,
        nodes: result.nodes,
        edges: result.edges,
        criteria: result.criteria,
        drift: result.drift,
        inputs: result.inputs,
        diagnostics: result.diagnostics,
        status: result.status,
        baseline: options.baseline ?? null,
      }),
    );
  }
  return result;
}

function withholdQualification(result: CapabilityGraphResult): void {
  result.page.nextCursor = null;
  const diagnostic =
    "Graph collection is incomplete; criterion qualification is withheld";
  for (const criterion of result.criteria) {
    criterion.qualifies = false;
    if (["technical", "accepted"].includes(criterion.status))
      criterion.status = "invalid";
    criterion.diagnostics = [
      diagnostic,
      ...criterion.diagnostics.filter((value) => value !== diagnostic),
    ].slice(0, 40);
  }
  for (const edge of result.edges)
    if (edge.relation === "current-criterion-evidence") {
      edge.relation = "selected-unqualified-evidence";
      edge.id = nodeId(
        "edge",
        JSON.stringify([edge.from, edge.to, edge.relation, edge.origin, edge.sources[0]]),
      );
    }
  result.edges = [...new Map(result.edges.map((edge) => [edge.id, edge])).values()].sort(
    (a, b) => compare(a.id, b.id),
  );
}

export function renderCapabilityGraph(result: CapabilityGraphResult): string {
  const lines = [
    `Capability graph ${result.status} (${result.identity})`,
    `Affected features: ${result.affectedFeatureIds.join(", ") || "none mapped"}`,
    `Risk floor: ${result.effectiveRisk}; verification: ${result.verificationTargets.join(", ") || "none mapped"}`,
    `Policy evaluation: ${result.policyEvaluation.mode}`,
  ];
  for (const node of result.nodes) {
    lines.push(
      `${node.kind}: ${node.label} (${node.sources.map((source) => `${source.path}${source.pointer}`).join(", ")})`,
    );
    for (const fact of node.facts)
      lines.push(`  ${fact.name}: ${JSON.stringify(fact.value)}`);
  }
  const visible = new Map(result.nodes.map((node) => [node.id, node.label]));
  for (const edge of result.edges.filter(
    (edge) => visible.has(edge.from) || visible.has(edge.to),
  ))
    lines.push(
      `${visible.get(edge.from) ?? edge.from} -- ${edge.relation} [${edge.origin}] --> ${visible.get(edge.to) ?? edge.to} (${edge.sources.map((source) => `${source.path}${source.pointer}`).join(", ")})`,
    );
  for (const evidence of result.criteria)
    lines.push(
      `Criterion ${evidence.featureId}: ${evidence.criterion} — ${evidence.status}${evidence.proof ? ` (${evidence.proof})` : ""}`,
    );
  for (const change of result.drift)
    lines.push(
      `Drift ${change.featureId ?? "configuration"}.${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`,
    );
  for (const diagnostic of result.diagnostics) lines.push(`Incomplete: ${diagnostic}`);
  lines.push(
    ...result.analysis.gaps,
    ...result.policyEvaluation.limitations,
    `Nodes ${result.page.offset + 1}..${result.page.offset + result.nodes.length} of ${result.page.totalNodes}${result.page.nextCursor ? `; next cursor ${result.page.nextCursor}` : ""}`,
  );
  return (
    lines.join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\uFFFD") +
    "\n"
  );
}
export function capabilityGraphHtml(result: CapabilityGraphResult): string {
  const escape = (value: string): string =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
          character
        ]!,
    );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>ARRS capability graph</title><style>body{font:16px system-ui;margin:2rem;max-width:100rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}</style><h1>ARRS capability graph</h1><pre>${escape(renderCapabilityGraph(result))}</pre></html>\n`;
}
interface MapFact {
  map: FeatureMap;
  source: GraphSource;
}
function loadMaps(facts: Facts, config: ArrsConfig): MapFact[] {
  const files = walkFiles(facts.root, config.knowledge.features, {
    includeIgnored: true,
    maxFiles: graphLimits.features,
  })
    .filter((path) => path.endsWith(".json"))
    .sort(compare);
  const result: MapFact[] = [],
    ids = new Set<string>();
  for (const path of files) {
    const { bytes, source } = facts.read(path),
      value: unknown = JSON.parse(bytes.toString("utf8")),
      errors = validate("feature", value);
    if (errors.length) {
      facts.diagnostics.push(`Invalid map ${path}: ${errors.join("; ")}`);
      continue;
    }
    const map = value as FeatureMap;
    if (ids.has(map.id)) {
      facts.diagnostics.push(`Duplicate feature identity ${map.id}`);
      continue;
    }
    ids.add(map.id);
    result.push({ map, source });
  }
  const scans = scanFeatures(facts.root, config, {
    includeIgnored: true,
    maxFiles: graphLimits.features,
  });
  facts.diagnostics.push(...scans.errors);
  // Iterative dependency traversal keeps cycle diagnostics bounded and avoids stack overflow.
  const byId = new Map(result.map((item) => [item.map.id, item.map])),
    colors = new Map<string, number>();
  for (const start of byId.keys()) {
    if (colors.has(start)) continue;
    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }];
    colors.set(start, 1);
    while (stack.length) {
      const top = stack.at(-1)!,
        map = byId.get(top.id)!;
      if (top.index >= map.dependencies.length) {
        colors.set(top.id, 2);
        stack.pop();
        continue;
      }
      const next = map.dependencies[top.index++]!;
      if (!byId.has(next)) {
        facts.diagnostics.push(`Unknown feature dependency ${next} from ${top.id}`);
        continue;
      }
      if (colors.get(next) === 1) {
        const at = stack.findIndex((item) => item.id === next);
        facts.diagnostics.push(
          `Feature dependency cycle: ${[...stack.slice(at).map((item) => item.id), next].join(" -> ")}`,
        );
        continue;
      }
      if (!colors.has(next)) {
        colors.set(next, 1);
        stack.push({ id: next, index: 0 });
      }
    }
  }
  return result;
}
const field = (source: GraphSource, pointer: string): GraphSource => ({
  ...source,
  pointer,
});
const pointerPart = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
const criterionId = (feature: string, text: string): string =>
  nodeId("criterion", JSON.stringify([feature, text]));
function addMap(facts: Facts, item: MapFact, config: ArrsConfig): void {
  const { map, source } = item,
    feature = facts.add(
      "feature",
      map.id,
      map.id,
      map.id,
      [
        { name: "goal", value: map.goal },
        { name: "risk", value: map.risk },
        { name: "owners", value: map.owners },
        { name: "boundaries", value: map.boundaries },
      ],
      source,
    );
  for (const [kind, paths] of [
    ["implementation", map.implementation],
    ["entryPoints", map.entryPoints],
  ] as const)
    paths.forEach((path, index) => {
      const reference = facts.reference(path),
        id = facts.add(
          "source",
          posix.normalize(path),
          path,
          null,
          [{ name: "present", value: existsSync(safePath(facts.root, path)) }],
          reference,
        );
      facts.link(feature, id, kind, "maintained", field(source, `/${kind}/${index}`));
    });
  for (const [kind, values] of [
    ["invariant", map.invariants],
    ["criterion", map.acceptance],
  ] as const)
    values.forEach((text, index) => {
      const pointer = `/${kind === "criterion" ? "acceptance" : "invariants"}/${index}`,
        reference = field(source, pointer);
      const id = facts.add(
        kind,
        JSON.stringify([map.id, text]),
        text,
        map.id,
        [{ name: "text", value: text }],
        reference,
      );
      facts.link(feature, id, kind, "maintained", reference);
    });
  const target = map.verification.target,
    configured = Object.hasOwn(config.verifyTargets, target);
  const targetSource = field(
    facts.inputs.get("arrs.json")!,
    `/verifyTargets/${pointerPart(target)}`,
  );
  const targetId = facts.add(
    "target",
    target,
    target,
    null,
    [
      { name: "configured", value: configured },
      { name: "argv", value: configured ? config.verifyTargets[target]!.argv : [] },
    ],
    targetSource,
  );
  facts.link(
    feature,
    targetId,
    "verification",
    "maintained",
    field(source, "/verification/target"),
  );
  for (const [index, path] of map.related.entries()) {
    const reference = facts.reference(path),
      kind = path.startsWith(config.knowledge.decisions + "/") ? "decision" : "source";
    const id = facts.add(
      kind,
      posix.normalize(path),
      path,
      null,
      [{ name: "present", value: existsSync(safePath(facts.root, path)) }],
      reference,
    );
    facts.link(feature, id, "related", "maintained", field(source, `/related/${index}`));
  }
  for (const [index, id] of map.dependencies.entries())
    facts.link(
      feature,
      nodeId("feature", id),
      "dependency",
      "maintained",
      field(source, `/dependencies/${index}`),
    );
}
function driftContracts(
  facts: Facts,
  maps: MapFact[],
  config: ArrsConfig,
  snapshot: ChangesetSnapshot,
): GraphDrift[] {
  const before = readComparisonContracts(facts.root, snapshot, graphLimits),
    result: GraphDrift[] = [];
  const append = (record: GraphDrift): void => {
    if (result.length >= graphLimits.drift)
      throw new Error("Graph exceeds 20000 drift records");
    facts.account(record);
    result.push(record);
  };
  const oldSources = new Map(
    before.sources.map((source) => [
      source.path,
      { ...source, pointer: "", revision: snapshot.base },
    ]),
  );
  for (const source of oldSources.values()) {
    facts.account(source);
    facts.inputs.set(`${snapshot.base}:${source.path}`, source);
  }
  const old = new Map(before.features.map((map) => [map.id, map])),
    current = new Map(maps.map((item) => [item.map.id, item]));
  for (const id of sorted([...old.keys(), ...current.keys()])) {
    const a = old.get(id),
      b = current.get(id),
      oldPath = before.featureSources.find((source) => source.id === id)?.path;
    const provenance = [
      oldSources.get(oldPath ?? "") ?? {
        path: before.config.knowledge.features,
        pointer: "",
        sha256: null,
        revision: snapshot.base,
      },
      b?.source ?? {
        path: config.knowledge.features,
        pointer: "",
        sha256: null,
        revision: null,
      },
    ];
    if (!a || !b) {
      append({
        featureId: id,
        field: "feature",
        before: a ?? null,
        after: b?.map ?? null,
        sources: provenance,
      });
      continue;
    }
    for (const name of [
      "goal",
      "owners",
      "entryPoints",
      "implementation",
      "boundaries",
      "dependencies",
      "invariants",
      "acceptance",
      "verification",
      "risk",
      "sensitivity",
      "related",
    ] as const)
      if (JSON.stringify(a[name]) !== JSON.stringify(b.map[name]))
        append({
          featureId: id,
          field: name,
          before: a[name],
          after: b.map[name],
          sources: provenance.map((source) => field(source, `/${name}`)),
        });
  }
  for (const target of sorted([
    ...Object.keys(before.config.verifyTargets),
    ...Object.keys(config.verifyTargets),
  ]))
    if (
      JSON.stringify(before.config.verifyTargets[target] ?? null) !==
      JSON.stringify(config.verifyTargets[target] ?? null)
    )
      append({
        featureId: null,
        field: `verifyTargets/${target}`,
        before: before.config.verifyTargets[target] ?? null,
        after: config.verifyTargets[target] ?? null,
        sources: [
          field(oldSources.get("arrs.json")!, `/verifyTargets/${pointerPart(target)}`),
          field(facts.inputs.get("arrs.json")!, `/verifyTargets/${pointerPart(target)}`),
        ],
      });
  for (const endpoint of snapshot.endpoints.filter(
    (endpoint) =>
      !endpoint.excluded && Boolean(endpoint.before) !== Boolean(endpoint.after),
  )) {
    const references = sorted(
      [...before.features, ...maps.map((item) => item.map)]
        .filter((map) =>
          [...map.implementation, ...map.entryPoints, ...map.related].some((path) =>
            repositoryPathsOverlap(facts.root, endpoint.path, path),
          ),
        )
        .map((map) => map.id),
    );
    for (const featureId of references.length ? references : [null])
      append({
        featureId,
        field: `${featureId ? "reference-presence" : "source-presence"}/${endpoint.path}`,
        before: { present: Boolean(endpoint.before), blob: endpoint.before },
        after: { present: Boolean(endpoint.after), bytes: endpoint.after },
        sources: [
          { path: endpoint.path, pointer: "", sha256: null, revision: snapshot.base },
          {
            path: endpoint.path,
            pointer: "",
            sha256: endpoint.after?.sha256 ?? null,
            revision: null,
          },
        ],
      });
  }
  return result;
}
