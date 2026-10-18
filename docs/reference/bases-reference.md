# Bases reference inventory

This is a focused static inventory of Obsidian 1.14.4's built-in Bases views and extension boundaries. The requested parity scope includes **all existing views and interactions**, not merely opening `.base` files or displaying a table. This inventory is not implementation completion or behavior certification.

The pass reused desktop REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` and APK inventory `ev_90bd2cb53a47511858df33ce3b4ad304c2af7a8d82c12035710bcabfeed4623d`. Desktop `app.js` SHA-256 is `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`; mobile `app.js` SHA-256 is `b0452336e0926983c240ce168bb03bcc308d32a54fc97cdd5db72ed7f333f997`. The detailed findings are ordinary focused source readings linked to those artifact identities, not new REA semantic facts. No target code was executed, broad analysis repeated, or recovered source copied into this project.

Offsets below are zero-based Unicode character positions in UTF-8-decoded desktop `app.js`, not byte positions. They identify this build only.

## Built-in registrations

The Bases plugin identifies itself as `bases`, marks itself default-on, and registers `.base` file views and embeds. Its built-in view registration sequence around 3234275 contains **four views**:

| Display name | Registration ID | Icon | Definition / registration evidence |
| --- | --- | --- | --- |
| Table | `table` | `lucide-table` | ID near 3189534; factory/options registration near 3234275 |
| Cards | `cards` | `lucide-layout-grid` | ID near 3142220; registration near 3234408 |
| List | `list` | `lucide-list` | ID near 3175676; registration near 3234547 |
| Kanban | `kanban` | `lucide-kanban-square` | ID near 3152425; registration near 3234678 |

The APK also contains all four registrations around 3194602–3195005, including Kanban. This confirms registration candidates in both shipped bundles; it does not prove every view's current mobile behavior or visual identity. No fifth built-in was observed in the bounded initialization sequence. Community-provided views are an additional compatibility scope, not evidence that this bounded built-in inventory is exhaustive of all possible views.

## View-specific options and interactions

| View | Explicit option declarations | Interaction candidates in the inspected implementation |
| --- | --- | --- |
| Table | `rowHeight`: default/short, `medium`, `tall`, `extra`. | Cell selection and editing; multi-cell clipboard handling; cell context menus; column header reorder; sorting; column drag/pointer resizing, reset and automatic size; grouped rows; property/formula columns; group/overall summaries; scroll state; row/column virtualization. |
| Cards | `cardSize`: 50–800, step 10, default 200. `image`: property selector. `imageFit`: default cover or `contain`. `imageAspectRatio`: 0.25–2.5, step 0.05, default 1. | Group collapse; image covers and property renderers; open-note clicks preserving text/link interaction; modifier/middle click; hover links; file context menu/deletion; link dragging; retained scroll state; viewport virtualization. |
| List | `markers`: `bullet`, `number`, `none`, default bullet. `indentProperties`: false by default. `separator`: default comma+space, hidden while property indentation is enabled. | Grouped rows, collapse, property ordering, note/property rendering, cached row measurement, scroll/resize handling and viewport virtualization. Full pointer/keyboard/edit semantics still need tracing. |
| Kanban | `columnWidth`: 200–500, step 10, default 280. `image`, `imageFit` as Cards. `imageAspectRatio`: 0.25–2.5, step 0.05, default 0.5. | Drag cards between columns; group-property updates; card-order computation; reorder/hide columns; edit groups; create a note in a group; read-only guards and error handling; pending-move reconciliation; image/property rendering and viewport virtualization. |

Options are directly observed static schemas, not inferred defaults from screenshots. Cards option declaration is near 3148591, Kanban near 3165996, List near 3176977, and Table near 3220490. Method/handler inspection scopes were Cards 3142260–3152425, Kanban 3152642–3175676, List 3175752–3189534, and Table 3191637–3229440. That coverage is bounded; names or registrations alone cannot establish the full interaction contract.

The Table clipboard reader near 3189534 recognizes `obsidian/bases-cells`, `obsidian/table`, and tab-separated plain text. Actual coercion, rectangular paste, invalid values, read-only cells, and undo/redo behavior require fixtures. The table header implementation near 3222000 uses different mobile/desktop menu triggers and exposes mobile resize actions; reproducing only a desktop right-click menu would leave a mobile gap.

Kanban's inspected handlers include moving cards by changing the grouping property, guarding whether a card may move, translating a group key into frontmatter, undo-aware updates, and handling failed pending moves. When grouped by folder, the move path instead resolves a destination folder and moves the file. For property grouping it requires a Markdown file, uses a frontmatter transaction, handles list-valued properties, and removes the property for a null group key. Reordering visual DOM alone is not sufficient evidence of Kanban parity. Multiple-value groups, empty groups, hidden-column persistence, templates, ordering conflicts and keyboard/touch equivalence remain unverified.

## Query, document and configuration surface

The query parser around 2351500 accepts YAML-backed data with views, filters, property definitions, formulas, summaries, new-item folder/template settings, and an unrecognized-data store. Empty input creates a default Table view. The view config around 2348156 serializes its type/name, filter, group-by property/direction, group order, property order, sort entries, limit, summaries, and additional option data. A format-compatible clone needs round-trip fixtures for unfamiliar keys and all view types rather than rewriting files into a smaller schema.

The inspected config methods expose view cloning, option get/set, property ordering, sort toggling, limits, summary selection and grouping. `setSortProperty` implements a cycle through ascending, descending and no sort. Grouping changes can reset group order. These are candidate semantics; complete parser validation, formula language, property IDs, null/type behavior, query dependency tracking and error UI are not proven by this pass.

The plugin registers commands for creating a base, embedding a base, copying a table, changing/adding a view, and adding an item. It also registers a `base:query` CLI handler with JSON/CSV/TSV/Markdown/path output choices. Toolbar command availability, active-view context, clipboard formatting, and query result ordering need behavioral tests.

Bases are embedded both through `.base` file embeds, with a fragment selecting a view name, and fenced `base` blocks. The fenced-block path attaches a child render component and writes updated query text back through the code-block replacement callback. Unload removes its postprocessors, embed registration and view registrations. These lifecycle behaviors are part of compatibility; static rendering of a YAML block is not a substitute.

## Focused persisted-schema findings

This supplement reads the same desktop artifact at 2340000–2361400 (property/filter/query/view configuration), 2371307 (unique-name helper), 2491400–2493150 (execution sorting), and 2522000–2534400 (view configuration UI). These are static observations; no fixture was executed against Obsidian. The parser and interactive editor have different validation rules.

| Location | Persisted keys and handling |
| --- | --- |
| Root | `views`, `filters`, `properties`, `formulas`, `summaries`, `newItemFolder`, `newItemTemplate`; legacy `display` is migrated to property display names. Other keys are retained in an unrecognized-data object. |
| Each view | Required nonempty string `type` and `name`. Optional `filters`, `groupBy`, `groupOrder`, `order`, `sort`, `limit`, `summaries`. Other keys are retained as view option data, including options belonging to custom views. Unknown registration IDs are not rejected here. |
| `properties` | Mapping from property IDs to configuration objects. Null entries are skipped. Recognized configuration key is `displayName` when a string; unknown configuration keys survive. Empty configurations are omitted on serialization. Root property mapping keys retain their stored spelling; normalization of the property's internal ID does not automatically rewrite that root key. |
| Root `formulas` / `summaries` | Named mappings whose values must be expression strings. They are parsed into formula objects. This schema check alone does not establish expression correctness or result type. |
| View `summaries` | Property-ID-to-summary-name mapping; values must be strings. Property IDs normalize internally and compact during serialization. |
| `groupBy` | Object with both `property` and `direction` keys. Missing keys/wrong container type cause an error. A nonempty string property and exact `ASC` or `DESC` direction are required for the grouping to be retained; other values are silently ignored in this branch. |
| `groupOrder` | Copied only when an array; discarded when no valid grouping exists. Changing the grouping property resets its prior order. Element validation was not observed here. |
| `order` | Must be an array of property IDs. No explicit element-type validation precedes the string normalization helper. Missing order returns `file.name`; explicit empty array remains empty. |
| `sort` | Array of objects with `property` and exact `ASC`/`DESC` `direction`; legacy truthy `column` replaces `property`. Invalid criteria are skipped, and a non-array sort is ignored. Null entries can fail incidentally. |
| `limit` | Retained only for a positive numeric value. No integer check was observed in this parser. Config getter defaults to zero, meaning no limit. |
| New-item settings | Truthy `newItemFolder` and `newItemTemplate` must be strings. Empty/falsey values are ignored and omitted by the observed serializer. |

Empty source, missing `views`, or `views: []` creates one `table` view with a localized default name. The English label was not independently verified in this pass. A present non-array `views` is an error. Individual malformed views do not receive a fallback type/name. Names are not trimmed or deduplicated by the parser. Its broad `typeof object` checks do not consistently exclude arrays or null, so malformed values may produce incidental exceptions rather than a deliberate schema message. An original implementation can provide clearer errors without claiming those messages match the reference.

The query serializer starts with retained root data, writes its recognized sections, and always writes the views array. The root unknown-key exclusion list notably omits `summaries`; a parsed summaries section is also retained there before generated summaries overwrite it. Unknown view option serialization has a collision guard against properties already owned by the config object. Therefore “every unknown key always round-trips unchanged” is too strong. YAML comments, anchors, quote styles, ordering, and formatting retention are not established by this object-level schema pass.

The config getter returns an empty sort array when none is stored. Query execution separately removes sort criteria absent from the available properties and uses `file.name ASC` if none remain. Numeric pairs compare numerically, date pairs by time, duration pairs by duration; other comparable values use rendered text comparison, with special boolean/null handling. This is not evidence that mixed types are uniformly coerced to numbers or that locale-specific ordering matches a clone.

### Filters and property identifiers

A filter is an expression string, or an object with exactly one of `and`, `or`, `not`, whose value must be an array of recursively valid filters. There is no observed persisted `{property, operator, value}` leaf format in this parser. `not` means no child passes (NOR), rather than negating only the first element. Direct empty arrays evaluate as `and: []` true, `or: []` false, `not: []` true; separate optimization methods can remove empty groups, so editing/optimization behavior requires additional fixtures.

Property IDs beginning with `note.`, `formula.`, or `file.` retain that namespace. Exact `file` expands to `file.file`; other bare IDs acquire `note.`. Prefix detection is case-sensitive. Compact serialization changes `file.file` to `file`, and removes `note.` unless the remaining name begins with a reserved first segment `note`, `file`, or `formula`. These are identifier rules, not proof of case-sensitive frontmatter lookup: the runtime context has additional case-insensitive lookup paths.

The inspected formula function evaluator checks parameter value classes and can report type mismatches; required null inputs can propagate a null result. It is unsafe to infer JavaScript-style coercion for all operators/functions. Property schema inference distinguishes text, number, checkbox, date/datetime, tags, and list-like metadata, but this pass does not establish every mixed-type filter outcome or conversion/edit rule.

### View names, default view, and removal

The UI trims edited names and rejects empty names, exact duplicate names, and these characters/sequences: colon, hash, pipe, caret, backslash, line breaks, `%%`, `[[`, `]]`. This is stricter than the persisted parser. Add/duplicate name generation uses a case-sensitive set and appends a space plus increasing integers starting at 2. Setting a default view moves it to the first array position; there is no separate observed default-view field. Lookup without a name returns the first view; named lookup uses the first exact name match.

The inspected delete action removes the selected view, picks a previous/first remaining view, and reads its name. No last-view guard was visible in that bounded handler. This neither proves that deleting the sole view works nor establishes a reference prohibition: surrounding UI/runtime behavior remains unverified. A clone safeguard must be identified as its own behavior until tested against the target. Renaming a saved base's view also has a metadata-reference update path for links selecting that view; changing only the YAML label leaves that interaction incomplete.

### Independent example fixture

The following is newly authored illustrative data using observed field shapes, not a recovered reference document. Formula evaluation and rendering are not certified by presenting it.

```yaml
filters:
  and:
    - 'file.ext == "md"'
    - not:
        - 'status == "archived"'
