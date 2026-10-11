# Offline receipt conformance

ARRS receipts are opt-in version 1 documents. The GitHub offline profile checks separately authenticated fixture run and review observations against consumer-selected external keys, retained controls and exact immutable candidate context. Successful fixture verification reports `conformancePassed: true`, `admission: false`, `hostedAssurance: "not-qualified"`. Hosted receipt issuance and provider admission remain unqualified and require separately authorized qualification. Enabling ordinary repository CI for the public launch does not qualify this offline profile.

Export current local technical evidence without source/log contents, argv, acceptance prose or reviewer names:

```sh
arrs receipt export .arrs/evidence/<attempt>/proof.json --output .arrs/receipts/<fresh-name> --json
```

Protected evidence still requires the independently selected `--baseline`/`--baseline-sha256` pair. Export creates one `bundle.json` with local integrity assurance. It does not sign or authenticate local evidence; `acceptedLocal` cannot replace provider review. A Git bundle must identify committed source layers and its explicit base/HEAD. Legacy/non-Git bundles retain declared-only assurance.

The external protected consumer selects policy and request files before evaluating a candidate, then retains their SHA-256 pins outside candidate control. Versioned schemas are `receipt-policy` and `receipt-context`; see [the trust decision](adr/0007-offline-trusted-receipts.md) for root, event order, gate, expected command/criterion, review and replay responsibilities. Supplying a candidate-created file outside its checkout does not establish independent selection. Test fixtures use ephemeral keys and modeled protected events; they are never production signer identities.

```sh
arrs receipt verify .arrs/receipts/input/receipt.json \
  --trust /external/consumer-policy.json --trust-sha256 <retained-pin> \
  --context /external/expected-request.json --context-sha256 <retained-pin> \
  --artifacts .arrs/receipts/input --json
```

The result separates authenticity, freshness, policy, scope, evidence and acceptance. Invalid external selections fail before evaluation; an untrusted signer blocks protected claims. Required retained commands, actual execution outcomes, exact Git scope and bound protected reviews must all agree. Version 1 supports one metadata `bundle.json`; raw source/log artifacts are unsupported. Verification reads only, runs no commands and makes no network requests. Replay rejection uses the external request's consumed challenge/digest state. Explicit policy-authorized inspection reuse does not admit again, and a future admitting consumer must atomically consume its own challenge state.

Import a passing offline receipt into a fresh ignored directory with the same trust selections:

```sh
arrs receipt import .arrs/receipts/input/receipt.json \
  --trust /external/consumer-policy.json --trust-sha256 <retained-pin> \
  --context /external/expected-request.json --context-sha256 <retained-pin> \
  --artifacts .arrs/receipts/input --output .arrs/receipts/<fresh-import> --json
```

Import writes bounded receipt, bundle and verification files exclusively after validating and rechecking digests. Output requires canonical `.arrs/receipts/<name>` paths, whole-directory ignore protection and no overlap with canonical evidence. Existing files, aliases, symlinks, oversized inputs and unsupported flags reject. No output is uploaded. Metadata still may be private; inspect before sharing.

Run `./repo verify receipts` for actual local scenario, offline provider projection, signing/consumer and negative conformance. The existing `./repo verify proof` also includes these cases through its unchanged argv. New target command changes require separate control-transition review and cannot bypass an older retained baseline's strict binding requirements.
