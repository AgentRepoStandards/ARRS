# Locked packed-consumer fixture

Status at preparation: candidate; native hosted qualification and overall runtime implementation acceptance pending.

## Goal and observed failure

Both hosted Windows Node 24 jobs passed the Git fixture cases but failed the real packed-package install after 60,029 milliseconds against its existing 60,000-millisecond limit. The retained native error was ETIMEDOUT with SIGTERM and empty output. Cache preference did not resolve the timeout. The underlying process or registry cause remains unestablished, and the cancelled Windows verification jobs do not supply completed qualification.

Prepare the consumer fixture from the repository's existing qualified dependency lock. Retain its complete runtime dependency resolution, including nested and peer requirements, and bind the actual packed artifact with its native integrity and file locator. Execute the same real npm install under the same 60-second limit using offline cache resolution. Missing cache data, integrity errors, changed runtime resolution and failed installation must remain fatal. Do not copy installed dependencies or substitute an install result.

## Risk, scope and evidence

This R1 test setup refactor covers `tests/package.test.mjs` and this plan. Production code, repository dependency declarations and lock, workflow, configured commands and time limits remain unchanged. Preserve every original packed-consumer assertion, including development-dependency exclusion, executable schemas and documentation, actual local MCP, offline skills and adoption behavior.

Capture the original packed-consumer case and the candidate case with the same native test command as supplemental evidence. The configured standard verification does not run that case: capture it separately before and after the edit, while keeping the required protected before/after standard verification, static checks, all tests and build active. Standard verification must retain its CLI acceptance, proof and audit guards, Git changeset checks and capability graph behavior. Keep all four earlier corrective proofs and every failed hosted attempt immutable.

## Acceptance and remaining limits

The real tarball installation and its consumer assertions must pass at the qualified runtime dependency versions. This fixture does not establish latest registry range resolution or registry availability. The normal repository setup still installs the qualified lock through the existing command. This setup choice does not identify the historical stall's cause.

Qualify all four hosted OS and Node combinations, including completed native Windows verification, before requesting the overall R3 implementation acceptance. Successful local evidence, a prepared payload or a partial hosted suite does not replace those results or the required human review.