properties:
  status:
    displayName: Stage
    customHint: retained example
formulas:
  doubled: 'effort * 2'
summaries:
  TotalEffort: 'values.sum()'
newItemFolder: Projects
newItemTemplate: Templates/Project.md
customRoot: retained example
views:
  - type: table
    name: Projects
    order: [file.name, status, effort, formula.doubled]
    sort:
      - property: file.name
        direction: ASC
    groupBy:
      property: status
      direction: DESC
    groupOrder: []
    limit: 50
    summaries:
      effort: TotalEffort
    rowHeight: medium
  - type: cards
    name: Gallery
    filters: 'effort > 0'
    order: [file.name, status]
    cardSize: 240
```

## Extension hooks

The plugin API around 2948944 exposes `registerBasesView(id, registration)`. It checks for an enabled Bases plugin, delegates registration, and schedules deregistration on plugin cleanup. The corresponding registry around 3241657 stores registrations by ID and exposes lookup and factory retrieval. Observed registration fields include `name`, `icon`, `factory`, and `options`. Duplicate registration has a notice/error path. Exact duplicate handling, option callback contexts, enable/disable ordering and exceptions still require runtime/API fixtures.

The public export map near 248563 includes `BasesEntry`, `BasesEntryGroup`, `BasesQueryResult`, `BasesView`, and `BasesViewConfig`. The base view near 2493579 provides lifecycle/resize/focus/ephemeral-state hooks, view actions, file creation, transactions, group-heading/collapse behavior, property updates, undo/redo transactions, table export/clipboard, and value renderers. This is an export/method inventory, not a verified TypeScript signature reconstruction.

Adjacent plugin hooks `registerGlobalFunc` and `registerInstanceFunc` register formula functions and remove them on cleanup. Custom formulas and custom view plugins therefore need compatibility fixtures covering invocation context, supported value types, errors, async/lifecycle assumptions and cleanup—not only a function-name registry.

## Remaining parity work

Build a reference-backed fixture matrix for all four views and shared behaviors: query/filter/formula evaluation, sorting/grouping, property and row creation, editing/coercion, drag/drop, clipboard, undo/redo, view settings and persistence, summaries, embed lifecycle, plugin extensions, keyboard navigation, accessibility, mobile touch/menus and viewport behavior. Measure large-query/rendering performance separately; observed virtualization is architecture evidence, not a performance result.

This report proves the target includes Table, Cards, List and Kanban registrations. It does not prove that Zorid implements any of them completely or that the bounded investigation has identified every interaction.
