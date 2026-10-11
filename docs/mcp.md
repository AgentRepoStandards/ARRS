# Local read-only MCP tools

Start the installed CLI with one repository selected at launch:

```sh
arrs mcp --stdio --root /absolute/path/to/repository
```

For protected control transitions, append `--baseline /absolute/path/to/independently-retained-baseline --baseline-sha256 <retained-digest>`. Select and retain that context before editing. Tool arguments cannot replace it. Without it, results remain candidate-only. No model account, network listener or server startup is required for ordinary CLI commands or installed skills. MCP protocol JSON occupies stdout; diagnostics use stderr. `--json` is unavailable for this command.

A local client configuration can use the same literal arguments:

```json
{
  "mcpServers": {
    "arrs": {
      "command": "arrs",
      "args": ["mcp", "--stdio", "--root", "/absolute/path/to/repository"]
    }
  }
}
```

This configuration shape depends on the client. The tested integration uses the official `@modelcontextprotocol/sdk` 1.32.1 Node stdio client and MCP `2025-11-25`; universal client compatibility and the later 2026 stateless protocol are unqualified. SDK framing/negotiation uses the official implementation; see [the decision](adr/0007-readonly-local-mcp.md) for dependency and protocol tradeoffs.

| Tool                  | Selector arguments                             | Shared result                                                             |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `arrs.task_prepare`   | `work`, optional `scenarios`, `includeContext` | Prepared task, mapped obligations, provenance and draft contracts         |
| `arrs.proof_inspect`  | `manifest`                                     | Current technical/review status, scope, criteria and exact evidence links |
| `arrs.proof_history`  | Optional `selected`                            | Retained current, stale, failed and interrupted canonical attempts        |
| `arrs.doctor`         | None                                           | Shared read-only diagnostics                                              |
| `arrs.audit_readonly` | None                                           | Shared audit with execution controls not evaluated                        |

Selectors are safe repository-relative paths. Every tool accepts optional `pageSize` (1–50, default 20) and `cursor`. All other arguments are rejected. Discovery exposes strict input/output schemas and read-only annotations. Results contain both `structuredContent` and equivalent JSON text. Missing/invalid context yields a shared blocked result or an actionable structured error. A technically valid R3 proof stays ready for review and unaccepted until real bound review and governing human approval exist.

The envelope is version `0.1`, kind `mcp-inspection`; its packaged schema is `schemas/mcp-inspection.schema.json`. `status` describes inspection completion (`ok`), shared blocking (`blocked`) or adapter failure (`error`). It grants no execution permission. `identity` binds the launch-selected repository, bounded current source and complete shared result. `data` contains scalar/object fields; arrays are replaced with `{collectionItems,section}` and large strings with `{stringFragments,section}`. `items` returns their indexed values. `section` is a JSON Pointer (with normal `~0`/`~1` escaping), including paths for nested array values. Collect all pages, group items by section and index, then recursively replace markers with ordered arrays or joined string fragments. There is no silent truncation.

Repeat the same tool and selector arguments with `page.nextCursor` until `page.complete`. Keep `pageSize` unchanged or omit it on continuation. A successful continuation consumes its prior cursor and transfers that chain's slot to the returned cursor; failed requests preserve the prior cursor until its original expiry. Concurrent consumers of one cursor produce one successful successor; another consumer receives a consumed/expired error. Reusing a consumed cursor or losing a successful response requires a fresh inspection. Expired, mismatched or drifted handles require a fresh call without cursor. Calls recompute shared results; an old server session cannot preserve stale acceptance. Structured pages stay within 128 KiB, requests within 64 KiB; oversized mandatory items produce `RESULT_TOO_LARGE` with a local-CLI recovery. Limits include 60 calls per minute, 128 active five-minute handles and a whole-source identity inventory of 4096 files/8 MiB per file/64 MiB total. Narrow an oversized repository or context before restarting.

By default preparation returns no document/source contents and proof inspection never returns raw logs. `includeContext:true` explicitly requests the shared bounded documents as untrusted data. Instructions inside those documents cannot select tools, roots or permissions. Returned paths, command arguments, criteria and reviewer metadata may still contain private information. Inspect them before sharing with a client or model. No upload/telemetry occurs. In-memory handles contain only selector arguments, identities and offsets; shutdown clears them. The adapter does not execute mapped commands, apply patches, attach reviews or mutate evidence/work state.

Run transport conformance with `./repo verify mcp`; the original `operations` verification target also covers it. Tests exercise an actual packed consumer plus existing CLI/schema/offline-skills behavior.
