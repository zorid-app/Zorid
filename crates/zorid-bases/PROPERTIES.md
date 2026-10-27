# Local collection properties and Base view sources

The vault-wide `Properties.yaml` feature is retired. Existing files with that
name remain ordinary user data: Zorid must not load, create, or interpret them as
a global schema. Legacy explicit `propertyDefinitionsSource` query attachments
are unsupported. Historical tests and receipts for that feature describe the
older contract; they are not acceptance evidence for local collections.

The current product decisions are recorded in
[Types, properties, Bases and collections](../../docs/design/types-properties-sync-discussion.md).
Implementation and verification are tracked separately in
[the implementation plan](../../docs/plans/types-properties-implementation.md).
These design/tracking documents may remain on the design branch until the
coordinator integrates the reviewed local implementation.

Each Base view selects exactly one source:

```yaml
views:
  - id: g7d4n8m2r9pk
    type: table
    name: Books
    source: {kind: collection, id: h9s4b7n2p6kr}
  - id: j8m4p2s9k6nr
    type: list
    name: Notes
    source: {kind: untyped}
```

A missing source in a legacy view means untyped notes. An explicit source owns
its filters, formulas and summary definitions; root settings are inherited only
by legacy source-missing views. A source is never selected by `_type` text or by
an ordinary `type` property. Stable collection/field/option identities govern
membership and values, while readable YAML/Markdown are projections.

Untyped views browse ordinary notes and exclude collection-owned entries,
including entries awaiting collection deletion/trash publication. Their
frontmatter can participate in filtering and sorting, but the result exposes
file information rather than editable user-property columns. Open a note to
edit its ordinary frontmatter.

Collection queries use schema, ownership and typed values captured by Rust with
the document generation's authority manifest. Query fields use `note.<fieldId>`
so a display-name change does not break view references. Incompatible values
retained from an earlier datatype must not be reinterpreted under a new one.
Structured query contexts are in-process capabilities, never deserialized
client-supplied membership. Queries with a missing/deleted collection fail
explicitly; they must not fall back to unrelated notes.

`PropertyDefinitions` and its datatype/relation value representations remain
reusable Rust internals. `from_generation_source` verifies a selected source
against its exact retained indexed revision; no filename grants authority.
Ordinary host queries use empty definitions, without searching for a registry.
The fresh scoped query path bypasses optional answer/preparation caching until
the cache proof includes the structured-state revision and source membership.
Existing indexing-preview captures do not yet attest that membership. Shared
views wait for saved query results; direct unscoped preview requests fail with
`source-unavailable`. This is a deliberate availability deferral, not preview
feature acceptance.

The old relation/rollup implementation checks at `87caf89b` and composed
`9e295153` covered 91 bounded source tests on 2026-10-21. Their source/digest,
query and resource-limit observations remain historical facts. They do not prove
current collection integration, native runtime behavior, mobile support or
reference parity. Collaboration and sync remain future roadmap work.
