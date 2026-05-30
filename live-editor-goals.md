# Live Editor Goals

## Product goal

Zorid's editor should be a Markdown-native live editor where Markdown text remains the durable source of truth, while Live Preview renders richer projections over that source. The editor should support ordinary Markdown authoring, Obsidian-style Live Preview behavior, first-party structured blocks, and plugin-provided blocks without turning the document into a hidden rich-text model.

The editor should be flexible enough for simple Markdown formatting, source-backed widgets such as callouts and code blocks, and complex interactive widgets such as calendars, timelines, kanban boards, data views, and multi-column layouts.

## Capabilities the editor should support

### 1. Source-backed Live Preview

The editor should hide or visually transform Markdown syntax when the user is not actively editing that syntax, and reveal or activate the editable representation according to the block's own behavior.

Required behavior:

- Markdown source remains canonical for Markdown-defined content.
- External-reference blocks keep the embed/reference in the current Markdown file while their durable definition may live in another file.
- Preview widgets and decorations are projections only.
- Save and external file sync operate on durable source: either the Markdown file or the referenced external file.
- Unsupported or ambiguous syntax should stay raw rather than render an inconsistent pseudo-preview.

Source reveal is an important default, but it must not be the only editing behavior. Some blocks should reveal raw Markdown; others should open a structured editor, open a referenced file, keep preview visible, or handle interaction entirely inside the widget.

### 2. Inline and block renderers

The editor should support both simple inline renderers and structured block widgets.

Examples:

- Inline marks/replacements: headings, emphasis, inline code, links, wiki links, tags, highlights.
- Source-backed interaction widgets: task checkboxes.
- Block widgets: fenced code blocks, callouts, timeline/calendar/custom blocks, multi-column layouts, and `.zbase` embeds.

### 3. Markdown-defined blocks

Plugins and first-party features should be able to define blocks whose full definition lives in the Markdown file.

Example shapes:

````markdown
```timeline
- 2026-01-01: Started project
- 2026-02-15: Shipped alpha
```
````

```markdown
:::timeline
- 2026-01-01: Started project
:::
```

A two-column block should also be possible:

````markdown
```columns
count: 2
---
# Left

Left column content.
---
# Right

Right column content.
```
````

or with container syntax:

```markdown
:::columns 3
:::column
Left
:::
:::column
Middle
:::
:::column
Right
:::
:::
```

The exact syntax does not have to be one-size-fits-all, but every supported shape should normalize into a common block match model.

### 4. External-reference blocks

The editor should also support blocks whose definition lives in an independent file, while the current Markdown file contains an embed/reference to that external definition.

Example:

```markdown
![[.zorid/views/tasks.zbase#open]]
```

This should render as a live block in the editor, but the current Markdown file still owns only the embed syntax. The external file remains the durable definition for the rendered content.

External-reference widgets may choose how interaction behaves. For example, editing a `.zbase` embed might open the referenced `.zbase` file, open a structured view editor, or reveal the embed syntax, depending on the block registration.

### 5. Plugin-defined blocks

Plugins should be able to register their own inline-defined blocks and external-reference blocks.

A plugin should be able to declare:

- what syntax it owns;
- how matches are converted into normalized block definitions;
- how to render the block widget;
- how activation, editing, copy, cut, paste, and custom interactions work;
- what durable source mutations are allowed;
- whether extra CodeMirror extensions/keybindings are needed;
- how, later, the same semantic block can be rendered in Reading view.

Plugins should not directly mutate the editor content DOM outside their own widget root. The editor host should own decoration/widget composition, ordering, source mapping, history boundaries, error handling, and document transactions. Within the widget root, a plugin may render custom DOM and handle local interactions.

### 6. Fully interactive custom widgets

A block should be able to render a custom `HTMLElement` or `WidgetType` with its own UI and event handlers.

Examples:

- calendar widget with next/previous month controls;
- kanban board with drag interactions;
- data-view table with sorting/filter controls;
- two-column or three-column layout widget;
- timeline widget with collapsible entries.

Local UI state may be ephemeral. Durable changes must be requested through host-mediated actions or transactions, not by mutating editor content DOM directly.

## Recommended architecture

### One normalized block model

Use one model for both inline-defined and external-reference blocks:

