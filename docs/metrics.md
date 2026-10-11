# Local engineering metrics

Metrics describe a bounded workflow's observed outcomes. ARRS sends no telemetry and never converts missing observations into success, permission, readiness or completed acceptance.

## Automatic lifecycle records (0.2)

The separate `schemas/outcome.schema.json` contract records task/category/effective risk, Feature Map IDs, workflow/model aliases, control/version context, timestamp, source digest, failure categories and a SHA-256 idempotency key. `src/core/outcomes.ts` owns validated persistence and the shared read-only `readOutcomeRecords(root)` interface consumed by metrics and recurrence analysis. No dependency is added. Existing proof/work/metrics documents retain version 0.1.

Proof run and finish record allocation before command execution, then actual technical completion after canonical manifest capture. Start records baseline allocation/completion separately; baseline reproduction is excluded from verification-attempt rates. A stopped capture without completion remains incomplete and unknown, with no successful attempt or completed task. Every distinct immutable attempt has a distinct source identity. Revalidating proof and reading summaries/exports add no events. Reattaching the same review input to the same manifest preserves a single lifecycle fact. Review attachment reports only that attachment; it cannot infer earlier rejection, human interventions or human acceptance.

Successful work transitions are collected after existing admission validation and persistence. A technical pass does not complete a task: the completed-task count requires an observed transition to completed under the existing accepted-proof gates. Collector failures return `outcomeWarnings` separately; canonical proof results, immutable evidence, work state and approval requirements retain their own result. This avoids making an observational filesystem failure corrupt proof or invent a transition. Missing observations remain unknown. Failed technical completion supplies the `verification-failed` category; other categories require explicit observations.

Automatic records use `arrs-local` as workflow alias and omit unknown model identity. Controls hash the actual config, risk/architecture policy and Feature Maps, with ARRS version; this is a comparable local context identity, not an authenticated policy-baseline assertion. Supplying an observation under a different workflow/control context establishes a separate cohort. Task references and categories should be local aliases; do not put customer or personal identifiers in them.

## Explicit follow-up observations

```sh
arrs metrics observe .agent/observations/export-followup.json
arrs metrics summary --workflow arrs-local --risk R2 --feature reports --window 14d --json
arrs metrics summary --start 2026-10-01T00:00:00Z --end 2026-10-08T00:00:00Z --json
arrs metrics export --preview --json
```

An observation is a complete 0.2 record with `kind: "observation"`, maintainer source provenance (a digest alias), an elapsed UTC `window` with `start` and `end`, and `values`. Supported metric keys are `firstPassVerification`, `humanInterventions`, `reviewRejected`, `reverted`, `escapedDefects`, `architectureGateFailures`, `verificationCompleteness`, `activeSeconds`, `durationSeconds` and `cost`. Boolean/count/timing/cost values are validated; cost is comparable only under the maintainer's shared currency convention. Omitted or null values are unknown. False and zero are explicit known observations. Duration, active effort and cost are never inferred from command logs.

`supersedes` names earlier observation IDs for the exact same task/cohort and retains their immutable bytes. A replacement declares its current metric values; omitted replacement values remain unknown. Updates to the same metric and window require explicit supersession. Missing references, later/cyclic replacement and conflicting replacement branches reject. A new window is a new observation; a short zero-defect window cannot qualify a longer window.

The additive `lifecycle` summary is separate from legacy rates. Filters cover workflow, model, category, risk, feature and controls digest. `--window Nd` accepts only observations of exactly that elapsed duration; `--start`/`--end` require exact bounds. Incompatible windows, superseded records and excluded cohorts are counted. Without a window filter, a current explicit metric value is displayed only when its task/cohort has one comparable current window. Competing windows keep that metric unknown until a window filter selects it; all actual windows are listed. Compare matching windows explicitly.

Every metric reports `known`, `unknown`, positive count, total, rate and average. Rates use the metric's known denominator: five task/cohort units with two revert observations and three unknown values report known 2, unknown 3, and a rate from those two observations. An empty denominator returns null. All-zero explicit observations report zero with a positive known denominator. Actual first-pass verification is derived from the first allocated verification attempt only when no follow-up-window filter is requested; an incomplete first attempt stays unknown. Task/cohort units, attempt counts, incomplete attempts, technical passes, completed transitions, observation coverage and small-sample limitations are separate fields. These descriptive samples cannot establish causal benefit or universal safety.

## Persistence, recovery and privacy

New records live in ignored `.arrs/metrics/outcomes/<sha256>.json`. Publication writes a random exclusive temporary file, fsyncs it, then atomically creates the final name with an exclusive hard link and fsyncs its parent. On POSIX, publication requests mode 0600 for committed files and 0700 for new storage directories. On Windows, files and directories inherit directory ACLs; Node mode bits do not establish owner-only access. Concurrent identical identities are no-ops; changed payloads under the same identity fail. Observation publication serializes writers with an exclusive lock, waits at most 500 ms on contention, then reports a retained lock rather than discarding it. This prevents concurrent supersession branches. Lifecycle publication uses exclusive per-ID files and does not wait for the observation lock.

A crash before publication leaves `.pending-*` bytes which summaries count as uncommitted files and never as observations; a crash after publication can leave an extra temporary link but the committed identity still counts once. Retain pending files for inspection; remove them only after confirming no active writer. A retained `.observation-write-lock` or legacy writer lock requires the same explicit inspection before removal. Retrying the exact observation/source identity is safe. Collector warnings do not reconstruct transitions from mutable work state; record missing outcomes explicitly rather than inventing history. The shared `collectPlanLifecycle` API can retry a retained canonical proof source identity, and rejects conflicts. Proof artifacts remain the authoritative engineering evidence.

Reads reject symlinks, traversal, unsupported versions, malformed committed data and unexpected inventory entries. Lifecycle source/type identities and allocated/completed proof-attempt facts must be unique across the whole retained history, including different cohorts; differently named duplicate or conflicting files cannot inflate successful-attempt counts. Timestamp ordering uses actual UTC chronology rather than text ordering of fractional seconds. A record is limited to 64 KiB; new inventory reads to 10,000 entries/32 MiB, and legacy reads to 10,000 records/16 MiB. Archive locally before those limits, preserving immutable records and their supersession chains together. Retention is chosen locally; ARRS never deletes observations automatically. Storage ignore protection reuses the evidence guard; Git exclusion does not establish secrecy.

Export is a read-only preview of approved 0.2 fields. Source references are digests; source contents, command log text, review transcripts, reviewer names, approval text and automatic personal identities are excluded. Supplied task/workflow/model/failure-category aliases still require inspection before sharing. No export upload or network operation exists.

## Legacy manual metrics (0.1)

`arrs metrics record <event-file>` continues to validate the existing `metrics.schema.json` contract and append to `.arrs/metrics/events.jsonl`. Its original top-level summary fields, false/zero semantics and recorded-event denominators remain unchanged. No migration invents observation windows or absent values. Legacy filters cannot make those unwindowed events comparable; the summary labels that limit and filters only its separate lifecycle result.

Legacy appends use an exclusive writer lock, bounded validation and fsync. Duplicate IDs still reject. A corrupt or partial trailing JSONL record cannot produce a successful summary; retain and repair it explicitly. The legacy workflow/model `agent` field is not exported by the new lifecycle preview. Use explicit 0.2 follow-up observations for comparable new measurements.

Use recurring failure categories as [Gardener](gardener.md) evidence and strengthen mechanical controls before changing autonomy. PR volume is not a trust metric.
