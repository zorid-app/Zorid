# Document semantics reuse assessment

Source assessment completed 2026-10-16 by `browser_adapter_review`, with independent
SQLite/FTS source review by `metadata_inventory`. Current-behavior inventory used
Zorid `fbd6952`; documentation prepared against `425866d` in Orca worktree
`document-reuse-assessment`, branch `tingkai-c/document-reuse-assessment`.
No upstream code executed, dependencies installed, builds/tests run or adoption
verified. This records preparation for the [semantics milestone](../shared-document-semantics-plan.md),
not completion of the current storage/sync/recovery gate.

## Implementation follow-up (2026-10-17)

The source assessment below remains historical preparation evidence. Main426d3a6c
now uses pulldown-cmark0.13.4 plus saphyr-parser0.2.2 for portable metadata and a
narrow attributed MDBASE evaluator extraction pinned to the revision below.
Whole MDBASE storage/CEL/native dependencies were not adopted. Native and actual
browser-WASM accepted corpora pass; see `shared-document-semantics-plan.md` for
runtime provenance and remaining consumer work. Literal search currently uses
bounded retained-source scans; FTS acceleration and parallel indexing remain
future improvements, with no performance gain claimed here.

## Recommendation and scope

Reuse an established Markdown parser, evaluate SQLite FTS5 for candidate search,
and test MDBASE's existing Bases evaluator before building a custom engine.
Zorid still owns dialect decisions, stable entry/revision provenance, editor-range
conversion and coherent index publication. Keep its storage/sync authority and
source-preserving editing paths; adopting a semantic library does not authorize
replacing those systems.

## MDBASE is not synonymous with Obsidian Bases

