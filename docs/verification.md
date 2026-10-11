# Verification

`arrs.json` is the source of truth for commands. `./repo setup`, `dev`, `check`, `test`, `verify [target]` and `build` delegate to configured argument vectors. Commands run from the repository root with `shell: false`; a missing command or target fails explicitly. The command interface propagates the underlying exit status. Timeouts are failures.

Named verification targets must be own entries explicitly configured in `verifyTargets`; inherited object properties do not qualify. Feature Maps and work readiness apply the same rule as the shared CLI and generated runner. An absent `toString` target reports the actionable missing-target error, while a deliberately configured own `toString` target executes its literal argv and preserves its exit status.

The default timeout is 300 seconds; `timeoutSeconds` permits 1–3600 seconds. This ARRS checkout gives its complete `test` command an explicit 900-second budget. The earlier 208-test suite completed on hosted Windows Node 22 in about 552 seconds; its repeated run inside proof was still progressing when the previous 600-second deadline expired. That historical failed proof reports exit 124. The current suite discovers every `tests/*.test.mjs` entry and runs at most two isolated files concurrently; helper modules are imported by their owning suite. All assertions, per-fixture timeout checks, required gates and failure propagation remain active. Reassess runtime against actual CI results as the suite grows; historical timings do not establish current matrix success. Timeout returns 124, missing executables return 127 and other spawn failures return 126. On Unix, signalled exits use `128 + signal number`. SIGINT/SIGTERM cancellation forwards termination to the command process group, including descendants, and escalates if needed. Windows uses process-tree termination. SIGKILL or abrupt machine loss cannot run parent cleanup.

Stopped commands retain group ownership through a one-second grace and forced cleanup even when the direct child closes first. Timeout and output-limit results are returned after that cleanup; the original cause remains 124 or 125 when the grace crosses the configured deadline. Cancellation retains the first signal's exit code (SIGINT 130, SIGTERM 143); repeated signals do not restart the grace. Windows observes `taskkill /t /f` completion with bounded helper timeouts. The cancellation fallback runs after normal cleanup and waits for its termination helpers. Cleanup owns the original group/tree: a descendant deliberately detached into another group is outside that ownership. Normal command completion retains its original exit status without a cleanup delay.

Regression tests use a signal-resistant descendant with independent output streams and assert that its heartbeat stops before caller completion. Timeout/output-limit cases exercise the shared CLI runner and generated `repo` interface on all CI platforms. Unix cancellation regressions exercise both signals and repeated interruptions; Windows uses process-tree termination rather than POSIX signal forwarding.

Captured command output is limited to 8 MiB of UTF-8 bytes across stdout and stderr. Exceeding the cap terminates the command and returns 125. Output is decoded across chunk boundaries so multibyte text retains its meaning.

The generated runner works with CommonJS, ES module and unspecified package types. On Windows, `npm`/`npm.cmd` commands use Node's `npm-cli.js` entry point without shell evaluation; `argv` in evidence retains the configured logical command. Other batch-file tools need a directly executable or explicit interpreter mapping. Review that mapping under the same repository-command trust boundary.

`check` protects formatting, static policy and compiler constraints. `test` protects automated examples of expected behaviour. `verify` demonstrates acceptance at the real boundary: a CLI invocation, HTTP request, data round trip or other externally observable scenario. A passing unit test alone need not establish that a user workflow works.

Write deterministic targets with a fixed setup, exact expected result and cleanup. Name them in Feature Maps. Use local fixtures when remote dependencies would introduce nondeterminism or credentials. Make the target fail when the observable requirement breaks. Keep generated logs/artifacts in `.arrs/`.

In ARRS itself, `npm run check`, `npm test` and `npm run verify` are distinct verification layers; `npm run audit` runs its executed self-assessment. CI exercises the same source configuration. The test suite includes malformed config, maturity fixtures, non-destructive initialization, command failures and proof validation.

The reference CI audit recognizes direct command steps and fails closed on conditional verification gates or job conditions. An artifact-upload `if: always()` is supported. This text adapter is an intentionally limited check; it does not evaluate all GitHub Actions YAML or replace the CI service's execution.

Job dependencies support literal `needs: build`, inline `needs: [build, test]` (including empty `[]`), and indented block lists of literal job identifiers. Quoted identifiers and trailing comments are supported. References may point forward, but every named job must exist; self-dependencies and cycles anywhere in the graph fail with affected job names. Dynamic expressions, aliases, mappings, nested children and malformed/continued scalars or sequences are unsupported. See the [exact literal subset](spec/0.1.md). A valid static graph establishes neither a successful hosted run nor branch protection.

Before accepting a change, validate its [Proof Contract](proof-contract.md). Before reporting maturity, run `arrs audit --execute` in the intended environment. A static audit cannot demonstrate successful runtime verification.

## CLI option applicability

`--root` and `--json` apply to every command. Action-specific global flags are accepted only by their owning command, regardless of position:

| Flag                   | Accepted command/action                             |
| ---------------------- | --------------------------------------------------- |
| `--dry-run`            | `init`                                              |
| `--execute`            | `audit`, `proof run`, `proof start`, `proof finish` |
| `--require-level 0..4` | `audit`                                             |
| `--risk R0..R4`        | `risk`                                              |
| `--to <state>`         | `work transition`                                   |
| `--accepted`           | `proof validate`                                    |

An unsupported flag exits nonzero before writes, configured command execution or network work; `--json` errors remain machine-readable. For example, `arrs skills install --dry-run` rejects the flag and installs nothing. Preview initialization with `arrs init --dry-run`; inspect skill status/diff using their supported actions. Skills-specific options retain their existing per-action validation and documented repeatable reconciliation controls. Help/version keep their existing read-only behavior.
