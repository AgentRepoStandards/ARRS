import { strict as assert } from "node:assert";
import { before, test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixture, invoke, readJson, writeJson } from "./helpers.mjs";
import { inspectPolicyBaseline } from "../dist/core/policy-baseline.js";
import {
  canonicalReceiptJson as canonical,
  receiptSigningBytes,
  sha256,
  receiptMediaType,
  providerMediaType,
} from "../dist/core/receipt.js";
import { githubOfflineRun, githubOfflineReview } from "../dist/core/receipt-provider.js";

const repository = "https://github.com/fixture-owner/fixture-repo";
const instant = "2026-10-08T12:00:00.000Z";
let fixture;
function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function key(id) {
  const pair = generateKeyPairSync("ed25519");
  return {
    id,
    keyId: id,
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey,
  };
}
function publicRoot(root) {
  const { privateKey, ...value } = root;
  return value;
}
function envelope(value, identity, type = providerMediaType) {
  const text = canonical(value);
  return {
    payloadType: type,
    payload: Buffer.from(text).toString("base64"),
    signatures: [
      {
        keyid: identity.keyId,
        sig: sign(null, receiptSigningBytes(type, text), identity.privateKey).toString(
          "base64",
        ),
      },
    ],
  };
}
function statement(run, reviews, roots) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: repository, digest: { gitCommit: run.revision } }],
    predicateType: "https://arrs.dev/predicates/trusted-receipt/v1",
    predicate: {
      schemaVersion: "1",
      assurance: "offline-provider-conformance",
      verifierId: roots.verifier.id,
      nonce: run.nonce,
      issuedAt: "2026-10-08T12:00:03.000Z",
      expiresAt: "2026-10-08T12:05:03.000Z",
      run: envelope(run, roots.provider),
      reviews: reviews.map((review) => envelope(review, roots.review)),
    },
  };
}
before(() => {
  const root = makeFixture(3);
  const retained = mkdtempSync(join(tmpdir(), "arrs receipt retained "));
  cpSync(root, retained, { recursive: true });
  const baseline = inspectPolicyBaseline(root, retained);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Known-good fixture"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, "src/domain/greeting.mjs"),
    readFileSync(join(root, "src/domain/greeting.mjs"), "utf8") +
      "// Immutable candidate exercised by the offline provider.\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Candidate fixture"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const plan = readJson(root, "proof-plan.json");
  plan.changeset = { version: "1", mode: "git", base };
  writeJson(root, ".arrs/receipt-plan.json", plan);
  const flags = ["--baseline", baseline.root, "--baseline-sha256", baseline.sha256];
  const capture = invoke(root, [
    "proof",
    "run",
    ".arrs/receipt-plan.json",
    "--execute",
    ...flags,
  ]);
  assert.equal(capture.status, 0, capture.stdout + capture.stderr);
  const manifest = JSON.parse(capture.stdout).path;
  const exported = invoke(root, [
    "receipt",
    "export",
    manifest,
    "--output",
    ".arrs/receipts/original",
    ...flags,
  ]);
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  const bundle = readJson(root, ".arrs/receipts/original/bundle.json");
  const roots = {
    verifier: key("fixture-verifier"),
    provider: key("fixture-provider"),
    review: key("fixture-review-authority"),
  };
  const policy = {
    schemaVersion: "1",
    kind: "receipt-consumer-policy",
    provider: "github-offline-v1",
    repository,
    verifier: {
      ...publicRoot(roots.verifier),
      workflow: { repository, path: ".github/workflows/trusted.yml", revision: base },
      toolSha256: sha256("retained verifier bytes"),
    },
    providerAuthority: publicRoot(roots.provider),
    reviewAuthority: publicRoot(roots.review),
    allowedTriggers: ["pull_request", "workflow_dispatch"],
    reviewers: { independent: ["github-user:101"], humanAcceptance: ["github-user:102"] },
    maximumAgeSeconds: 300,
    allowInspectionReuse: true,
  };
  const controls = {
    id: "fixture-retained-controls",
    sha256: baseline.sha256,
    selectionSequence: 1,
    requiredChecks: ["check", "test", "build"],
    requiredIndependent: true,
    requiredHumanAcceptance: true,
  };
  const artifactBytes = readFileSync(join(root, ".arrs/receipts/original/bundle.json"));
  const run = githubOfflineRun(
    {
      run: {
        id: 9001,
        repository: { html_url: repository },
        head_sha: revision,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        created_at: instant,
        updated_at: "2026-10-08T12:00:01.000Z",
      },
      protectedWorkflow: policy.verifier.workflow,
      protectedToolSha256: policy.verifier.toolSha256,
      selectedControls: controls,
      candidateSequence: 2,
      evaluationSequence: 3,
      candidateAuthorId: "github-user:100",
      observedCommands: bundle.commands,
      artifacts: [
        {
          name: "bundle.json",
          size_in_bytes: artifactBytes.length,
          digest: `sha256:${sha256(artifactBytes)}`,
        },
      ],
      nonce: "fixture-challenge-0001",
    },
    bundle,
  );
  const reviews = [
    githubOfflineReview(
      {
        id: 801,
        user: { id: 101 },
        commit_id: revision,
        state: "APPROVED",
        submitted_at: "2026-10-08T12:00:02.000Z",
      },
      run,
      "independent",
      4,
    ),
    githubOfflineReview(
      {
        id: 802,
        user: { id: 102 },
        commit_id: revision,
        state: "APPROVED",
        submitted_at: "2026-10-08T12:00:02.000Z",
      },
      run,
      "humanAcceptance",
      5,
    ),
  ];
  const context = {
    schemaVersion: "1",
    kind: "receipt-consumer-context",
    mode: "admission",
    category: bundle.category,
    repository,
    revision,
    comparisonBase: base,
    controls,
    candidateSequence: 2,
    requiredCommands: bundle.commands.map(
      ({ command, target, argvSha256, timeoutSeconds }) => ({
        command,
        ...(target ? { target } : {}),
        argvSha256,
        timeoutSeconds,
      }),
    ),
    requiredCriteria: bundle.acceptance.map((item) => item.criterionSha256),
    scopeFingerprint: bundle.scope.fingerprint,
    attemptId: bundle.proofId,
    manifestSha256: bundle.manifestSha256,
    nonce: run.nonce,
    now: "2026-10-08T12:00:04.000Z",
    consumedNonces: [],
    consumedReceipts: [],
  };
  fixture = {
    root,
    baseline,
    flags,
    bundle,
    run,
    reviews,
    roots,
    policy,
    context,
    manifest,
  };
});
let counter = 0;
function scenario(change = () => {}, options = {}) {
  const data = Object.fromEntries(
    Object.entries({
      bundle: fixture.bundle,
      run: fixture.run,
      reviews: fixture.reviews,
      policy: fixture.policy,
      context: fixture.context,
    }).map(([name, value]) => [name, structuredClone(value)]),
  );
  change(data);
  const directory = `.arrs/receipts/scenario-${++counter}`;
  mkdirSync(join(fixture.root, directory), { recursive: true });
  const bytes = canonical(data.bundle) + "\n";
  writeFileSync(join(fixture.root, directory, "bundle.json"), bytes);
  data.run.artifacts = [
    { name: "bundle.json", bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) },
  ];
  const signed = statement(data.run, data.reviews, fixture.roots);
  options.statement?.(signed);
  const receipt = {
    schemaVersion: "1",
    kind: "trusted-receipt",
    envelope: envelope(
      signed,
      options.signer ?? fixture.roots.verifier,
      receiptMediaType,
    ),
  };
  options.receipt?.(receipt);
  options.context?.(data.context, receipt);
  writeJson(fixture.root, `${directory}/receipt.json`, receipt);
  const external = mkdtempSync(join(tmpdir(), "arrs receipt consumer "));
  writeJson(external, "policy.json", data.policy);
  writeJson(external, "context.json", data.context);
  const flags = [
    "--trust",
    join(external, "policy.json"),
    "--trust-sha256",
    sha256(readFileSync(join(external, "policy.json"))),
    "--context",
    join(external, "context.json"),
    "--context-sha256",
    sha256(readFileSync(join(external, "context.json"))),
    "--artifacts",
    directory,
  ];
  return { directory, receipt: `${directory}/receipt.json`, external, flags, data };
}
function verify(s) {
  const result = invoke(fixture.root, ["receipt", "verify", s.receipt, ...s.flags]);
  assert.ok(result.stdout, result.stderr);
  return { result, value: JSON.parse(result.stdout) };
}
function reject(name, change, check, diagnostic, options = {}) {
  test(`receipt conformance: ${name}`, () => {
    const { result, value } = verify(scenario(change, options));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(value.admission, false);
    assert.equal(value[check].passed, false, result.stdout);
    assert.match(value[check].errors.join(" "), diagnostic);
  });
}
test("receipt conformance: actual immutable scenario and protected provider review chain pass offline only", () => {
  const s = scenario();
  const { result, value } = verify(s);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of [
    "authenticity",
    "freshness",
    "policy",
    "scope",
    "evidence",
    "acceptance",
  ])
    assert.equal(value[name].passed, true, name);
  assert.equal(value.valid, true);
  assert.equal(value.conformancePassed, true);
  assert.equal(value.admission, false);
  assert.equal(value.hostedAssurance, "not-qualified");
  const imported = invoke(fixture.root, [
    "receipt",
    "import",
    s.receipt,
    ...s.flags,
    "--output",
    ".arrs/receipts/imported",
  ]);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.deepEqual(
    readFileSync(join(fixture.root, ".arrs/receipts/imported/bundle.json")),
    readFileSync(join(fixture.root, s.directory, "bundle.json")),
  );
  assert.equal(
    invoke(fixture.root, [
      "receipt",
      "import",
      s.receipt,
      ...s.flags,
      "--output",
      ".arrs/receipts/imported",
    ]).status,
    1,
  );
});
reject("well-formed untrusted signature", () => {}, "authenticity", /Untrusted signer/, {
  signer: key("untrusted-verifier"),
});
reject("signature tampering", () => {}, "authenticity", /Signature invalid/, {
  receipt: (receipt) => {
    receipt.envelope.signatures[0].sig = Buffer.alloc(64).toString("base64");
  },
});
reject("tampered subject", () => {}, "freshness", /Wrong repository/, {
  statement: (signed) => {
    signed.subject[0].name = "https://github.com/other/repo";
  },
});
reject(
  "wrong immutable revision",
  (data) => {
    data.run.revision = "a".repeat(40);
  },
  "freshness",
  /Wrong repository/,
);
reject(
  "comparison base mismatch",
  (data) => {
    data.run.comparisonBase = "a".repeat(40);
  },
  "freshness",
  /comparison base/,
);
reject(
  "retained controls weakened",
  (data) => {
    data.run.controls.requiredChecks = ["check"];
  },
  "policy",
  /Retained governing/,
);
reject(
  "policy digest tamper",
  (data) => {
    data.run.controls.sha256 = "a".repeat(64);
  },
  "policy",
  /Retained governing/,
);
reject(
  "post-edit baseline selection",
  (data) => {
    data.run.controls.selectionSequence = 2;
    data.context.controls.selectionSequence = 2;
  },
  "policy",
  /after candidate creation/,
);
reject(
  "workflow weakening",
  (data) => {
    data.run.workflow.revision = "a".repeat(40);
  },
  "policy",
  /workflow\/tool/,
);
reject(
  "required command drift",
  (data) => {
    data.run.commands[0].argvSha256 = "a".repeat(64);
    data.bundle.commands = data.run.commands;
  },
  "policy",
  /changed required command/,
);
reject(
  "required command omitted",
  (data) => {
    data.run.commands.splice(0, 1);
    data.bundle.commands = data.run.commands;
  },
  "policy",
  /Missing/,
);
reject(
  "skipped execution",
  (data) => {
    data.run.commands[0].execution = "skipped";
    data.bundle.commands = data.run.commands;
  },
  "evidence",
  /Skipped/,
);
reject(
  "unsupported trigger",
  (data) => {
    data.run.trigger = "pull_request_target";
  },
  "policy",
  /Unsupported/,
);
reject(
  "run failure",
  (data) => {
    data.run.conclusion = "failure";
  },
  "evidence",
  /unsuccessful/,
);
reject(
  "uncovered scope",
  (data) => {
    data.run.scope.fingerprint = "a".repeat(64);
    data.bundle.scope = data.run.scope;
  },
  "scope",
  /complete changeset/,
);
reject(
  "wrong proof attempt",
  (data) => {
    data.run.attemptId = "other-attempt";
    data.bundle.proofId = data.run.attemptId;
  },
  "scope",
  /exact proof attempt/,
);
reject(
  "unlinked acceptance",
  (data) => {
    data.run.acceptance[0].resultIndices = [0];
    data.bundle.acceptance = data.run.acceptance;
  },
  "acceptance",
  /behavioral result/,
);
reject(
  "fake local human review",
  (data) => {
    data.reviews[1].actorId = "fabricated-local-name";
    data.bundle.acceptedLocal = true;
  },
  "acceptance",
  /Actual protected/,
);
reject(
  "wrong-revision review",
  (data) => {
    data.reviews[0].revision = "a".repeat(40);
  },
  "acceptance",
  /Protected review does not bind/,
);
reject(
  "revoked approval",
  (data) => {
    data.reviews.push({
      ...data.reviews[1],
      reviewId: "github-review:803",
      sequence: 6,
      state: "DISMISSED",
    });
  },
  "acceptance",
  /revoked/,
);
reject(
  "ambiguous review",
  (data) => {
    data.reviews.push({ ...data.reviews[1], reviewId: "github-review:803" });
  },
  "acceptance",
  /Ambiguous duplicate/,
);
reject(
  "stale receipt",
  (data) => {
    data.context.now = "2026-10-08T12:10:00.000Z";
  },
  "freshness",
  /stale/,
);
reject(
  "replayed challenge",
  (data) => {
    data.context.consumedNonces = [data.context.nonce];
  },
  "freshness",
  /replayed/,
);
reject(
  "different challenge",
  (data) => {
    data.context.nonce = "another-consumer-challenge";
  },
  "freshness",
  /challenge/,
);
reject("noncanonical signed payload", () => {}, "authenticity", /canonical compact/, {
  receipt: (receipt) => {
    const signed = Buffer.from(receipt.envelope.payload, "base64").toString("utf8");
    const ambiguous = signed.replace("{", '{"_type":"https://in-toto.io/Statement/v1",');
    receipt.envelope.payload = Buffer.from(ambiguous).toString("base64");
    receipt.envelope.signatures[0].sig = sign(
      null,
      receiptSigningBytes(receiptMediaType, ambiguous),
      fixture.roots.verifier.privateKey,
    ).toString("base64");
  },
});
test("receipt conformance: inspection reuse is explicit and does not admit", () => {
  const s = scenario((data) => {
    data.context.mode = "inspection";
    data.context.consumedNonces = [data.context.nonce];
  });
  assert.equal(verify(s).value.valid, true);
  assert.equal(verify(s).value.admission, false);
});
test("receipt conformance: artifact alteration blocks import before effects", () => {
  const s = scenario();
  writeFileSync(join(fixture.root, s.directory, "bundle.json"), "{}\n");
  assert.match(verify(s).value.evidence.errors.join(" "), /digest\/length mismatch/);
  const result = invoke(fixture.root, [
    "receipt",
    "import",
    s.receipt,
    ...s.flags,
    "--output",
    ".arrs/receipts/rejected",
  ]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(fixture.root, ".arrs/receipts/rejected")), false);
});
test("receipt conformance: external selection pins and candidate policy reject before effects", () => {
  const s = scenario();
  writeJson(fixture.root, "candidate-policy.json", s.data.policy);
  const flags = [...s.flags];
  flags[1] = join(fixture.root, "candidate-policy.json");
  assert.match(
    invoke(fixture.root, ["receipt", "verify", s.receipt, ...flags]).stdout,
    /outside the candidate/,
  );
  writeFileSync(join(s.external, "policy.json"), "{}\n");
  assert.match(
    invoke(fixture.root, ["receipt", "verify", s.receipt, ...s.flags]).stdout,
    /bytes drifted/,
  );
});
test("receipt conformance: aliases, symlinks, oversized inputs and unsupported flags reject", () => {
  const s = scenario();
  const flags = [...s.flags];
  flags[flags.length - 1] = `${s.directory}/../scenario-${counter}`;
  assert.equal(
    invoke(fixture.root, ["receipt", "verify", s.receipt, ...flags]).status,
    1,
  );
  symlinkSync(
    join(fixture.root, s.receipt),
    join(fixture.root, s.directory, "linked.json"),
  );
  assert.equal(
    invoke(fixture.root, ["receipt", "verify", `${s.directory}/linked.json`, ...s.flags])
      .status,
    1,
  );
  writeFileSync(join(fixture.root, s.directory, "oversized.json"), " ".repeat(1_000_001));
  assert.equal(
    invoke(fixture.root, [
      "receipt",
      "verify",
      `${s.directory}/oversized.json`,
      ...s.flags,
    ]).status,
    1,
  );
  assert.equal(
    invoke(fixture.root, ["receipt", "verify", s.receipt, ...s.flags, "--execute"])
      .status,
    1,
  );
  assert.equal(
    invoke(fixture.root, [
      "receipt",
      "verify",
      s.receipt,
      ...s.flags,
      "--trust",
      s.flags[1],
    ]).status,
    1,
  );
});
test("receipt conformance: metadata export excludes source, argv, prose and personal review text", () => {
  const text = readFileSync(
    join(fixture.root, ".arrs/receipts/original/bundle.json"),
    "utf8",
  );
  assert.equal(text.includes("Hello,"), false);
  assert.equal(text.includes("Greets a trimmed name"), false);
  assert.equal(text.includes(process.execPath), false);
  assert.equal(text.includes("humanApproval"), false);
  assert.equal(
    readJson(fixture.root, ".arrs/receipts/original/bundle.json").acceptedLocal,
    true,
  );
  const original = readFileSync(join(fixture.root, fixture.manifest));
  const exported = invoke(fixture.root, [
    "receipt",
    "export",
    fixture.manifest,
    "--output",
    ".arrs/receipts/original",
    ...fixture.flags,
  ]);
  assert.equal(exported.status, 1);
  assert.deepEqual(readFileSync(join(fixture.root, fixture.manifest)), original);
  assert.equal(readdirSync(join(fixture.root, ".arrs/receipts/original")).length, 1);
});

