# Public snapshot content

The public repository starts with a reviewed source snapshot. The original private development repository retains its tracked historical records and Git history; they are not imported into the public Git history. Retention of historical ignored logs and generated evidence has not been established by this preparation.

The snapshot includes implementation, tests, schemas, bootstrap assets, templates, fixtures, product documentation and the active repository contract. Active `.agent/policies/`, the repository runner, `.agent/proof-plan.json`, example work items and the plan/review directory scaffolds remain available. New public work uses the normal risk, verification and review contracts.

Historical execution plans, issue-delivery notes, review and acceptance records, and obsolete development proof plans are excluded. These records contain private development context and do not establish acceptance of a new snapshot. Public summaries retain technical findings and limitations without reproducing conversations, personal filesystem paths or private issue links. Excluding records does not replace their contents or manufacture historical approvals, baseline identities or passing evidence.

The [first qualification report](qualification/v0.1.md) is a historical technical summary. Its original local logs and review records are not distributed, and availability of its historical ignored logs and generated evidence has not been verified. Its reported results describe the development revision examined at that time and have not been independently reverified by this preparation; current validation must use the current checkout and capture new evidence under ignored `.arrs/`.

Keep `LICENSE`, `NOTICE`, third-party licenses, pinned upstream source and provenance intact. Inspect the staged source for credentials, personal data, private links and generated evidence before publishing. Scan the final public Git history as well as the working tree. A pattern scanner's result does not establish that every secret format or private record was detected.

Changing the visibility of the private development repository would disclose its old commits and hosted conversations. Publishing this snapshot must create new public history and must leave the private archive private.
