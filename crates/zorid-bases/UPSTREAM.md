# MDBASE evaluator extraction provenance

Origin: https://github.com/callumalpass/mdbase-rs
Revision: `2e8f47f3a0737766060599cf9534582bd75aa719` (`0.4.0-rc.6`).
License: MIT, Copyright (c) 2025 Callum Alpass. Full notice in LICENSE-MDBASE.
Zorid adaptations use the repository AGPL-3.0-only license; the upstream notice
continues to apply to the inherited implementation.

Copied implementation:

- `src/views/expression.rs`: lexer, AST/parser, evaluator and builtins, date/time,
  list/string/regex helpers and dependency inspection. Upstream test module is
  excluded. Provider candidate lowering, imports and JSON entrypoint are removed.
- `src/views/files.rs`: in-memory lookup collection. Frontmatter Markdown-link
  extraction and upstream tests are excluded. No filesystem authority is copied.

The local evaluator remains the upstream parser/evaluator implementation with
scoped dialect adaptations. This is not an independently invented formula engine.
No CEL evaluator, Collection, hosted provider, SQLite, filesystem access or watch
implementation is included. The inherited file lookup is not exposed as an
implicit host resolver: host-dependent functions/relationships are rejected in
the initial expression-only API.

Adaptations:

- Portable explicit UTC/fixed/IANA invocation timezone and captured clock; no
  Local/ambient clock feature or native stacker. Exact chrono-tz 0.10.4 std-only
  manifest was source-reviewed (MIT OR Apache-2.0; pure phf lookup; optional build
  tooling disabled). No runtime network or timezone-file lookup is used.
- Shared `zorid_document::PropertyValue` recursively converts to ordered internal
  IndexMap objects; no global serde_json feature changes. Case-insensitive own
  lookup prefers exact spelling then source order, including nested properties.
- Typed results are captured before upstream plain JSON erases dates/durations
  and nonfinite values. Nonfinite numbers are explicit numeric-domain errors.
- AST recursion/chain depth and source size are bounded before evaluation;
  formulas, input/output bytes, compiled regex memory and repeated strings have
  explicit ceilings. Cancellation and AST work remain cooperative.
- No fancy-regex fallback or fake random output. Unsupported regex, host functions
  and missing relationship metadata yield diagnostics. Regex split errors are not
  silently replaced with a literal split result.
- Current null/empty-container truth, strict arithmetic, explicit number-prefix
  conversion, equality cases, lazy formulas and optional current-record context
  have scoped compatibility adaptations. Unicode string helpers retain upstream
  scalar semantics and regex matching remains stateless.

Status: source-only first extraction slice, no native/WASM build or runtime parity
claim until the coordinator's serialized proof. The query reducer, complete
builtin equivalence, bound accounting inside every builtin and final public API
remain under review. Do not enable consumers from this source milestone alone.

The small corpus test uses the shared accepted expectations from
`tests/fixtures/document-semantics/bases/expressions.json`, plus a few explicit
resource/host guards. It selects `proposed` values for accepted corrections. It
is not a wholesale copy of upstream's oracle or a production-parity claim.
