# Local property definitions and relationships

`Properties.yaml` is an optional normal file at the vault root. It defines value
controls by exact property name, independently of the ordinary `type` property.
It introduces no named note Type assignment or registry.

```yaml
properties:
  topics:
    type: multiselect
    options:
      - value: Rust
        color: orange
  author:
    type: relation
    relation:
      multiple: false
      targetFilter: 'type == "author"'
  books:
    type: reverseRelation
    reverseRelation:
      property: author
  bookCount:
    type: rollup
    rollup:
      relation: books
      aggregation: count
  averageRating:
    type: rollup
    rollup:
      relation: books
      property: rating
      aggregation: average
```

Notes store readable selected labels (`topics: [Rust]`) and readable wiki links
(`author: "[[Authors/Ada]]"`). Multiple relations use YAML lists. Option IDs, if
present in settings, identify configuration entries only. Renaming option values
requires a separate explicit migration; opening settings never rewrites notes.
Unknown source keys remain in the retained ordered YAML AST; invalid definitions
produce diagnostics and do not acquire guessed replacement semantics.

Configured scalar definitions override extraction guesses during reads: a text
field containing `2026-01-01` stays text, while a date field produces a typed date.
Incompatible values and unknown select options retain their original displayed
value plus a diagnostic. They are never silently turned into null or coerced.
The same interpretation feeds filters, target pickers, formulas and rollups.
Ordinary link definitions additionally accept external URLs; relation targets
remain note files. Missing properties are not materialized in source.

Relations are a deliberate Zorid addition to the Obsidian file/view model, not a
claim about shipped Obsidian features. They use the shared Rust resolver and
capture the resolved `EntryId` and revision. Those identities guard edits in the
current snapshot. App-managed renames must use the existing link-rewrite service.
External moves and path reuse follow the written link's resolver semantics: an
absent target becomes unresolved; repair can point it at another file. There is
no hidden companion identity format or promise of an immutable database foreign
key across arbitrary external changes. Deleting a target never cascades.

`PropertyDefinitions::from_generation_source` requires the exact retained root
file and verifies its source hash against the indexed revision. Derived reverse
links and rollups are sealed to that same generation. The ordinary Base query
evaluator reads the derived values before filtering, formulas, sorting, grouping
and summaries. The generation entry point with settings bypasses optional query
answer/preparation caching until its proof includes those settings explicitly.

Target pickers receive a Rust-filtered `relationTargets` map, containing only
Markdown notes with available metadata. No TypeScript target-filter evaluator
is authoritative. A relation defaults to single/all notes when settings are
omitted. Targets outside an explicit filter retain their visible link and a
diagnostic; they do not become valid reverse edges. Missing and invalid values
remain in source. Target-count, work, cancellation and output bounds fail
explicitly rather than silently returning a truncated picker list.

Target filters run against captured file metadata, scalar property definitions
and ordinary stored relation values before reverse/rollup construction. Reading
a computed reverse relation or rollup at this stage produces an explicit
unavailable-dependency diagnostic, including through `file(...)` lookups. It
does not silently treat a derived field as missing. A cycle-safe membership
pipeline for predicates on those derived fields is not implemented in this
pass. This boundary is a documented Zorid extension decision, not an Obsidian
parity claim.

Reverse properties are read-only lists of source links. A repeated relation to
the same target contributes one reverse edge and one item to a count. Rollups
support count, sum, average, min, max, values and unique. Count uses distinct
resolved targets. Numeric operations ignore missing/null related values; sum of
an empty set is zero, while average/min/max of an empty set is null. Min/max also
support homogeneous date values. Mixed or incompatible values and unresolved
relation dependencies produce visible errors. Values preserves missing/null
entries; unique preserves first occurrence order. Rollup dependency cycles are
reported and bounded. Incomplete source coverage never masquerades as a complete
reverse relation or rollup count.

## Isolated implementation verification

Owner: `bases_relations`, branch `codex/bases-relations`, worktree
`.worktrees/bases-relations`. Confirmed on 2026-10-21 through owned source
`87caf89b`, composed with summary integration `17044c7b`, `ad507231`, `fc8a8690`
and `0597ed4c` (composed checkout `9e295153`). No main integration, actual
Electron, WASM or visual acceptance is established by these results.

All commands used `CARGO_TARGET_DIR=/private/tmp/zorid-bases-target`, offline
Cargo, one build job and one test thread in the root coordinator's serialized
Rust slot. Actual results: 15 property/relationship integration checks, 13 summary
checks, 48 library checks including query/cache identity, 9 preview checks and
6 refresh checks passed (91 total). The property checks include real generation
settings/digest admission, scalar overrides, readable link identity, target
filtering, reverse/rollup evaluation in ordinary queries, missing/invalid data,
dependency cycles, dates, clock refresh, source preservation and resource bounds.

Ordinary frontmatter needs no definitions file: readable wiki links, URLs and date
text become typed values recursively, including lists and objects. Inferred note
links resolve eagerly from their owning note against the captured namespace, so
cross-file reads preserve source-relative link meaning. Explicit text definitions
retain raw text. Rows carry differential `editValues` from the same persisted
revision whenever rendering changes the raw type or content; editors must use
that source value for edits and may fall back only to unchanged primitive values.

Relation target filters are vault-wide candidate predicates. `this` is rejected
with a definition diagnostic because per-origin relation target membership has no
contract yet. This does not change ordinary Base `this` evaluation. Derived
reverse/rollup dependencies remain explicitly unavailable during candidate filtering.

Grouped note fields expose optional `editKey` values for moves and New actions.
Lists remain whole group keys. Transfer values differ from ordinary cell
`editValues`: a witnessed link becomes a vault-rooted wiki link with escaped path
characters and its original alias. The captured resolver verifies the generated
link reaches the same target revision. This intentionally uses an unambiguous
rooted path rather than Obsidian's destination-dependent shortest link spelling.
It preserves identity when a destination note is in another folder. Unresolved
relative link groups expose an unavailable diagnostic instead of a writable key.
File, formula, reverse relation and rollup groups do not gain writable note keys.
