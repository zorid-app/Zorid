# Standalone Base source recovery — reference audit, 2026-10-22

Owner: `bases_docs_model`; reference-only follow-up for Q8 in the
[implementation goal](../plans/bases-implementation-goal.md). No application was
launched and no product source was changed. This records bounded shipped-source
inspection, not an executed UI-absence or parity claim.

Target: Obsidian 1.14.4 archive
`/Users/ctk/Library/Application Support/obsidian/obsidian-1.14.4.asar`, SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`;
`app.js` SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
REA parent:
`ev_3cadf9ce90d8c7bc6f8baf1878edc2a8513dc3b384d511150fecd4ef96ef9de5`.
Private provenance:
`/private/tmp/zorid-bases-source-recovery-reference/provenance.json`.
Eight prepared inert JS files, 20,541 bytes, 5,552 AST nodes, zero parse failures;
semantic graph capped at 1,000/200 nodes with unresolved external relationships.
Recovered code remains outside the repository.

## Inspected affordances

Ranges below are **Python decoded Unicode-character offsets**, end-exclusive;
they are not UTF-16 or byte offsets. Provenance retains raw/prepared slice hashes
and the added declaration/terminator syntax.

| Source scope / range | Bounded observation |
| --- | --- |
| Full Base file view `Q8`, 3135497–3138775 | Extends the text-file persistence view, sets `isPlaintext` false and owns the rendered Base controller. There is no source editor or pane-menu source toggle in this class. On parse failure it retains `lastData`, clears its parsed query and passes the error to the controller; `getViewData` can return that retained source. A text-file persistence superclass does not itself provide a visible editor. |
| Full Bases plugin `e9`, 3229423–3242159 | Registers new-file, insert, copy-table, change-view, add-view and add-item commands. Its file-menu hook adds New Base for folder explorer context; its editor-menu hook inserts a Base. No internal raw-source edit command/menu action is registered in this scope. |
| Text-file superclass `Q4`, 2807174–2809771 | Supplies file loading/saving/modify handling, not a raw-source editing affordance for the Base subclass. |
| Inherited generic file pane menu, 2630352–2630924 | Adds rename/delete and triggers the general file-menu event. It does not add a source editor. |
| Global Markdown source command, 1952364–1952708 | `editor:toggle-source` requires the active editor to be Markdown view `L8` in its edit mode. It does not operate on the standalone Base view `Q8`. |
| External-open command/menu, 3919794–3920098 and 2889003–2889266 | Generic actions delegate the file path to the operating system's default application. They are not an internal raw Base editor. |
| Base controller error UI, 2542711–2543057 | Displays the query/error message and disables/hides relevant rendered controls. No repair-source action appears in this handler. |

These inspected core registrations and inherited paths provide no internal raw
`.base` editing/recovery affordance. Third-party plugins, other releases and an
actual menu interaction are outside this evidence. Do not label a new Zorid
source editor as an observed Obsidian Base command.

## Approved Zorid extension and acceptance

The coordinator approved **Edit source** / **Return to Base** as a deliberate
addition to satisfy Q8. These are proposed Zorid labels, not recovered reference
labels. Keep Edit source in standalone Base pane chrome and expose the same
action beside an invalid-source diagnostic, so a parse error cannot hide the
only repair route behind disabled rendered controls.

Edit source should open the existing code editor on the same shared NoteBuffer
and saved file identity. Raw edits remain editable/saveable even when invalid;
do not replace them with blank/default Base configuration or require valid YAML
before saving. Return to Base settles the normal guarded save and attempts the
rendered view; a still-invalid file retains its text and actionable diagnostic.
The owner must retain ordinary stale-identity, dirty-source and failed-save
recovery rules rather than create a second persistence path.

Required actual scenarios: open invalid standalone `.base` → Edit source → repair
and save → Return to Base → verify the rendered result and exact durable text;
save still-invalid source and reopen it; retain unknown keys/comments/formatting;
handle external revision/path replacement and failed/uncertain saves; close and
restart without losing the draft. A valid Base must also expose the source
action. The extension remains implementation/runtime work; this source audit
does not accept Q8, redefine ordinary note modes or change deferred platform scope.
