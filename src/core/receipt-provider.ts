import { assertValid } from "./schema.js";
import type {
  LocalReceiptBundle,
  ProviderRun,
  ProviderReview,
  ReceiptCommand,
} from "./receipt.js";

/** Bounded offline GitHub API projection. Protected observations are supplied by
 * an independently selected fixture authority, never by candidate workflow text.
 * This projection performs no network call, signing or production admission. */
export interface GitHubOfflineRunInput {
  run: {
    id: number;
    repository: { html_url: string };
    head_sha: string;
    event: string;
    status: string;
    conclusion: string;
    created_at: string;
    updated_at: string;
  };
  protectedWorkflow: ProviderRun["workflow"];
  protectedToolSha256: string;
  selectedControls: ProviderRun["controls"];
  candidateSequence: number;
  evaluationSequence: number;
  candidateAuthorId: string;
  observedCommands: ReceiptCommand[];
  artifacts: { name: string; size_in_bytes: number; digest: string }[];
  nonce: string;
}
export function githubOfflineRun(
  input: GitHubOfflineRunInput,
  bundle: LocalReceiptBundle,
): ProviderRun {
  assertValid<LocalReceiptBundle>("receipt-bundle", bundle);
  if (
    bundle.scope.assurance !== "git-complete" ||
    !bundle.scope.base ||
    !bundle.scope.revision ||
    !bundle.scope.fingerprint
  )
    throw new Error(
      "GitHub offline provider requires immutable complete Git comparison evidence",
    );
  if (!Number.isSafeInteger(input.run.id) || input.run.id < 1)
    throw new Error("Unsupported GitHub run identity");
  const run: ProviderRun = {
    schemaVersion: "1",
    kind: "github-offline-run",
    category: bundle.category,
    repository: input.run.repository.html_url,
    revision: input.run.head_sha,
    comparisonBase: bundle.scope.base,
    runId: `github-run:${input.run.id}`,
    attemptId: bundle.proofId,
    manifestSha256: bundle.manifestSha256,
    candidateAuthorId: input.candidateAuthorId,
    workflow: input.protectedWorkflow,
    toolSha256: input.protectedToolSha256,
    controls: input.selectedControls,
    candidateSequence: input.candidateSequence,
    evaluationSequence: input.evaluationSequence,
    trigger: input.run.event,
    startedAt: input.run.created_at,
    finishedAt: input.run.updated_at,
    state: input.run.status,
    conclusion: input.run.conclusion,
    commands: input.observedCommands,
    acceptance: bundle.acceptance,
    scope: {
      assurance: "git-complete",
      fingerprint: bundle.scope.fingerprint,
      base: bundle.scope.base,
      revision: bundle.scope.revision,
    },
    artifacts: input.artifacts.map((item) => {
      if (!item.digest.startsWith("sha256:"))
        throw new Error("Unsupported GitHub artifact digest algorithm");
      return { name: item.name, sha256: item.digest.slice(7), bytes: item.size_in_bytes };
    }),
    nonce: input.nonce,
  };
  assertValid<ProviderRun>("receipt-run", run);
  return run;
}
export interface GitHubOfflineReviewInput {
  id: number;
  user: { id: number };
  commit_id: string;
  state: string;
  submitted_at: string;
}
/** Protected approval collection binds revision and opaque provider IDs. Local
 * proof independent/humanApproval strings are deliberately not an input. */
export function githubOfflineReview(
  input: GitHubOfflineReviewInput,
  run: ProviderRun,
  role: ProviderReview["role"],
  sequence: number,
): ProviderReview {
  if (![input.id, input.user.id].every((id) => Number.isSafeInteger(id) && id > 0))
    throw new Error("Unsupported GitHub protected review identity");
  const review: ProviderReview = {
    schemaVersion: "1",
    kind: "github-offline-review",
    repository: run.repository,
    revision: input.commit_id,
    comparisonBase: run.comparisonBase,
    runId: run.runId,
    attemptId: run.attemptId,
    manifestSha256: run.manifestSha256,
    controlsSha256: run.controls.sha256,
    role,
    actorId: `github-user:${input.user.id}`,
    reviewId: `github-review:${input.id}`,
    state: input.state,
    sequence,
    submittedAt: input.submitted_at,
  };
  assertValid<ProviderReview>("receipt-review", review);
  return review;
}
