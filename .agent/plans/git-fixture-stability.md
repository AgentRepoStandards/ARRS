# Isolated Git fixture preparation

Status at preparation: candidate; native hosted qualification and overall runtime implementation acceptance pending.

## Goal and observed failure

Preserve every changeset assertion and the standard verification command's existing deadlines while reducing repeated test setup. A hosted Windows Node 24 job passed the full suite and then returned a null status from the Git changeset verification child after its 120-second limit. The same job's changeset case durations during the full suite summed to about 134 seconds. The child did not record an error or signal, so budget exhaustion is supported by timing rather than a retained native timeout code.

Prepare a pristine fixture with real Git once, then copy its complete files and Git storage into separate fresh directories for each case. Retain independent live filesystem identities and mutable copies; do not share working files, Git storage, links or alternates. Keep actual Git collection, CLI execution, mutations, negative guards and every assertion active. The copied project's descriptive name must remain valid and must not introduce uncommitted source changes.

## Risk, scope and evidence

This R1 test setup refactor covers `tests/changeset.test.mjs` and this plan. Production code, workflow, policies, configured argv and time limits remain unchanged. The existing 120-second changeset child limit and 300-second standard verification limit remain enforced.

Capture successful standard verification before applying the reviewed setup refactor. Run the same verification afterward, along with required static checks, all tests and a build. Independently compare the actual assertions and fixture isolation against the earlier source. Preserve the three earlier immutable corrective proofs and all failed hosted attempts.

## Acceptance and remaining limits

Standard verification must still exercise real CLI acceptance, proof and audit, architecture mutation rejection, failure propagation, Git changeset behavior and capability graph behavior. Every native Git case must retain its original success or rejection assertions. Qualify the resulting source on all four hosted OS and Node combinations before requesting the overall R3 implementation acceptance.

Fixture preparation efficiency does not establish the underlying hosted process or registry stall. The real package install still has its unchanged 60-second limit, and browser readiness retains its 10-second limit. A locally successful refactor does not supply hosted assurance or replace required human acceptance.
