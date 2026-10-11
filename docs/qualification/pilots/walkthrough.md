# Reproducing the reference control boundaries

This walkthrough exercises synthetic greeting repositories through the actual configured commands. It verifies controls rather than application adoption effort, context adequacy or review savings. Actual participant walkthroughs remain outstanding until recruitment, authorization and observations are supplied.

Run from the built ARRS checkout:

```sh
./repo build
./repo verify end-to-end
./repo verify proof
./repo verify operations
node scripts/pilot-protocol.mjs docs/qualification/pilots/missing-observations.json
```

The existing [end-to-end runner](../../../scripts/verify.mjs) initializes a disposable repository, maps its literal commands, invokes the greeting CLI and checks exact trimmed output. It captures a real proof, validates it, exercises an actual forbidden domain-to-application import and preserves exit 37 from a deliberately failing configured command. It removes only its disposable fixture. These scenarios do not observe setup/review timing.

The configured `proof` target includes the scenario “bug start captures failing scenario; same scenario after root-cause fix passes” in [proof tests](../../../tests/proof.test.mjs). It captures the actual failing before invocation, corrects the implementation, and runs the same argv after the fix. “R2 bug evidence becomes reviewable before binding completed implementation review” exercises a technically passing attempt with pending review; completion cannot be claimed yet. “Implementation review rejects failed and noncanonical attempts before writing” confirms rejected proof cannot acquire acceptance. Review input in tests represents a test actor, not actual human acceptance of ARRS changes.

The configured `operations` target includes “work selects the successful retry manifest while failed attempts remain unreviewable” and “technical R2 proof enables review readiness while completion and audit require bound review” in [workflow tests](../../../tests/workflows.test.mjs). These bind the selected successful attempt, retain earlier failures and distinguish proof validation from independently reviewed completion. They are controls assertions, not evidence that a real participant approved an implementation.

The local ledger fixture explicitly labels invented observations `control-fixture`. It retains missing active review seconds, unknown defects and incomplete follow-up, excludes category/risk/window-mismatched comparisons and reports varying denominators. It recruits nobody and supplies no selected application proof. The configured `operations` target exercises replay, malformed/unsafe input rejection and a real selected-attempt binding through the ledger command.

For an actual application, substitute its authorized adoption patch, prepared task, configured acceptance command, original failed attempt, revised selected proof and actual implementation review. Record collection-window boundaries before execution and participant observations at each collection point in the [protocol](README.md). Participant authorization permits execution; required implementation review and human acceptance are separate later facts. Hosted CI is not evaluated by this local walkthrough; enabling the repository's public launch workflow does not establish application-pilot outcomes.