reject(
  "untrusted protected run authority",
  () => {},
  "authenticity",
  /Untrusted signer/,
  {
    statement: (value) => {
      const run = JSON.parse(
        Buffer.from(value.predicate.run.payload, "base64").toString("utf8"),
      );
      value.predicate.run = envelope(run, key("untrusted-provider"));
    },
  },
);
reject(
  "untrusted protected review authority",
  () => {},
  "authenticity",
  /Untrusted signer/,
  {
    statement: (value) => {
      const review = JSON.parse(
        Buffer.from(value.predicate.reviews[0].payload, "base64").toString("utf8"),
      );
      value.predicate.reviews[0] = envelope(review, key("untrusted-review"));
    },
  },
);
reject(
  "missing final human approval",
  (data) => {
    data.reviews.pop();
  },
  "acceptance",
  /Actual protected humanAcceptance/,
);
reject(
  "nontechnical bundle",
  (data) => {
    data.bundle.technicalPassed = false;
  },
  "evidence",
  /do not substantiate/,
);
reject("replayed receipt digest", () => {}, "freshness", /replayed/, {
  context: (context, receipt) => {
    context.consumedReceipts = [sha256(JSON.stringify(receipt, null, 2) + "\n")];
  },
});
reject(
  "hidden duplicate earlier review sequence",
  (data) => {
    data.reviews.push({ ...data.reviews[1], reviewId: "github-review:803", sequence: 9 });
    data.reviews.push({ ...data.reviews[1], reviewId: "github-review:804" });
  },
  "acceptance",
  /Ambiguous duplicate/,
);
test("receipt conformance: duplicate outer JSON fields fail authenticity", () => {
  const s = scenario();
  const path = join(fixture.root, s.receipt);
  writeFileSync(path, readFileSync(path, "utf8").replace("{", '{"schemaVersion":"1",'));
  const value = verify(s).value;
  assert.equal(value.authenticity.passed, false);
  assert.match(value.authenticity.errors.join(" "), /duplicate JSON field/);
});
