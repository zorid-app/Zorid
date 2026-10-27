# Types, properties, Bases and collections — design decisions

Date: 2026-10-27
Status: local product decisions recorded; implementation stopped for discussion.
Current authorization: update documentation and implementation tracking only.

This records agreed product behavior, its rationale and remaining engineering
questions. It does not describe what Zorid already implements. Read the current
scope below before the retained future-sync discussion in sections 7–8.

The user narrowed delivery to **local use** and then explicitly stopped product
implementation to discuss behavior first. This documentation request does not
resume that work. Collaboration, CRDT implementation and encrypted-sync changes
are deferred. Their requirements belong in the [product roadmap](../roadmap.md#future-collection-collaboration-and-sync).

Resume and handoff record: [implementation tracker](../plans/types-properties-implementation.md).
It separates product decisions, source implementation, review, integration and
runtime verification. The current source/ownership checkpoint must be reconciled
before a future implementation pass.

## 1. Local product model and user flow

### Bases contain independently sourced views

| Term | Agreed meaning |
| --- | --- |
| Base | A saved container of views; it does not own entries or a shared source/filter. |
| View | One source plus its own layout, filters, sorting, grouping and display configuration. |
| Collection / database | An owning set of entries with collection-specific property definitions. |
| Type definition | The internal schema for a collection, created with that collection. |
| Datatype | The behavior of one property, such as Text, Number, Select or Status. |
| Entry | A note created within, and owned by, one collection. |
| Untyped note | An ordinary note outside all collections. |

Each view selects **exactly one collection/type**, or **untyped vault notes**.
It cannot combine collections, combine typed and untyped notes, or select all
types. A Base can contain a Books cards view, a Projects table view and an
untyped Ideas list view; their sources and configurations are independent.
Multiple views in the same or different Bases can display the same collection.
Those views edit the same entries, not copies. Filters control visibility,
not membership. Identical field names in two collections never imply identity.

This supersedes the original proposal that a Base and a database are the same
thing, that every view in a Base shares its source, or that a view can combine
multiple types. It also supersedes the older roadmap's product decision to
remove named Types. It does not establish an implemented migration of old Bases.
The existing `type` frontmatter key remains ordinary user data; managed `_type`
is separate and is not inferred from a field called `type`.

### Create Base / Add view

1. Run **Create Base** or choose **New Base**, then name it.
2. Configure the first view using a simple onboarding choice:
   **Notes in your vault** or **A collection of things**.
3. For vault notes, select the untyped source and optionally narrow it with
   folders, tags, content or existing frontmatter filters. Open the browsing view.
4. For a collection, choose **Create a collection** or **Use an existing
   collection**. A new collection asks for its name and Blank/preset choice;
   creation supplies its internal type automatically and opens its initial view.
5. Configure collection properties directly through column headers and the add
   property control. No separate technical type setup is required.
6. **Add view** repeats source selection. Select a layout and configure that
   view without changing sibling views or the source collection's membership.

Use Notion's UI and interactions as the close design reference: direct table
entry, column property configuration, view tabs, menus and note opening.
This is a Zorid implementation, not authorization to copy proprietary artifacts
into source or a claim of exact Notion parity. Collection layouts use the existing
Table, Board, List and Cards foundation where suitable. A linked view elsewhere
references the same collection; its display/filter configuration stays independent.
Retain the existing Markdown writing experience and split-pane note opening.

Collection presets create independent collections, not one global Tasks/Books
bucket. The exact first-release preset/datatype inventory remains to be scoped.
Calendar, provider integrations and a block-editor rewrite are outside this pass.

### Untyped views are browsing only

The user identified browsing as the only intended untyped-view use case.

- Show note titles, with optional previews and file information such as folder
  and modified time. Support filtering and sorting.
- Existing frontmatter values can participate in filters; this does not expose
  them as property columns or establish a shared schema.
- Provide no user-property columns, property configuration, inline property-cell
  editing or add-property flow. The rejected per-cell datatype inference and
  untyped property-column rename questions are obsolete.
- Open a result in the normal note editor. Its frontmatter remains editable in
  the note; browsing does not assign a collection/type.
- New creates an ordinary note immediately. Straightforward filter-derived
  initial values may be applied; exact folder-selection precedence remains an
  engineering contract to settle. No new-entry questionnaire is introduced.

### Remove the vault-wide Properties.yaml feature

The user explicitly requires complete retirement of the special `Properties.yaml`
registry (including the lowercase spelling used conversationally). Collection
properties belong to their collection, not a vault-wide property-name registry.
Remove automatic discovery, creation, reads, writes, watchers, query admission
requirements and settings flows for this registry across clients and Rust hosts.
Renaming or hiding the same global registry does not satisfy the request.

This authorizes retiring the feature, not silently deleting an existing user's
physical file or bulk-converting its notes. An existing file remains ordinary
vault content; any legacy-data transition requires its own safe contract.
No replacement vault-global registry is part of the design.

### Membership, deletion and removed proposals

Entries are created within their collection and cannot move between collections.
There is **no import-existing-notes flow**, exact-name field import, field mapping
screen or cross-collection migration. Earlier proposals to match field names and
discard other fields were subsequently withdrawn when the user rejected import.
Changing a note's folder does not itself change collection ownership.

Delete Base removes its views. Delete view removes that view. Neither deletes
collections or entries. Delete collection removes its definition and all member
entries, including those hidden by current filters, through recoverable Trash.
There is no keep-as-ordinary-notes conversion. The exact handling of a hypothetical
individual "remove membership" action is still open; do not introduce it as a
backdoor move/import path.

### Defined edge cases

The table distinguishes explicit choices and defaults accepted by the user's
"ok sounds good" response to the edge-case recommendations. Later specific
steering above takes precedence. Unresolved details are in section 13.

| ID | Situation | Agreed behavior |
| --- | --- | --- |
| E01 | New in a filtered view | Create immediately without extra questions. Derive matching initial values where possible; the user can edit afterward. |
| E02 | OR, multiple choices, unsupported or contradictory filters | Use automatic defaults where feasible. New is not blocked and does not promise that every filter can be satisfied. Exact branch/value selection needs a deterministic implementation contract. |
| E03 | An edit makes an entry fail the view filter | Hide it from that view; retain it in its collection. An already-open note editor remains open. |
| E04 | Saving that edit fails | Preserve the draft/error and editing surface; do not acknowledge removal as a successfully saved change. |
| E05 | Several views show an entry | All refer to the same entry. Changing its properties updates affected views; membership is unchanged. |
| E06 | New ordinary note in an untyped view | Create an untyped note, apply feasible filter-derived values, open its editor; no property-grid or import flow. |
| E07 | Duplicate a collection entry | Create a new note identity in the same collection, copying body and property values. This is not a move to another collection. |
| E08 | Rename a collection, field or option | Preserve stable identity, values and references; update readable representations. |
| E09 | Duplicate names | Prevent duplicate collection names, field names within a collection and option labels within a field. Base/view names may repeat. Filename case/escaping rules still need specification. |
| E10 | Delete a field or option that has values | Confirm affected-entry count. Remove the field's active values or clear selections of the deleted option; retain recoverable history. Exact undo/restore scope remains to be specified. |
| E11 | Change datatype | Convert compatible values. Preserve incompatible values until explicitly corrected or cleared; do not silently reinterpret them. Compatibility/conversion rules need specification. |
| E12 | Change a view's source | Preserve its name and layout; reset source-specific columns, filters, sorting and grouping. Do not move entries. |
| E13 | Delete the last view/Base | Keep the collection accessible through collection browsing/selection. A Base with no views offers Add a view. |
| E14 | Delete collection | Trash definition and all owned entries; no keep-notes conversion. Unrelated notes merely selected by other queries are unaffected. |
| E15 | View references deleted collection | Show Collection deleted, with Restore or Change source. Never broaden to other notes automatically. |
| E16 | Restore collection | Restore definition, membership and its deleted entries together. Preserve occupying files through alternative filenames. Detailed partial-restore/repeated-delete behavior remains open. |
| E17 | Move a member file between folders | Retain collection membership and identity. Collection entries remain Markdown files visible in the vault explorer. |
| E18 | External property/body edit | Accept valid, unambiguous value changes against a known baseline; preserve invalid or unknown input for repair. Never infer a schema rename from a note key edit. |
| E19 | External `_type` edit | Does not move collection membership. Treat as a projection mismatch to reconcile, not an assignment command. |
| E20 | Missing/changed/duplicated `_id` or external file copy | Preserve data and prevent unrelated notes from merging. Admission, repair and new-identity allocation rules remain open; in-app Duplicate follows E07. |

### Observed Notion filter behavior — bounded reference evidence

On 2026-10-27 this session used the user's Chrome tab through UI automation and
created a separate [Zorid filter behavior test database](https://app.notion.com/p/ctk0/4066b82aa66780f58b26ea8783f550d1).
These are observations, not evidence of Zorid behavior or a full Notion algorithm:

| Test | Observed result |
| --- | --- |
| Status is Complete (Done was its available option) → New | New entry inherited Done. |
| Change that entry to Not started | Row disappeared; clearing filters later revealed the retained entry. |
| Status allows In progress or Done → New | Chose Done without asking. |
| Name contains OR marker OR Rating = 4, with the Status filter also active | Set title to OR marker, left Rating empty and assigned Done. |
| Rating > 4, with the Status filter also active → New | Assigned Rating 5 and Done. |
| Rating > 4 AND Rating < 4, with the Status filter also active → New | Created/opened an entry with Rating 5 and Done, but the filtered table excluded it. |

After clearing the test conditions and reloading, all five entries were visible.
No exact first-option/first-branch algorithm, formula/date/group behavior, Notion
membership restriction or Notion deletion behavior was established by this pass.
The user then accepted automatic creation without extra questions and allowing
subsequent edits; suggestions to prompt for ambiguous filters or disable New for
impossible filters were withdrawn. The database was retained for inspection.

## 2. Types and datatypes are different

A datatype describes the behavior of one property. A type definition describes
the fields of an entire database and any relevant built-in behavior.

Examples of datatypes discussed:

- Text, Number, Checkbox, Date and Date/time.
- Select, Multi-select and Status.
- URL, Email, Phone and other specialized values.
- Relations and files/media references.
- Formula and Rollup, which compute results rather than store independent values.

The Notion menu was inspiration for an extensible property system, not a promise
that every datatype will ship in the first iteration. Buttons are actions, and
created/edited metadata comes from the system; neither should be treated blindly
as another user-entered scalar.

Select and Status differ. Select offers configured choices. Status additionally
maps choices to semantic categories such as `not_started`, `working` and `done`,
so task behavior can understand completion without depending on an option's label.

For example, a Tasks preset could supply Status, Planned date and Deadline, with
explicit mappings identifying which fields have those meanings. The label
"Status" alone does not grant task behavior.

## 3. Why we need stable identities

Names are editable; identity must survive renames.

If a field changes from **Status** to **Progress**, its values, formulas, relations
and views must continue referencing the same field. Likewise, changing the label
**Started** to **In progress** must not create a new select option.

We decided to use immutable IDs internally and separate them from display names.
Users edit the display names. IDs are generated automatically.

The chosen schema ID format is **12 random characters from `0–9` and `a–z`**:

```text
k7m2px9a4v6c
```

Uniform generation provides `log2(36^12) ≈ 62.04` bits of randomness, with
4,738,381,338,321,616,896 possible strings. Use secure random generation without
character-selection bias, check for collisions, and never deliberately reuse a
deleted identity.

Field IDs are scoped to their type; option IDs are scoped to their field.
References need the relevant parent context. Unrelated databases having equal
field-ID strings does not identify the fields as the same object.

We also explored UUIDs, six-character IDs, name-prefixed IDs and word/passphrase
IDs. The user chose ordinary random IDs instead. This does not require replacing
the existing core's file IDs or using the same format for CRDT actors and updates.
The relationship between the Markdown `_id` and existing core entry identity still
needs an implementation decision; examples are not a migration instruction.

Collisions during offline multiplayer need explicit handling before rollout.
Randomness makes collisions unlikely, not impossible; unrelated fields must never
silently merge because a short ID happened to match.

## 4. Where the type definition lives

Each vault has a hidden Zorid folder. Readable type definitions belong at:

```text
My vault/
  .zorid/
    types/
      Work tasks.yaml
      Projects.yaml
      Books.yaml
  Work tasks/
    Prepare presentation.md
```

The user explicitly chose **the type's name as its filename**, rather than an
ID-based filename. The file can contain the stable type ID, so identity does not
depend on the filename. Type renames update the name and corresponding filename.

The definition describes the database name, fields, datatypes, options, defaults
and optional capabilities. An illustrative readable representation is:

```yaml
version: 1
id: p4n8cx2v7m9q
name: Work tasks

properties:
  - id: k7m2px9a4v6c
    name: Status
    datatype: status
    default: b2w6jt8q3n5r
    options:
      - id: b2w6jt8q3n5r
        name: None
        category: not_started
      - id: h8q3nv5m2x7c
        name: Started
        category: working
      - id: r6w9pa4k8t2n
        name: Done
        category: done

  - id: r9q2mf6k8v4x
    name: Deadline
    datatype: date

capabilities:
  task:
    status: k7m2px9a4v6c
    deadline: r9q2mf6k8v4x
```

The shape is an example, not a frozen schema. Authoritative schemas are structured
state; YAML is their readable representation, not a second independent authority.
The current delivery is local. Collaborative schema state is future roadmap work.

We have not frozen the local structured-state persistence contract or the future
collaborative binary format. The existing core reserves root `.zorid` for internal
storage, so definitions there need deliberate support, not an ordinary file API
bypass. Platform-safe names, case collisions and concurrent type filename renames
also require concrete rules.

## 5. What the actual Markdown file contains

We explored putting field and option IDs directly in frontmatter:

```yaml
k7m2px9a4v6c: h8q3nv5m2x7c
```

Although that preserves identity directly, it makes files difficult to understand
when opened in another editor. We also considered embedding ID/name pairs beside
every value, which is more readable but verbose.

The final preference was **readable frontmatter with hidden identity state**:

```markdown
---
_id: m8v2q7r4n9cx
_type: Work tasks
status: Started
estimate: 3
deadline: 2026-10-30
labels:
  - Design
  - Frontend
---

# Prepare presentation

Outline and supporting notes…
```

Specific choices:

- The reserved identity property is `_id`, not `_zorid_id`.
- Include `_type` as the readable database/type name, such as `Work tasks`.
  This later user-confirmed choice replaces the earlier decision to omit it:
  the rejected representation was an opaque type ID in frontmatter.
- `_id` and `_type` are reserved Zorid-managed properties. The underscore
  distinguishes them from ordinary fields, leaving `type` available for user data.
- Do not put field IDs or option IDs into ordinary readable property values.
- Store database membership and field/option associations in hidden structured
  state, connected to the note's `_id`.
- Multi-select is a YAML list. An empty selection can be represented as `[]`.
- Note bodies remain ordinary Markdown.

`_type` is a readable membership projection, not the authoritative identity.
Hidden state still references the stable database ID. A database rename updates
the projected name; duplicate names do not merge membership. An external `_type`
edit does not change membership; cross-collection moves and note import are outside
the agreed product. Exact mismatch-repair handling remains open alongside the
other external-edit reconciliation rules below.

The exact mapping from display names to emitted YAML keys is not finalized.
The examples use simple lowercase keys. We must not introduce a second immutable
storage-key system without review: that earlier proposal was rejected as confusing.

Two fields may acquire the same display name through concurrent edits. Two options
may also share labels. Plain YAML keys/labels cannot faithfully encode every such
case without a policy. We need collision/escaping rules that preserve distinct
internal identities and values; this conversation has not chosen those rules.

## 6. Authority: structured properties, readable projection

Database properties use **structured typed state**, projected to readable YAML.
The earlier collaboration direction was structured CRDT data rather than a CRDT
over a YAML string. Implementing CRDTs is now deferred; it is not a prerequisite
for the local feature. Local transactions, revision guards and safe publication
still need a concrete contract.

Conceptually, the authoritative entry state contains:

```text
entry identity
database identity
field ID -> typed value
```

Select/status values reference option IDs internally. Multi-select values track
option identities. Other values retain their actual datatypes.

The visible YAML is generated from that state and current schema labels. It is a
**projection**, not another independent authority.

| Data | Proposed authority |
| --- | --- |
| Database schema, labels and options | Durable structured local schema state; collaboration deferred |
| Entry membership and database properties | Durable structured local entry state; collaboration deferred |
| Note body | Existing document/save model; no new live text collaboration cutover |
| Readable frontmatter and type YAML | Representations generated from authoritative state |
| Query indexes and computed results | Derived and rebuildable |

This split is a proposal requiring reconciliation with current whole-document
save/sync behavior. A body save must not overwrite newer generated properties.
We have not chosen separate body replication versus a filtered/composed document
representation. There must be one coherent owner for composition before cutover.

### Why not merge YAML characters?

A text CRDT guarantees convergence of character edits, not schema-valid field
values or intended set operations. Concurrent changes can produce duplicate keys,
invalid select values, or text that loses a field's association during a rename.
Repairing that afterwards requires additional deterministic semantics.

Structured operations express the intended action directly: assign a field,
select an option, remove an option or rename a field. YAML remains useful for
readability without becoming the collaboration algorithm.

## 7. Future multiplayer requirements — deferred

The user explicitly rejected concurrent rename-choice prompts such as:
"Current: Stage / Alternative: Progress — which should we keep?"

**There should be one automatic result on every client.** This does not prevent
retaining history, nor mean silent deletion of data that cannot be interpreted.

| Concurrent actions | Intended behavior |
| --- | --- |
| Edit different fields | Keep both changes. |
| Rename a field and edit its value | Keep both; field identity connects them. |
| Rename a field and add an option | Keep both changes. |
| Rename the same field differently | Choose one label deterministically, without a prompt. |
| Assign different scalar values to the same field | Choose one value deterministically. |
| Add different multi-select options | Keep both selections. |

A causally later assignment should supersede an earlier assignment. Concurrent
assignments need a stable, specified tie-breaker. Device wall-clock time alone is
not sufficient. The exact mapping to the selected CRDT library remains to prove;
we have not selected a custom Lamport-register implementation or asserted that a
generic Yrs map supplies every desired domain rule automatically.

Multi-select should merge set operations by option identity, not replace the
entire YAML list. **Add-wins for truly concurrent add/remove was suggested, but
not finally selected.** A removal made after observing an addition must be able
to remove it.

Deletion, concurrent reordering, datatype changes and old-client writes also need
explicit rules. CRDT convergence alone does not guarantee a valid schema. In
particular, a value authored for an old datatype must not silently be reinterpreted
under a new datatype. Migration/version binding and preservation need design work.

## 8. Future sync integration — deferred

This section describes future transport requirements, not the current delivery
pipeline. The local path is validated Rust operation → durable local commit and
pending projection → guarded readable publication → refreshed views/indexes.
It must work without creating or enrolling a sync group.

Database properties are managed through Zorid's UI, CLI or API. Agents should use
those supported operations rather than editing managed frontmatter directly.
All entry points share core validation and identity semantics.

```text
User or agent operation
        ↓
Rust validation + structured CRDT change
        ↓
Durable local commit and outgoing sync work
        ↓
Existing encrypted sync infrastructure
        ↓
Other clients persist and merge
        ↓
Views, indexes and readable representations update
```

We chose to extend Zorid's existing shared Rust/encrypted-sync foundation, not
create a database-specific sync engine or replace it wholesale with MDBASE.

Local editing should work offline. Local durability, file publication and remote
delivery are distinct outcomes. Retries preserve operation identity and must not
create duplicate changes after an uncertain result.

Generated frontmatter/type YAML must not also circulate as independent authored
text mutations. That would create competing authorities and echo loops. Their
transport/materialization treatment needs an explicit contract using the existing
core; merely excluding every Markdown file from sync is not the intended solution.

Schema and entry updates may arrive in different orders. Unknown schema/option
references must remain retained and resolvable when dependencies arrive, rather
than being discarded. Unknown protocol versions or invalid writes require bounded,
safe admission rather than unrestricted raw CRDT updates from clients.

Formula and rollup results are computed from source state. We do not independently
sync them as if they were authoritative user-entered values.

## 9. Files, external edits and recovery

Asking users and agents not to edit frontmatter is a product contract, not a
guarantee that external changes will never happen.

The direction discussed was to compare external edits with the last reconciled
projection and schema, reconcile unambiguous supported value changes as validated local
operations (future collaborative operations when sync is implemented), and preserve ambiguous or invalid input without guessing.

| External action | Intended boundary |
| --- | --- |
| Edit the Markdown body | Preserve normal external text editing. |
| Change a known number/date/boolean value | Eligible for validated value reconciliation against a known baseline. |
| Change a select label | Reconcile only if the corresponding option is unambiguous. |
| Replace `status` with `progress` | Do not infer a database-wide field rename. |
| Add an unknown property | Preserve it; do not silently discard it. |
| Remove/change `_id` or duplicate the file | Do not silently bind unrelated content to an existing entry. |

These concern edits to existing files, not the rejected import-notes-into-a-
collection feature. They are intended boundaries, not a complete reconciliation
algorithm. An
external edit must not blindly overwrite newer structured state: its observation
baseline and causal relationship matter. Recognizing older labels after renames,
name reuse, removal semantics and recovery presentation remain open.

Structured state and a physical Markdown file cannot be assumed to commit in one
filesystem transaction. The proposed recovery shape is:

1. Durably commit the structured change and pending projection work.
2. Generate a consistent readable representation.
3. Revalidate the current file/body and external-edit baseline.
4. Publish safely through existing storage protections.
5. Record completion; retry unfinished work after interruption.

Projection must preserve the body and unrelated frontmatter. A stale pending
projection must not overwrite a newer file. Unknown input must be retained before
any recovery replacement. Existing native identity/publication protections must
remain intact rather than being bypassed by a new serializer.

Hidden structured state (and future CRDT state) is **necessary data**, not a disposable index. A complete backup
or supported vault transfer includes it along with readable files and definitions.
Copying only `.md` files preserves readable content but not necessarily database
membership or collaborative identity/history. We want a readable export and a
defined restore/transfer recovery path, but have not designed its exact format.
This does not reintroduce importing ordinary notes into collections.

## 10. Keeping the text editor

We explored a block-based rewrite and decided it is not required for this vision.

- Text collaboration can support per-client undo and persistent relative comment
  anchors; those features do not inherently require paragraph blocks.
- Stable blocks help identity-preserving paragraph moves, reusable sections and
  independently managed content, but still require correct collaboration rules.
- Databases and external integrations do not require a block-based note body.
- Rich embeds can be structured components within the existing editor direction.

The current writing foundation should remain. This discussion does not authorize
new block infrastructure, comment implementation or a live-editor sync cutover.

## 11. Future compatibility, without expanding this implementation

Keeping the text editor does not prevent later Google Drive integration, media
viewers, agent tools or databases referencing non-Markdown resources.

Those capabilities belong around the editor: resource identity, provider access,
permissions, indexing and format-specific viewers. They do not require every
resource to become a Markdown note or every paragraph to become a block.

The user explicitly said this was too far ahead to design now. Do not turn this
compatibility statement into an approved universal-resource framework or provider
API. Credentials and provider permissions remain separate from ordinary synced
properties; access to a vault must not implicitly grant private external access.

## 12. MDBASE: what we took from the comparison

We chose Zorid's own contracts and existing core/sync architecture while allowing
selective reuse of suitable MDBASE ideas/code, subject to license/provenance review.
"Own architecture" does not mean implementing every component from scratch.

MDBASE demonstrates readable Markdown plus hidden record identity. Its sync docs
describe UUIDv7 record identities outside frontmatter. Its contracts explain how
local named fields map to application meanings. Its newer SDK overview advertises
field-level merging while retaining losing concurrent values as reviewable
conflicts. Its older Connect docs describe revision conflicts and explicit
resolution. The newer SDK overview is marked not published on npm.

We did not verify that it provides automatic identity-preserving concurrent schema
renames, nor run its implementation. Its examples are not evidence that Zorid can
remove stable field identities without losing our desired rename guarantees.

Sources consulted during the discussion:

- [MDBASE specification](https://mdbase.dev/spec/)
- [MDBASE contracts and field mappings](https://mdbase.dev/contracts/)
- [MDBASE newer SDK overview](https://mdbase.dev/sdk/)
- [MDBASE Connect sync architecture](https://github.com/mdbase-dev/mdbase-connect/blob/main/docs/sync.md)
- [MDBASE older offline-sync API](https://mdbase.dev/sdk/offline-sync/)
- [Yjs selective undo](https://docs.yjs.dev/api/undo-manager)
- [Yjs relative positions](https://docs.yjs.dev/api/relative-positions)
- [Google Docs structured document model](https://developers.google.com/workspace/docs/api/concepts/structure)

These are reference observations from the conversation, not pinned dependencies,
full audits, or verification of production behavior.

## 13. Remaining contracts before the relevant implementation batch

The product model and defined edge cases in section 1 are settled enough to track.
These engineering details remain open; do not silently replace them with the
paused workers' tentative APIs or assistant recommendations:

1. **Identity/storage:** `_id` versus existing core EntryId, duplicate/missing ID
   repair, local authority format, schema versions, restore/export completeness.
2. **Existing product transition:** old `.base` source/filter configuration moving
   to per-view configuration; retiring special Properties.yaml behavior while
   preserving ordinary files and existing note data. Reconcile active roadmap,
   glossary and old implementation plans through the main integration owner.
3. **Projection/composition:** body/editor saves versus generated properties,
   durable pending work, stale source/external edits, safe `.zorid/types` access
   and readable key mapping without a second immutable key system.
4. **New defaults:** exact deterministic OR/option precedence, template/default/
   filter precedence, numeric/date/text derivation, unsupported/contradictory
   predicates and untyped folder selection. Preserve E01–E02: no questionnaire
   or disabled New merely because synthesis cannot satisfy a filter.
5. **Lifecycle/recovery:** batch delete/restore and partial failure, history/undo
   retention, independently trashed or subsequently edited members, property and
   option deletion recovery, compatible datatype conversions, filename collisions.
6. **UI scope:** first datatypes/presets/layouts, untyped grouping/display choices,
   source-change reset acknowledgement, collection management/discoverability,
   focus behavior when a row disappears. No untyped property-grid work.
7. **Membership boundary:** no cross-collection move or ordinary-note import;
   whether an individual detach-to-untyped action exists is unresolved. External
   `_type` edits cannot bypass the boundary.
8. **Platform contract:** delivery order and actual local desktop, CLI and web
   support; mobile remains deferred under the roadmap. Never present an omitted
   capability as available or infer another platform's acceptance from unit tests.

CRDT register/set/order semantics, actors, collision admission, offline schema
changes and encrypted update transport belong to the deferred roadmap section.
They do not block the local slice. The local acceptance matrix and pass log are
in the [tracker](../plans/types-properties-implementation.md#acceptance-matrix).

## 14. Handoff provenance and authorization

Discussion/design owner: this conversation. Original source read at `8507a855`;
original draft and this update use `codex/database-collaboration-design` at
`.worktrees/database-collaboration-design`. Canonical main was observed at
`214a96ae` with another session's staged changes during this documentation update;
those changes are untouched. Current main ownership must be checked afresh before
integration; the historical worktree base is not a current-code audit.

An earlier implementation interpretation created local-database worktrees and
partial unreviewed registry-retirement/docs drafts, then the user explicitly
stopped implementation. Those drafts are not approval, implementation completion
or evidence against this later product design. See the tracker's workspace ledger.

The latest user request authorizes documenting these decisions and creating the
tracker. Product implementation remains stopped pending a separate explicit
resume. No migration, sync activation, product verification or feature-completion
claim follows from these documentation changes.