The requested `mdbase-dev/mdbase-rs` URL returned 404. The official specification
links to **`callumalpass/mdbase-rs`**. MDBASE defines typed Markdown collections
and canonical CEL queries; an optional **Obsidian Bases adapter** evaluates a
separate source dialect. Generic CEL evaluation is not an equivalent replacement
for Zorid's Base formulas. [Official implementation links](https://github.com/mdbase-dev/mdbase-spec#implementations),
[pinned adapter specification](https://github.com/mdbase-dev/mdbase-spec/blob/2be70152c0d966d87e40d0a2ddca14de361f7a97/adapters/obsidian-bases.md).

Inspected Rust revision `2e8f47f3a0737766060599cf9534582bd75aa719` (Oct 4)
declares `0.4.0-rc.6`, Rust 1.94 and MIT. It contains an actual Bases evaluator
and public `CompiledCatalog::plan_hosted_obsidian_base` / plan record-evaluation
APIs. Host inputs carry source, path and revision; host-owned IO/snapshots make
reuse more plausible than importing its filesystem `Collection` API. The private
evaluator is not already a small standalone crate. [Manifest](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/Cargo.toml),
[view boundary](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/mod.rs),
[hosted Bases code](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/runtime/hosted_base.rs).

Its hosted contract includes provider-readable derived projections; this is not
proof of Zorid's E2EE requirements. Reused semantics must execute on authorized
clients, without adopting that hosted storage/encryption model. [Host contract](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/docs/architecture/hosted-record-source-execution.md).

The repository has a 297-case Obsidian oracle generated June 10; its test loop
skips five known divergences (unary plus and direct numeric method syntax).
No explicit Obsidian build/version field was found. These are source observations,
not passing results from this assessment. [Fixture](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/tests/fixtures/obsidian-bases-oracle.json),
[evaluator/test loop](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/expression.rs).

Concrete compatibility questions from inspected source:

| Behavior | MDBASE | Current Zorid TypeScript |
| --- | --- | --- |
| String length/reverse | Unicode scalar `chars()` | UTF-16 length/split |
| Repeated global-regex matches | Stateless matching | Stateful JS `lastIndex` |
| Group `2` and `"2"` | Canonical JSON keys distinguish them | Loose equality combines them |
| Default/tie ordering | Lexicographic path fallback | File-name/numeric locale ordering |

Evidence: MDBASE evaluator above, [sorting/grouping](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/execute.rs#L919);
Zorid `src/bases/expression.ts`, `src/bases/query.ts` and corresponding tests.
Resolve these in fixtures: current quirks are not automatically product requirements.

Whole-crate browser portability is unproven: bundled SQLite, filesystem/watch and
other native-oriented dependencies are unconditional. Disabling defaults does
not isolate the semantic engine. Inspected CI targets Linux/macOS/Windows, not
browser WASM. Prefer an upstream portable package/feature split or narrow attributed
extraction, subject to maintenance review. [Manifest](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/Cargo.toml),
[CI](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/.github/workflows/ci.yml).

Maintenance is active but pre-1.0. The rc.6 conformance claim lists no optional
features, so it does not certify the optional Bases adapter; some evidence names
an older artifact. `serde_yaml 0.9` also has archived, unmaintained upstream.
Review selected dependencies and retain license notices for any extraction.
[Conformance claim](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/conformance/v0.4.0-rc.6.yml),
[MIT license](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/LICENSE),
[Serde YAML status](https://github.com/dtolnay/serde-yaml).

## Markdown parser candidates

- **pulldown-cmark:** first extraction candidate because events plus source offsets
  fit metadata extraction. Includes task, YAML-block and wikilink options; YAML
  block recognition does not type/validate YAML. Inspected revision
  `ad1622be42b65cdf24ce41e070e516d8844436f0` (Oct 16) declares 0.13.1,
  Rust 1.71.1, MIT. Its library avoids a filesystem/database dependency boundary.
  [Manifest](https://github.com/pulldown-cmark/pulldown-cmark/blob/ad1622be42b65cdf24ce41e070e516d8844436f0/pulldown-cmark/Cargo.toml),
  [events/options](https://github.com/pulldown-cmark/pulldown-cmark/blob/ad1622be42b65cdf24ce41e070e516d8844436f0/pulldown-cmark/src/lib.rs).
- **Comrak:** compare its richer AST and task/frontmatter/wiki extensions on the
  same fixtures. Inspected revision `229fc35c6b228bd6f4d46d1a366950daf5b9d0a0`
  (Oct 16) declares 0.56.0, Rust 1.89, BSD-2-Clause with inherited notices.
  Main's OFM comments option postdates the Oct 6 release. Disable unnecessary
  CLI/highlighting defaults; source positions are not half-open UTF-16 ranges.
  [Manifest](https://github.com/kivikakk/comrak/blob/229fc35c6b228bd6f4d46d1a366950daf5b9d0a0/Cargo.toml),
  [options](https://github.com/kivikakk/comrak/blob/229fc35c6b228bd6f4d46d1a366950daf5b9d0a0/src/parser/options.rs),
  [changelog](https://github.com/kivikakk/comrak/blob/229fc35c6b228bd6f4d46d1a366950daf5b9d0a0/CHANGELOG.md),
  [license](https://github.com/kivikakk/comrak/blob/229fc35c6b228bd6f4d46d1a366950daf5b9d0a0/COPYING).

Choose one through fixtures, not both by default. Custom exclusions, tags/aliases,
task markers, malformed input, exact rewrite spans and UTF-8/UTF-16 mapping still
need adapters. Neither replaces CodeMirror live syntax or lossless property/Base
writers. Source portability is promising; actual native/WASM builds remain required.

## SQLite FTS5

Use FTS as an optional candidate accelerator, followed by shared exact evaluation.
It supplies token/phrase/prefix/proximity matching, rank/snippets and trigram
indexing, not typed properties or Base semantics. Tokenizer behavior differs from
JS; trigram full-text terms shorter than three Unicode characters do not match.
Unsupported queries need a sound fallback, never false-negative filtering.
External-content indexing requires consistency maintenance. [Official FTS5 documentation](https://www.sqlite.org/fts5.html).

Native design candidate: map disposable index rowids to stable entry/revision IDs
and coherent snapshots; verify the selected SQLite build includes FTS. Browser
storage remains IndexedDB: SQLite WASM/OPFS is a separate database requiring feed,
rebuild and cross-store snapshot coordination. Standard OPFS needs worker/SAB and
COOP/COEP; `opfs-sahpool` avoids those headers but limits simultaneous connections.
[Official persistence guide](https://www.sqlite.org/wasm/doc/trunk/persistence.md).

SQLite is public domain; official WASM has maintained releases/support. Pin and
verify an artifact rather than assuming trunk documentation matches our build.
Its omitted UTF-16 APIs do not solve editor offsets. [License](https://www.sqlite.org/copyright.html),
[WASM scope](https://www.sqlite.org/wasm/doc/trunk/about.md),
[WASM releases/support](https://www.sqlite.org/wasm/doc/trunk/index.md).

## Acceptance before adoption or custom replacement

After the existing implementation gate, compare native/WASM results on shared
fixtures: malformed YAML/Markdown, Unicode/source spans, links/tasks, formulas,
null/date/timezone/coercion rules, sorting/grouping, revision-aware rebuilds and
resource limits. Record intentional corrections to existing behavior, dependency
licenses, browser package boundaries and measured memory/latency. Prefer reusable
components; document concrete fixture/capability gaps before authorizing a custom
parser or formula engine. No candidate has yet passed this Zorid acceptance.