```ts
type MarkdownBlockDefinition =
  | {
      kind: 'inline';
      sourceFrom: number;
      sourceTo: number;
      sourceText: string;
    }
  | {
      kind: 'external';
      sourceFrom: number;
      sourceTo: number;
      path: string;
      fragment?: string;
      referenceSyntax: 'wikilink-embed' | 'markdown-link' | string;
    };

interface MarkdownBlockMatch {
  id: string;
  type: string;
  from: number;
  to: number;
  activationFrom: number;
  activationTo: number;
  definition: MarkdownBlockDefinition;
  className: string;
  attributes?: Readonly<Record<string, string>>;
  atomic?: 'none' | 'widget';
  meta?: Readonly<Record<string, unknown>>;
}
```

The match describes source ownership and positional behavior. It should not hard-code clipboard or editing policy as a small enum because complex widgets need programmatic control.

### Public registration API

Because the editor has no external consumers yet, Zorid can design the public editor API now and revise it while first-party blocks prove the shape.

A target API should let the registration declare both syntax ownership and renderer behavior:

```ts
interface MarkdownBlockRegistration<Match extends MarkdownBlockMatch = MarkdownBlockMatch> {
  id: string;
  priority?: number;

  syntax:
    | readonly MarkdownBlockSyntax[]
    | { kind: 'custom'; match(context: MarkdownBlockMatchContext): readonly Match[] };

  render(match: Match, context: MarkdownBlockRenderContext): WidgetType | HTMLElement;

  onActivate?(event: MarkdownBlockActivateEvent, match: Match, context: MarkdownBlockInteractionContext): BlockAction;
  onEdit?(event: MarkdownBlockEditEvent, match: Match, context: MarkdownBlockInteractionContext): BlockAction;
  onCopy?(event: MarkdownBlockClipboardEvent, match: Match, context: MarkdownBlockClipboardContext): BlockClipboardResult;
  onCut?(event: MarkdownBlockClipboardEvent, match: Match, context: MarkdownBlockClipboardContext): BlockClipboardResult & BlockAction;
  onPaste?(event: MarkdownBlockClipboardEvent, match: Match, context: MarkdownBlockClipboardContext): BlockAction;

  extensions?(): readonly Extension[];
  keybindings?(): readonly KeyBinding[];
  readingViewAdapter?(): unknown;
}

type MarkdownBlockSyntax =
  | { kind: 'fenced-code'; info: string }
  | { kind: 'container'; marker: string; name: string }
  | { kind: 'embed-reference'; extensions?: readonly string[]; pathPattern?: RegExp }
  | { kind: 'callout'; type?: string };
```

The hook return values should be host-mediated actions:

```ts
type BlockAction =
  | { kind: 'dispatch'; transaction: TransactionSpec }
  | { kind: 'reveal-source'; range?: { from: number; to: number } }
  | { kind: 'open-reference'; path: string; fragment?: string }
  | { kind: 'set-ephemeral-state'; key: string; value: unknown }
  | { kind: 'none' };

type BlockClipboardResult =
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string; text?: string }
  | { kind: 'delegate' };
```

The key design choice is full behavioral customization through programmatic hooks, while keeping final editor mutations host-mediated.

### Why programmatic hooks instead of fixed policies

Fixed policies such as `copy: 'document-source'` or `activation: 'reveal-source'` are useful defaults, but they are too limiting as the main API.

Examples:

- A code block may want copy to preserve source or copy only code content depending on selection.
- A callout may initially reveal source but later offer structured title/body editing.
- A two-column block may want copy to return the plain column contents separated by blank lines, not the block source syntax.
- A calendar widget may keep next/previous month as ephemeral UI state but write durable event changes back to Markdown or an external file.
- A `.zbase` embed may want edit to open the referenced file or a data-view editor rather than reveal only the embed syntax.

Therefore each block type should be able to programmatically control activate/edit/copy/cut/paste behavior. The host should still apply resulting actions so undo/redo, transaction boundaries, selection mapping, and safety stay coherent.

### Matching strategy

Prefer parser-backed matching over ad-hoc regex scanning.

Recommended layers:

