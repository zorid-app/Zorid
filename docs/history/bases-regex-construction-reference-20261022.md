# Bases regex literal construction reference — 2026-10-22

Obsidian 1.14.4 constructs regex literals while building the complete expression,
before selecting a lowercase `if` branch. A native regex-constructor failure in
an untaken argument invalidates the whole expression. It does not become an
ignored error node inside that argument. This is a construction-phase finding;
the replay below does **not** run the shipped grammar or the Obsidian app.

## Primary artifact and static evidence

The installed reference's retained decoded `app.js` is
`/private/tmp/zorid-obsidian-reference-20261021/1.14.4-app.js`, SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Focused inert excerpts and their original ranges/hashes are recorded in
`/private/tmp/zorid-bases-regex-parse-reference-20261022/provenance.json`.
The original source and all recovered excerpts remain outside the repository.

REA parent evidence:
`ev_e46843415bf4adb1111271ccd2759210909118e8a574ef2f1642828091f8288d`.
Summary: `ev_355572c3ace8f04dc4f3f5b7d849ec97ec79fdbc8d9e332f941efd11214378af`.
REA parsed seven inert JavaScript files, visiting 2,448 AST nodes with zero parse
failures. Its semantic graph is partial under ceilings of 250 total and 100
per-file nodes; unresolved external identifiers remain. It did not execute the
bundle or establish runtime/UI behavior.

Ranges below are decoded Unicode character offsets, end-exclusive.

| Shipped component | Range | Observed source behavior |
| --- | --- | --- |
| `EQ` parse-tree conversion | 2324892–2327207 | A RegExp token becomes pattern/flags data split at its last slash; this conversion does not validate the regex. |
| `MQ.parse` and recursive dispatch | 2327211–2328348 | One try/catch surrounds both grammar parsing and recursive expression construction. A construction throw replaces the entire expression with `SQ`, retaining the original expression text and error message. |
| `IQ` call construction/evaluation | 2332505–2336202 | Construction recursively converts every argument. Lowercase `if` chooses its argument lazily only later, during evaluation. |
| `BQ` regex expression | 2338632–2338870 | Recursive construction calls the native RegExp constructor immediately and retains its wrapped value. Evaluation returns that retained value. |
| `SQ` invalid expression | 2328348–2328732 | Retains `parseError`, exposes an error message, evaluates to Null, and tests false. |
| `mQ` formula wrapper | 2323391–2323673 | Constructs its expression immediately. Its evaluation catch wraps runtime throws as Error values; it does not turn an already-invalid `SQ` into a branch-local exception. |

Thus the reference does not return the valid alternative from a construction-
invalid expression. At this layer it retains a whole-expression parse error and
evaluates Null. How each surrounding UI or query consumer displays that error
was not observed in this investigation.

## Bounded constructor replay

The standalone replay is retained separately at
`/private/tmp/zorid-bases-regex-parse-replay-20261022/constructor-replay.cjs`.
Its result is `constructor-replay-result.json` in that directory, SHA-256
`c8f82ef59d0640321faa8ef0adce568bbbb7129383cedb942dfaefe4a478c506`;
`finding.json` links the evidence and records script/result hashes and limits.

The replay loads the six original constructor/wrapper excerpts into an isolated
Node 26.10.0 VM, using analyst inheritance/primitive-value shims and a supplied
parsed AST in place of the shipped `bQ` grammar. It exercises the native RegExp
constructor but never matches input strings. There is no application bootstrap,
vault access, Electron launch or native build. Native error wording can differ
from the installed Electron engine.

| Supplied AST, shown as an expression | Whole-expression kind | Retained construction error | Evaluated value |
| --- | --- | --- | --- |
| `if(false, /(/, 1)` | invalid | Unterminated group | Null |
| `if(false, /a/ii, 1)` | invalid | Duplicate/invalid flags | Null |
| `if(false, /a/, 1)` | function | None | 1 |

These observations confirm the constructor/catch boundary for supplied ASTs.
They do not independently prove how the shipped lexer accepts each literal's
surface syntax, nor establish a full-app result for these expressions.

## Zorid gap and admission considerations

At inspected source `8c2d4c35415af635b2ce61fc56a3bd408bbbe733`,
[Parser::prefix](../../crates/zorid-bases/src/expression.rs) retains regex
pattern/flags and a literal identity without validation. `evaluate_inner`
validates and compiles only when it encounters the selected regex node. An
untaken branch can consequently hide malformed regex syntax. This is a real
phase gap, separate from the documented D6 restriction on valid JavaScript
features unsupported by the portable regex engine. This record does not claim
the gap is fixed or accepted.

The proposed correction is a checked, complete-AST literal admission pass before
lazy evaluation. It must charge traversal and pattern/flag work, check
cancellation, enforce existing byte/compiler limits, and preserve literal
identity. Formula preparation, summaries, direct evaluation and semantic
validation/zero-row paths need consistent coverage. A bare compiler call added
to `Parser::prefix` would also affect dependency-only parsing and could allocate
or populate regex caches outside invocation admission; that shortcut has not
been approved here.

Malformed supported syntax, such as an unclosed group or duplicate flag, must
not disappear behind branch selection. Valid JavaScript lookaround or
backreferences can also produce the Rust regex crate's Syntax errors, so that
error category alone cannot classify a literal as invalid JavaScript. Preserve
explicit D6 unsupported-feature diagnostics and test them separately. Required
verification includes untaken malformed literals, valid untaken literals,
semantic validation without returned rows, and budget/cancellation boundaries.
No implementation or product test was performed by this reference task.
