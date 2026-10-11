# Versioned architecture conformance

The reference defaults to `javascript-typescript@js-ts-0.1`. An opt-in provisional `python@candidate-python-ast-0.1` is available for local controls testing; it has not been selected or qualified by a real application pilot. The user confirms that the actual pilot inventory is unavailable. Issue #40's actual participant/package/import selection and permitted/forbidden pilot evidence remain outstanding.

Configure the candidate explicitly in the selected architecture policy, retaining real module paths and public interfaces:

```json
{
  "schemaVersion": "0.1",
  "adapter": {
    "id": "python",
    "version": "candidate-python-ast-0.1",
    "packageRoots": ["src"],
    "runtime": { "argv": ["python3"], "timeoutSeconds": 5 }
  },
  "modules": [
    {
      "id": "domain",
      "path": "src/domain",
      "allows": [],
      "public": ["src/domain/api.py", "src/domain/__init__.py"]
    },
    {
      "id": "application",
      "path": "src/application",
      "allows": ["domain"],
      "public": ["src/application/main.py", "src/application/__init__.py"]
    }
  ]
}
```

Every activated intermediate package initializer also receives the same dependency-direction and public-interface checks; declare it public when a permitted cross-module import necessarily activates it. Here `src` is a module search directory; `domain` and `application` are ordinary packages with initializer files. `from domain.api import greeting` is a permitted cross-module import from application. `from application.main import run` in domain is forbidden. `from domain.private import value` is private unless explicitly public. `from .private import value` within domain remains a same-module import. `from ..domain.api import greeting` in a top-level application package escapes its package root and is rejected. A deeper package may use a relative level while remaining inside its real ordinary-package ancestry.

Literal `import package.module`, import aliases, `from package.module import name` and supported relative forms are analyzed by Python's stdlib AST. Package `from ... import child` checks both the package interface and an existing local child module. A wildcard package import is unsupported. A named symbol in a file is not semantically resolved; use native acceptance/tests to establish actual exports and runtime behavior. Bare dependency/stdlib packages outside configured local roots are not resolved or analyzed. Existing local paths take precedence; unresolved local packages/modules fail.

Examples that fail unsupported include `import importlib`/`runpy`/`pkgutil`, references to `__import__`, `eval` or `exec`, recognized `sys.path`/`meta_path`/`path_hooks`/`modules` mutation and aliases/imports of those resolver fields, namespace packages without initializers, ambiguous local package roots and unknown adapter contract versions. Reflection, monkeypatching, interpreter embedding, custom import machinery and every possible runtime loading mechanism are outside the bounded coverage claim; use native checks and an appropriate reviewed adapter if such behavior is required. Known JS/TS and other source languages in the same declared handwritten scope receive an explicit mixed-language unsupported error. Unknown/non-source files are disclosed in `unscannedFiles`, not claimed as analyzed. No universal language or full-repository semantic coverage is awarded.

Read-only doctor and unexecuted audit never launch a configured external parser: they disclose Python source inventory with zero analyzed files and `not-evaluated` architecture, with guard blocked. The shared coverage/check API supports `allowExternalRuntime: false` for readiness/MCP/report consumers. Explicit gate and executed audit can analyze a trusted selected runtime. The analyzer invokes a single literal configured interpreter executable followed by isolated `-I -S -c` stdlib parsing, with source/path JSON on stdin. It never imports application modules or executes their top-level effects. Source and parser output are bounded to 2 MiB; runtime defaults to five seconds and configured timeout is bounded to 1–30 seconds. Nonzero exit, missing runtime, signal/timeout, oversized output and malformed/partial diagnostics fail the gate. Runtime argv must contain exactly one interpreter executable; script/extra arguments are rejected before effects. Select a trusted compatible Python executable; argv is trusted repository configuration, not authenticated runtime provenance. Native Python commands should use `-B` or keep bytecode output outside proof scope when verifying freshness.

The [ADR](../adr/0006-provisional-language-adapter.md) explains schema/compatibility and qualification limits. The smallest internal seam is source selection, version identity and source analysis/mutation inside architecture core; ownership, traversal, generated exclusions and gate failure remain shared. There is no dynamic plugin registry.

## Reproducible conformance

```sh
./repo build
./repo verify audit
./repo verify qualification
./repo verify end-to-end
./repo verify
```

The existing `audit` target runs the versioned conformance scenarios in [core tests](../../tests/core.test.mjs): default/explicit JS/TS identity and all existing forbidden/private/unresolved/computed/alias/loader cases; candidate Python same-module/allowed public imports; forbidden/private/unowned/unresolved inputs; relative levels and namespace refusal; parser/runtime/failure/timeout/partial output; generated islands and reserved directory source; unsafe paths/symlinks and mixed unsupported language; no-source refusal; no application execution and no mutation; and configured native Python acceptance, actual forbidden-edge rejection and proof freshness.

The intentionally false analyzer fixture reports no imports and exits zero. Normal scan alone appears empty, but the same-analyzer mutation guard must reject it; losing that rejection makes conformance fail. This tests capability enforcement without pretending to authenticate a malicious interpreter. The candidate's reported file counts distinguish discovered source from successful parsing. Doctor/audit expose selected identity, scope, counts, unsupported/error state and provisional qualification; audit also reports `guard: passed|failed|blocked`.

The candidate fixture inventory is synthetic: Python 3.12.14, `src/domain`/`src/application` with `__init__.py`, public `api.py`/`main.py`, absolute/relative/from forms, known unsupported resolver/loaders and explicit generated descendants. It is not a participant inventory. It supplies repeatable control evidence while the real pilot's layout, import patterns, runtime authorization and actual application outcomes remain unavailable. No hosted CI run or application qualification is claimed.
