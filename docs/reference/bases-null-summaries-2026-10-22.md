# All-null custom summary diagnosis — 2026-10-22

Addendum to [the Bases reference inventory](bases-reference.md). Owner:
`bases_summaries`, branch `codex/bases-summaries`, isolated worktree
`.worktrees/bases-summaries`. This finding requires no production change.

For `values.sum() + 1`, a group whose selected property values are all null
returns **Null**, rendered as a blank. It does not return numeric `1`, omit the
summary, or produce an evaluation diagnostic. The overall summary evaluates
its own row scope independently.

## Primary reference evidence

Installed artifact:
`/Users/ctk/Library/Application Support/obsidian/obsidian-1.14.4.asar`.
Decoded `app.js` SHA-256, reconfirmed during this diagnosis:
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Offsets below are Unicode character offsets in that decoded source.

| Scope | Observation | Provenance |
| --- | --- | --- |
| Numeric selection and sum | Selects actual numbers; no selected numbers returns the Null singleton. | `2195065..2195460`, `2197265..2198500`; REA parent `ev_63e1921ebd5e2fdae8c05ab9c8e716c8ca3f8c1d8e7bac2f5e580e3fc513ab4f`; `/private/tmp/zorid-bases-summaries-reference/provenance.json`. |
| Arithmetic | After the string-concatenation branch, either null operand returns Null. Thus null plus numeric `1` returns Null. | `2330405..2331860`; REA parent `ev_25916eacdfc2918c05fdc9dca1bf220245371115bd6442f231ec3bdabcba987e`. |
| Null rendering | The Null class has an empty rendering method. | Class starts at `2193086`; same REA parent as arithmetic. |

The latter two inert slices and exact extraction provenance are retained in
`/private/tmp/zorid-bases-summary-null-reference/`. Only a statement terminator
was appended to each slice. REA parsed both JavaScript files without parse
failures; semantic graph coverage was partial at the declared 500-total and
250-per-file node ceilings. These are focused static source observations,
not an Obsidian runtime test or a general parity claim. Recovered source is
outside the repository.

## Independent CLI confirmation of Electron journey 007

The retained actual Electron failure is
`/private/tmp/zorid-bases-heavy-20261022-007/result.json`, reported source head
`992ac56a4278a080606390116f60fbba85c9996f`, with `failure.png` alongside it.
The custom summary was saved as `values.sum() + 1` on `note.rating`.

The existing standalone release CLI queried that disposable vault after an
explicit build of its derived document index; no Rust compilation, product
edit, fixture-source edit, or harness edit was performed for this diagnosis.
Binary: `/Users/ctk/Projects/Zorid/target/s1-release/release/zorid`, SHA-256
`92870835203249518612db6003be262b5cc1b54530bbaf3d00900fbe5aa592ed`.
The command was `base-query --id 9c6ce4a5-9116-477a-9497-0b9f94b9c71f
--view 'Books table'` on the journey's disposable vault.

| Scope | Returned `note.rating` summary |
| --- | --- |
| Overall | Number `214` |
| Finished | Number `71` |
| Reading | Number `72` |
| To read | Number `73` |
| Empty, one missing-property note | Explicit `{ "type": "null" }` in the group's summary map |

The returned diagnostics array was empty. Full wire output:
`/private/tmp/zorid-bases-summary-007-query.json`; diagnosis and binary identity:
`/private/tmp/zorid-bases-summary-007-diagnosis.json`; derived-index build result:
`/private/tmp/zorid-bases-summary-007-index.json`.

Source tracing at the reported head independently confirms that the query
inserts Null into the group summary map, TypeScript preserves that value,
and the table renders it as an empty string. Journey assertions at
`journey.mjs:163–166` converted that blank through `Number('')` to `0` and
incorrectly expected `1`. The oracle must assert the blank explicitly and
retain the numeric group and overall checks. A focused Rust regression in
`crates/zorid-bases/tests/summaries.rs` covers explicit null and missing
properties together, with independent overall scope and zero diagnostics;
its execution status must be recorded separately from this diagnosis.
