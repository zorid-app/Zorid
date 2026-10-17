# Base semantics preparation corpus

Baseline: Zorid `f69dc90de0de697dfb75a5a3d1805b69dba982b3`, Node 26.10.0,
`TZ=UTC`. Read [the contract proposal](../../../../docs/stage4-base-contract.md)
for ownership, pinned MDBASE sources, the extraction boundary and pending decisions.

- `expressions.json`: 30 expressions, context and tagged expected values. `repeat`
  reuses one compiled expression; it captures mutable regex state deliberately.
- `queries.json`: 10 detached snapshots/configurations and selected expected
  paths, values, groups/counts/diagnostics. Omitted result fields are not asserted.
- `documents.json`: 7 exact source strings, including BOM/CRLF and malformed YAML.
- `portable-cases.json`: additional proposed cross-platform checks, pending the
  shared API and dialect decision. These are specifications, not passing tests.
- `verify-current.mjs`: lightweight current-TypeScript baseline runner. Run with
  existing repository dependencies; no install is needed.

```sh
TZ=UTC node tests/fixtures/document-semantics/bases/verify-current.mjs
```

When the fixture checkout has no node_modules, pass `--source-root` pointing at a
checkout with the same baseline semantic source and existing dependencies. The
runner imports that source directly. It is not part of the root wildcard test
command and must be invoked explicitly during preparation review.

`current` is verified existing behavior, not always the chosen portable behavior.
`decision: retain` proposes keeping it; `decision: proposed-change` plus
`proposed` or `proposal` records a correction requiring coordinator acceptance.
The runner validates **only current**, never the pending corrections. Future
native/WASM runners must select the accepted expectation explicitly; do not
silently bless every new library result by regenerating expected output.

Values use `{type, value}` recursively for null/primitive/list/object results;
null has no value field. Dates use `{type: "date", timestamp, hasTime}` and errors
use `{type: "error", code}`. To preserve a baseline quirk, nonfinite numbers use
string value `"Infinity"`/`"NaN"`; this is fixture encoding only, not a public API.
Unpaired UTF-16 surrogates are escaped JSON strings recording existing broken
reversal. A scalar-string portable implementation should compare against the
approved proposed value. Current error messages/stack traces are not frozen.

Raw source remains authoritative even when semantic compilation fails. These
cases do not authorize Rust YAML reserialization, imported collection storage,
server plaintext queries, filesystem access or new plugin execution. No MDBASE
code or upstream oracle fixtures are copied here.
