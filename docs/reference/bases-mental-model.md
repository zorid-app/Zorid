# Obsidian Bases mental model

Current Zorid implementation scope:
[Bases implementation goal](../plans/bases-implementation-goal.md). This file is
reference research, not a competing design. The user-approved template exception
copies the complete template note literally, including properties and body;
frontmatter-only copying below describes Obsidian 1.14.4, not Zorid's target.

2026-10-21. Requested research for local Zorid Types/Bases work. Official docs
and static inspection of installed Obsidian 1.14.4; no runtime pass or copied
proprietary implementation in this repository. Broader Tasks/Calendar and
managed-data work is deferred by the user's current steering.

## Documented model

- A row represents an existing vault file. Editing a note property edits its
  frontmatter. A Base does not own separate copies of its items.
- A Base is YAML configuration in a `.base` file or an inline `base` code block.
  It holds filters, formulas, property presentation, summaries and named views.
- The starting universe is every vault file, including attachments. There is
  no SQL-style source clause. Global filters AND view filters select results.
- Views independently configure layout, visible properties, filtering, sorting,
  grouping and summaries. Multiple views can show the same files differently.
- Note properties, intrinsic file properties and computed formula properties
  have different origins. Formulas live in Base configuration.
- Property types are vault-wide by property name. The documented types are
  text, list, number, checkbox, date, datetime and tags. These are value types;
  the docs do not define Zorid-style named Book/Project entity Types.
- Embeds can select a named view. `this` can refer to the embedding note,
  enabling contextual collections. The standalone Base uses its own context.
- Kanban moves update the grouping property; folder grouping can move files.
  A view action therefore may change source data even though the view is derived.

Sources, consulted 2026-10-21:

- [Introduction](https://obsidian.md/help/bases)
- [Syntax](https://obsidian.md/help/bases/syntax)
- [Views](https://obsidian.md/help/bases/views)
- [Properties](https://obsidian.md/help/properties)
- [Creation and embeds](https://obsidian.md/help/bases/create-base)
- [Kanban](https://obsidian.md/help/bases/views/kanban)
- [Official published API](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)

The published API corroborates the query/render split: BasesEntry wraps TFile;
BasesQueryResult supplies evaluated/sorted/limited/grouped results; BasesView
receives configuration/results and updates when those change. Current published
API documentation is not proof of every installed-version behavior.

## Shipped artifact evidence

Actual target: `/Users/ctk/Library/Application Support/obsidian/obsidian-1.14.4.asar`.
Package version is 1.14.4. ASAR SHA-256:
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.
Member `app.js` SHA-256:
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
This matches the earlier focused [reference inventory](bases-reference.md).
The app bundle also contains an older 1.7.4 archive; it is not the Bases target.

REA parent `ev_d8d678ac793340dd67e43399fa38ffed3cd5606779b238427ce9688321403822`
inventoried the actual archive with selected app.js/package.json. Whole-bundle
semantic analysis exhausted the bounded worker heap; no complete semantic graph
or successful whole-app analysis is claimed. Focused direct artifact readings
below are analyst observations, not invented REA graph conclusions.

Offsets below are zero-based decoded Unicode character positions in app.js:

- Around 2351802: parser reads views, filters, properties, formulas, summaries,
  newItemFolder and newItemTemplate. Missing/empty views get a default table.
- 2371943–2373635: creation helper derives frontmatter and folder suggestions
  from supported filter rules and visible note properties. It recognizes selected
  comparisons, tag/folder and list/text rules, skipping unsupported/errors. This
  is bounded heuristic inference, not a guarantee arbitrary filters are satisfied.
- Around 2514203–2516000: New uses configured template/folder or inferred folder,
  creates an ordinary file, then writes initial frontmatter. Template frontmatter
  and inferred values take separate branches. A new note is not a database row.
- Around 3156250: Kanban writes frontmatter through the file manager inside an
  undo-aware transaction; a null group can remove the property. Folder grouping
  follows a separate file-move path.
- Around 3234099: built-in Table, Cards, List and Kanban factories are registered.

The exact creation-helper slice was analyzed separately by REA without executing
it. Parent `ev_6f941bd274ff23d8fd1c37af0d477780872396aaafb7d9a128b1c296be099212`
reports one parsed JS file, 596 visited AST nodes and zero parse failures.
Original-range/hash provenance and the private fragment remain only under
`/private/tmp/zorid-obsidian-bases-model-20261021`. External referenced functions
and dynamic behavior remain unresolved; parsing does not prove runtime outcomes.

## Implication for Zorid

### New-template follow-up and UI direction — 2026-10-21

User now chooses exact Obsidian Bases appearance/interactions as the initial
target. This replaces earlier best-UX discretion for this scoped feature. No
visual/runtime parity is established by this static investigation.

The installed 1.14.4 New method at app.js character range 2513957–2515672
reads root `newItemTemplate` and `newItemFolder`. A resolved template contributes
cached frontmatter; it does not read/copy the body in this path. Template use
skips the ordinary inferred-frontmatter branch, although an optional caller
modifier can subsequently edit properties. With no explicit folder, a resolved
template's parent is used before filter-derived/default folder fallback.
This is not full template insertion or proof of variable expansion. The inspected
method opens the created note in a desktop popover or a phone tab.

All eight literal `newItemTemplate` occurrences in this bundle lie in parsing,
serialization and this New method; no setter UI was identified by that bounded
search. Consulted official Bases Views/Syntax pages describe New but do not
document a template selector. Absence of such documentation/static references
does not prove every possible runtime/plugin UI is absent.

REA parent `ev_c5812d6ea6f07759df84548162cb92df1094c547c1880a0721da974ced6714b0`
analyzed the exact New expression-statement slice: 1,715 bytes, 565 AST nodes,
one parsed source and zero parse failures. Original hash/ranges and private
fragment remain in `/private/tmp/zorid-obsidian-bases-new-template-20261021`.
No code executed; dependent calls remain unresolved. Analyst source reading
establishes the branch details above; AST parsing alone does not prove effects.

### Local implementation boundary

Local delivery can use existing note storage, shared Rust index/query evaluation,
file-backed Base configuration and guarded property edits. Neither sync nor
the broader managed-record service is a prerequisite. Define only the concrete
local contracts needed by this feature.

Latest direct user decision supersedes the earlier Type proposal: remove named
Types and follow Obsidian-style Bases. Files contain ordinary properties; a Base
selects files; a View presents them. Users can add `type: book` without declaring
a schema or registering a Type. Bases must work without that property. Membership
can use tags, folders or any supported property filter. Creating a Base must not
move/copy notes or silently assign classification properties.

Property value typing and suitable controls remain necessary. Their configuration
is a property concern; no Book/Project schema object or Type editor is required.
Exact select/status option storage needs a concrete local decision before edits.
Creation folder/template/property defaults remain separate from membership.
Safe filter inference may help; arbitrary filters must not fabricate values.

First delivery scenario: create/configure a Base; create and edit ordinary notes;
switch named Table/Cards/List/Kanban views; open the same notes in splits/embeds;
restart and retain data/configuration. Existing foundations require reconciliation
and actual UI verification. Broader managed-data, Tasks and Calendar work remains
deferred. Existing Type-dependent implementation has not been removed or migrated
by these documentation edits; this decision supersedes its product requirements.