1. Use CodeMirror/Lezer Markdown as the base parser.
2. Add Zorid syntax extensions for known syntax families: wikilinks, embeds, callouts, tags, highlights, frontmatter, and future block forms.
3. Let block registrations claim syntax through declarations such as fenced code info strings, container names, callout types, or embed extensions.
4. Match common block syntaxes from syntax-tree nodes where possible.
5. Allow a custom matcher escape hatch for early plugin experimentation, but keep it bounded by visible ranges and source/mapping rules.
6. Keep unsupported or ambiguous syntax raw.

The registry should diagnose conflicts, such as two plugins claiming the same fenced-code info string or the same external extension. Conflict resolution can use priority and user configuration, but should be deterministic.

### Unified built-in block families

Start with these built-in families:

1. `fenced-code` inline-defined blocks.
2. `callout` inline-defined blockquotes.
3. `.zbase` external-reference blocks from `![[path.zbase#view]]`.
4. One simple first-party custom inline block, such as `timeline` or `columns`, to prove the API is not special-cased to current widgets.

### Source and history invariants

Every durable edit must become a CodeMirror transaction over Markdown source or an explicit write to a referenced external file through the host/plugin API.

Rules:

- Widget-local UI state may be ephemeral.
- Durable document state must live in Markdown text or in the referenced external file.
- Copy/cut defaults may preserve the current document source slice, but blocks can override copy/cut programmatically.
- Undo/redo should not depend on widget DOM state.
- External-reference widgets should distinguish current-document reference edits from referenced-file edits.

## What the current implementation already has

The repo already has much of the foundation:

- CodeMirror ownership in `@zorid/editor`.
- A private Zorid Markdown parser facade.
- Syntax-tree-backed inline renderers.
- Source reveal based on focus and selection.
- Source-backed task checkbox toggles.
- Code-block and callout widgets.
- Viewport-bounded widget collection.
- Source-preserving clipboard/cut tests.
- A private block renderer adapter used by code-block and callout widgets.
- App-level `.zbase` embed discovery and rendering outside Live Preview.

## Gaps to close

The missing pieces are:

1. A public/editor-facing `registerMarkdownBlock` style API.
2. A normalized match model that supports both inline and external definitions.
3. Programmatic block hooks for activate/edit/copy/cut/paste.
4. Live Preview rendering for external-reference blocks such as `.zbase` embeds.
5. A first-party custom inline block proof that is neither code block nor callout.
6. Parser support for embed references and any chosen custom block syntax.
7. Tests that prove source reveal or structured activation, custom clipboard behavior, undo/redo, viewport bounds, and fallback/raw behavior across both block definition models.

## Recommended next step

The next implementation pass should be a public-internal block API pass:

1. Introduce the normalized `MarkdownBlockMatch` / `MarkdownBlockDefinition` model.
2. Introduce `registerMarkdownBlock` or an equivalent block registration facet inside `@zorid/editor`.
3. Add programmatic hooks for activate/edit/copy/cut/paste with host-mediated action results.
4. Port existing code-block and callout widgets to that registration path.
5. Add `.zbase` embed Live Preview as the first external-reference block.
6. Add one tiny inline-defined proof block, likely `columns` or `timeline`, only after code-block/callout/.zbase are using the common path.
7. Keep Reading view parity, tables, properties editor, images/embeds beyond `.zbase`, and generalized plugin marketplace concerns out of this pass.

This moves Zorid toward plugin-defined blocks while keeping the core invariant simple: Markdown text or the referenced external file is the source of truth; Live Preview is the projection layer. Blocks get full behavioral customization, while the host owns final editor mutations, ordering, history, and safety.

## Relationship to deep research artifacts

These goals are consistent with the deep research direction:

- The research recommends a semantic renderer registry rather than direct DOM mutation.
- The research recommends plugin renderer registration with priority, matching, activation hooks, keybindings/extensions, and preview adapters.
- The research emphasizes that Markdown text must remain the source of truth and durable widget edits should become transactions.
- The research separates Live Preview from Reading view and treats Reading parity as a later adapter layer.
- The research identifies custom Markdown dialect support as a language-layer concern, not something vanilla Markdown can fully cover.

The main extension beyond the research is stronger emphasis on block-level programmatic hooks for edit/copy/cut/paste and explicit support for both inline-defined and external-reference block definitions. This is not a conflict; it is a concrete API refinement of the research's renderer/lifecycle direction.
