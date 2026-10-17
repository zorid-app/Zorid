# Portable derived index: source slice

Local source/index/version identities, namespace witnesses, publication-CAS
preconditions, deterministic link resolution, immutable derived generation
records and revision-bound paged literal evaluation. This is source preparation;
there is no native/IDB persistence adapter or consumer migration yet.

Generation rows contain typed zorid-document facts and SHA256/length references,
never retained source bodies. Hosts retain/stage the exact bounded read as an
immutable generation text projection (or pin its immutable source) alongside
the corresponding row; do not defer this until querying current authority. Extraction binds strong entry/revision IDs, metadata
schema+dialect, exact byte/UTF16 lengths and raw committed source digest. Invalid
frontmatter remains current metadata with diagnostics. Complete generation
preparation requires a row or explicit exclusion for every active file.

Hosts must atomically compare source/index heads and publish generation rows/head
in their existing shared storage. Prepared-generation inspection/fence success
is NOT a durable commit. No filesystem, database, network, clock or daemon is
implemented here; discarded/corrupt derived facts must never rewrite source.

The frozen pump has32 documents and a SOFT1MiB source/output budget. One document
up to the shared16MiB MAX_SOURCE_BYTES can exceed the soft budget when otherwise
empty. Larger source gets an explicit terminal coverage exclusion, never a
no-progress retry. The HARD64MiB aggregate fact guard returns GenerationLimit;
keep the old coherent generation, do not advance watermark or silently omit rows.
This limits this initial owned-generation engine, not source storage. Root-owned
paged persistence can handle larger fact sets later.

LiteralPageBuilder requests one generation-bound text row at a time. The async
host reads that retained projection, then accept() verifies its SHA256/length.
It never substitutes current-authority text or accepts a whole vault of bodies.
One bounded16MiB row is permitted on an otherwise empty page. Hits use the shared
SourceRange byte/UTF16 type, exact case-sensitive literal matching and one match
per LF-delimited line (CRLF is excluded from line text, matching existing CLI).
Sorting is original UTF8path/entryID/hit position. Page output is bounded1MiB and
1000hits; scan completion and index coverage are separate. Explicit coverage
failure can finish with no continuation token; clients must not retry forever.

Snapshot IDs bind local store, host-CSPRNG generation epoch, counter and semantic
versions. Epochs must never be reused after discard/rebuild/restart. Tokens bind
that full identity, exact query and scan position; wrong/expired identity errors
rather than selecting the current generation. Fact/query versions invalidate
independently; extraction tag includes both document schema and dialect.

Resolver consumes Link.destination from the established parser: Markdown
entities/escapes are normalized upstream, percent encoding remains; wiki target
and fragment retain raw spelling. It splits literal fragments BEFORE strict
percent decoding. No replacement Markdown URL parser exists here.

Executable source includes17 resolver cases,6 publication cases and generation/
literal fixtures for page identity, tampered bodies, stale heads, invalid YAML,
UTF8/UTF16 ranges, fresh-epoch expiry,2MiB soft-budget progress and terminal source
limits. rustfmt/diff checks pass. No crate compilation/tests have run yet; root
owns the sole serialized verification slot and root Cargo.lock resolution.

Validated persistence seam: IndexRecord::from_persisted accepts a manifest-bound
EntryWitness, optional typed metadata, SHA256/length and explicit exclusion. It
checks exclusive text/exclusion states, source IDs/revision, schema/dialect,
lengths/ranges, typed property safety and resource bounds WITHOUT parsing source
or doing IO. The adapter bounds serialized input before decode, validates its
own persisted manifest/fence envelope, and reconstructs GenerationBuilder outside
transactions. Restoring is not authentication of source bytes; query reads still
verify the retained projection digest. MetadataRequest is reexported for adapters.

NUL-bearing files remain excluded as Binary, matching existing CLI semantics.
The page reserve covers worst-case six-byte JSON escaping of a4096-byte query
plus bounded snapshot/version identity. A control-query near-full page regression
and NUL/validated-cache restoration fixtures cover the reviewed edge cases.

Shared host seams now include canonical validated serde for source/index IDs,
`PersistedIndexRecord::of(row).restore(manifest.witness(id)?)`, safe Arc-owned
literal page state, and a Serialize-only relationship snapshot created from an
actual immutable generation. Its bounded occurrence query pins full snapshot,
entry and direction; its private namespace supplies the same resolver to Base
functions. Serialized graph reports are never deserialized as authority.

`Generation::from_sources` is a convenience fixture/small import factory capped
at 32 inventory entries and 16MiB aggregate source, requiring one typed source or
explicit exclusion per file. Hosts must bound transport bytes before decode.
Production hosts retain incremental pumps; this is not a whole-vault import or
publication API. Cache restore checks recoverable structural/range and expanded
string/key budgets, but cannot authenticate source facts or reconstruct original
YAML alias/other scalar spelling budgets without source provenance.
