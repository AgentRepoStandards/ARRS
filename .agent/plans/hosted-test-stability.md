# Hosted test setup stability

Status: candidate preparation; hosted qualification and overall runtime implementation acceptance pending.

## Goal and evidence

Preserve the packed consumer and real browser assertions while making their test setup use the hosted runner's available tools and cache. The previous candidate recorded three browser readiness deadline failures and a Windows Node 22 npm install timeout. Other jobs passed these same cases. These observations do not establish a browser defect or the underlying install stall.

The observed Ubuntu image supplies both stable Google Chrome through `CHROME_BIN` and a separate Chromium snapshot. Respect the existing explicit `ARRS_REPORT_BROWSER` selection first, then the image's stable browser selection, then the current Chromium fallback. Keep the existing launch flags, 10-second readiness deadline, 30-second test limit and actual DOM and network assertions. Capture early process errors or exits without waiting for the readiness timer.

For the real tarball installation, prefer cached npm metadata without prohibiting network access on cache misses. Keep the same native npm argv, 60-second limit, strict success assertion, dependency exclusions, installed CLI, MCP and offline skills checks. Cache policy is a bounded mitigation; it does not prove that registry revalidation caused the historical timeout.

## Scope and proof

This is an R1 test setup refactor covering `tests/package.test.mjs`, `tests/proof-explanation.mjs` and this plan. Production code, CI workflow, configured gate commands, policies, assertions and deadlines remain unchanged.

Capture the successful configured proof verification, including real hostile report rendering, before applying the reviewed fixture changes. Capture the identical verification after applying them, together with the required full test suite, static checks and a build. The earlier frozen candidate's full suite supplies additional consumer evidence; it does not replace this capture or establish the new candidate's result. Preserve all earlier failed hosted attempts and both earlier corrective proofs. Independently inspect the final source, proof and hosted matrix before requesting the required acceptance of the overall R3 runtime correction.

## Acceptance and limits

The same proof verification must prove hostile report rendering before and after setup changes. The full suite must prove the actual installed consumer behavior and retain every existing assertion. Qualify the resulting source on the four hosted OS and Node combinations. Do not treat local success, improved diagnostics or a partially completed hosted job as a successful matrix.

Browser and registry availability remain external dependencies. Stable browser selection and cache reuse require measurement on the hosted runner. The original Windows outcome directory durability limitation remains documented in `docs/metrics.md`.
