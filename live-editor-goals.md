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

### 7. Non-source editor-window UI

Not every editor-adjacent feature is a Markdown Live Preview projection. Zorid should also support plugin-provided UI that belongs to the surrounding editor window rather than to a Markdown source range.

Examples:

- a Properties UI above the document body;
- cursor or selection popovers;
- hover inspectors;
- command/context toolbars;
- lint, AI, backlink, or field hints;
- plugin status badges or lightweight document chrome.

These contributions may observe the active document and read-only editor state, but they are not themselves Markdown renderers. They should not be forced into `MarkdownBlockRegistration` or `MarkdownInlineRegistration` just because they appear near the editor. The editor window host should own mounting, placement, collision handling, focus behavior, z-index, accessibility, and lifecycle cleanup.

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

### Block registration API

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

### Shared projection action and clipboard primitives

Block and inline Live Preview registrations should share the same host-mediated action and clipboard vocabulary. This keeps source-backed projections predictable even when different plugins own different syntax families.

```ts
type EditorProjectionAction =
  | { kind: 'dispatch'; transaction: TransactionSpec }
  | { kind: 'reveal-source'; range?: SourceRange }
  | { kind: 'set-selection'; selection: SourceSelection }
  | { kind: 'open-reference'; path: string; fragment?: string }
  | { kind: 'set-ephemeral-state'; key: string; value: unknown }
  | { kind: 'none' };

type EditorClipboardResult =
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string; text?: string }
  | { kind: 'delegate' };

interface SourceRange {
  from: number;
  to: number;
}
```

The host, not plugin DOM, applies these results. Durable Markdown edits must become CodeMirror transactions. External durable edits must go through explicit workspace/plugin APIs. Plugin UI may keep ephemeral widget state, but undo/redo, selection mapping, clipboard, and document persistence stay host-mediated.

### Inline registration API

Inline syntax needs its own registration contract. It should not be squeezed into the block contract. This is needed for task checkboxes, tri-state checkboxes, tags, wikilinks, highlights, inline pills, inline references, and future plugin-defined inline syntax.

A target API should let plugins declare inline syntax ownership, render a mark/replacement/widget, and customize activation, selection, copy, cut, and paste behavior:

```ts
interface MarkdownInlineRegistration<Match extends MarkdownInlineMatch = MarkdownInlineMatch> {
  id: string;
  priority?: number;

  syntax:
    | readonly MarkdownInlineSyntax[]
    | { kind: 'custom'; match(context: MarkdownInlineMatchContext): readonly Match[] };

  render(match: Match, context: MarkdownInlineRenderContext): InlineRenderResult;

  onActivate?(event: Event, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;
  onSelect?(event: Event, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;
  onCopy?(event: MarkdownProjectionClipboardEvent, match: Match, context: MarkdownInlineInteractionContext): EditorClipboardResult;
  onCut?(
    event: MarkdownProjectionClipboardEvent,
    match: Match,
    context: MarkdownInlineInteractionContext,
  ): EditorClipboardResult | { clipboard: EditorClipboardResult; action?: EditorProjectionAction };
  onPaste?(event: ClipboardEvent, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;

  extensions?(): readonly Extension[];
  keybindings?(): readonly KeyBinding[];
}

interface MarkdownInlineMatch {
  id: string;
  type: string;
  from: number;
  to: number;
  activationFrom: number;
  activationTo: number;
  sourceFrom: number;
  sourceTo: number;
  sourceText: string;
  className?: string;
  attributes?: Readonly<Record<string, string>>;
  atomic?: 'none' | 'inline';
  selectionPolicy?: InlineSelectionPolicy;
  meta?: Readonly<Record<string, unknown>>;
}

type InlineSelectionPolicy =
  | { kind: 'source' }
  | { kind: 'content'; range: SourceRange }
  | { kind: 'token' }
  | { kind: 'custom' };

type InlineRenderResult =
  | { kind: 'mark'; className: string; attributes?: Readonly<Record<string, string>> }
  | { kind: 'replace'; widget?: WidgetType | HTMLElement }
  | { kind: 'widget'; widget: WidgetType | HTMLElement }
  | { kind: 'none' };
```

The `selectionPolicy` is important because inline elements differ. A tag may want token selection, a wikilink may want alias/content selection, inline code may preserve Markdown delimiters on copy, and a custom checkbox may want activation over only the marker. If `selectionPolicy` is `custom`, the host calls `onSelect` and applies the returned host action.

A tri-state task checkbox should be modeled as an inline/list-marker registration rather than as a block:

```ts
const triStateTaskRegistration: MarkdownInlineRegistration = {
  id: 'tri-state-task-checkbox',
  priority: 100,
  syntax: [{ kind: 'task-marker', states: [' ', '/', 'x'] }],
  render(match) {
    return { kind: 'replace', widget: new TriStateCheckboxWidget(String(match.meta?.state)) };
  },
  onActivate(_event, match) {
    const state = String(match.meta?.state ?? ' ');
    const next = state === ' ' ? '/' : state === '/' ? 'x' : ' ';
    return {
      kind: 'dispatch',
      transaction: {
        changes: { from: match.sourceFrom + 3, to: match.sourceFrom + 4, insert: next },
        userEvent: 'input.task.toggle',
      },
    };
  },
  onCopy(_event, match) {
    return { kind: 'text', text: match.sourceText };
  },
};
```

This keeps the source marker canonical while allowing plugins to define richer inline behavior than the built-in two-state checkbox.

### Markdown editor versus editor window

The Markdown Live Editor and the surrounding editor window are different extension surfaces.

The Markdown Live Editor owns source-backed Markdown projections:

- inline registrations;
- block registrations;
- parser/matcher ownership for Markdown syntax;
- source reveal and activation;
- source-backed selection, copy, cut, paste, and transactions.

The editor window owns non-source UI around or above the editor:

- document properties UI;
- cursor and selection popovers;
- hover inspectors;
- toolbars and status chrome;
- panels, gutters, and overlays that observe editor state but do not represent a Markdown source range.

Editor-window contributions may read a safe, read-only editor/window context and request host actions, but the host owns final mounting and placement. They should not mutate CodeMirror content DOM or claim Markdown ranges unless they also register through the Markdown inline/block APIs.

### Editor window contribution API

The editor window should provide predefined placement lanes instead of letting plugins attach arbitrary absolutely positioned DOM. Plugins declare intent and render content; the host computes final coordinates, stacking, collision handling, focus, z-index, and lifecycle.

```ts
interface EditorWindowContribution {
  id: string;
  placement: EditorWindowPlacement;
  priority?: number;
  render(context: EditorWindowContext): HTMLElement | DisposableView;
  update?(context: EditorWindowContext): void;
  dispose?(): void;
}

type EditorWindowPlacement =
  | { kind: 'document-header' }
  | { kind: 'document-footer' }
  | { kind: 'side-panel'; side: 'left' | 'right' }
  | { kind: 'status-area' }
  | { kind: 'cursor-popover'; mode?: 'stacked' | 'exclusive'; when?: PlacementPredicate }
  | { kind: 'selection-popover'; mode?: 'stacked' | 'exclusive'; when?: PlacementPredicate }
  | { kind: 'range-overlay'; range: SourceRange | DynamicRangeProvider }
  | { kind: 'viewport-overlay'; position: ViewportPosition };

interface EditorWindowContext {
  documentPath: string;
  editor?: {
    hasFocus: boolean;
    selection: readonly SourceRange[];
    mainCursor: number;
    visibleRanges: readonly SourceRange[];
    coordsAtPos(pos: number): DOMRect | null;
    stateReadonly: unknown;
  };
  workspace: WorkspaceAPI;
  commands: CommandRegistry;
}
```

The placement list is a set of host-managed lanes, not fixed pixel anchors. A cursor popover contribution can decide when to appear from `EditorWindowContext`, but the host should still own coordinates and collision policy.

When multiple plugins want the same cursor or selection position, the initial product behavior should be a grouped popover with tabs or sections. For example, if AI suggestions, link previews, and field hints all claim `cursor-popover`, the host should render one shell at the cursor and place each contribution in a tab/section ordered by priority. Passive popovers should stack/group by default. Exclusive popovers should be rare; if two exclusive contributions compete, the host picks the highest priority and records diagnostics for the suppressed contribution.

This avoids z-index wars and unmanaged DOM while still letting plugins build contextual editor UI.

### Properties UI is not a Markdown Live Preview block

The Properties UI should be separate from the Markdown Live Editor. It may be visually mounted above the Markdown document, but it is structured document metadata UI, not a source-backed text projection.

Properties/frontmatter differs from a normal Markdown block because it:

- is valid only as the document metadata region at the top of a file;
- represents typed fields rather than document body content;
- needs validation, schema/type integration, and metadata indexing;
- may be visible, hidden, or raw source depending on settings/plugin state;
- should not inherit Live Preview's default source-slice copy/cut behavior.

A Properties UI should therefore be contributed by the Fields core plugin through an editor-window contribution, likely `document-header`, and should talk to a document metadata/frontmatter service. If the Fields plugin is disabled, the editor falls back to raw frontmatter source. Copy inside the Properties UI should behave like structured UI: copying a value copies that value, copying a row may copy a label/value pair, and raw YAML copy should only happen when the user is explicitly in raw/source mode.

The working name for this non-Markdown surface is `PropertiesEditorRegistration`. The important boundary is that this registration belongs to the editor window/workspace layer, not to `MarkdownBlockRegistration` or `MarkdownInlineRegistration`.

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
- Source-backed task checkbox toggles, currently as built-in inline/list-marker behavior rather than a plugin inline registration.
- Code-block and callout widgets.
- Viewport-bounded widget collection.
- Source-preserving clipboard/cut tests.
- A private block renderer adapter used by code-block and callout widgets.
- App-level `.zbase` embed discovery and rendering outside Live Preview.
- An experimental `MarkdownBlockRegistration` path for fenced-code blocks, external wikilink embeds, and custom block copy/cut behavior.


## Implementation status after the inline/editor-window foundation pass

The first pass from this plan and the two deep research reports is now partially implemented in `@zorid/editor`:

- `MarkdownInlineRegistration` is available from the editor package root and the live-preview barrel.
- Inline registrations can declare built-in task-marker ownership or custom matches, render marks/replacements/widgets, install extensions/keybindings, and customize activation, copy, cut, and paste through host-mediated actions.
- A task-marker inline registration suppresses the built-in two-state task renderer for that editor instance, so plugins can own richer checkbox behavior such as a tri-state `[' ', '/', 'x']` marker.
- Nonstandard task marker states are supported by a bounded line parser for registered task-marker inline syntax while keeping the repo's no-regex parser gate intact.
- Inline copy/cut customization is source-range based and undoable; plugin DOM still does not own durable Markdown edits.
- `EditorWindowContribution` and `EditorWindowPlacement` are available as a separate editor-window surface for non-source UI.
- Editor-window contributions are grouped by host-managed lanes such as `document-header`, `cursor-popover`, and `selection-popover`; stacked popovers share one lane and exclusive popovers suppress lower-priority competitors with diagnostics.
- `PropertiesEditorRegistration` remains a planned Fields/plugin-level registration on top of the editor-window surface; the actual Properties UI and frontmatter metadata service are not implemented yet.

This pass intentionally did not finish every foundation item. The remaining foundation work is block-hook consolidation, built-in widget migration to the block registration path, real editor-window DOM mounting, Properties/frontmatter services, and Reading-view adapters.

## Implementation status after the foundation-completion pass

The next foundation pass added host behavior on top of the initial contracts:

- Inline registrations now honor `selectionPolicy` for source/content/token selections and delegate `custom` selection to `onSelect` with host-mediated actions.
- Inline and block projection actions can now report `open-reference` and `set-ephemeral-state` through editor-level handlers instead of being silently ignored.
- HTMLElement-backed block registrations now receive host-mediated `onActivate` and `onEdit` event handling, and registered blocks can handle paste at the selection head.
- The editor-window contribution API now has a DOM host (`EditorWindowContributionHost` / `renderEditorWindowContributions`) that mounts document-header contributions, grouped cursor/selection popovers, tab/section shells, updates, and disposal.
- The Fields core plugin now exposes a narrow `PropertiesEditorRegistration` skeleton for a `document-header` Properties editor. This remains an editor-window contribution shape, not a Markdown block or inline registration.

Still intentionally deferred:

- Full Properties/frontmatter metadata editing and plugin enable/disable UI integration.
- Real DataViews-powered `.zbase` content rendering inside the editor host; the current foundation only renders a source-backed placeholder and opens the referenced view through host actions.
- Reading-view adapters and table-specific behavior.

## Implementation status after the block/zbase foundation pass

The next foundation pass consolidated the block surface:

- Built-in code-block and callout widgets are now represented as first-party `MarkdownBlockRegistration` instances.
- `defaultLivePreviewWidgetRenderers` remains exported for existing internal/tests, but it is derived from the first-party block registrations rather than a separate private built-in path.
- A default `.zbase` external-reference block registration now renders `![[path.zbase#fragment]]` as a source-backed Live Preview widget.
- `.zbase` widget activation/editing delegates to the host-mediated `open-reference` action, preserving the source text and avoiding widget-owned durable state.
- Plugin/user `.zbase` block registrations suppress the default `.zbase` widget so ownership stays deterministic and duplicate widgets are avoided.

Still intentionally deferred:

- Real DataViews rendering inside the editor-window/desktop host.
- Full Properties/frontmatter metadata editing and plugin enable/disable UI integration.
- Reading-view adapters and table-specific behavior.

## Gaps to close

The missing pieces are:

1. Wire the editor-window host into the real desktop editor window and plugin lifecycle instead of only exposing the package-level host helper.
2. Implement full `PropertiesEditorRegistration` behavior through the Fields core plugin and a metadata/frontmatter service; keep it out of the Markdown block/inline contracts.
3. Upgrade the default `.zbase` placeholder into a real DataViews-backed editor host integration while preserving the external-reference block contract.
4. Decide whether built-in task checkboxes should become a first-party inline registration rather than only a suppressible built-in renderer.
5. Add Reading-view adapters for inline/block registrations after the edit-mode contracts are stable.
6. Add tests that prove Properties/frontmatter enable/disable behavior, real desktop editor-window integration, `.zbase` open/edit/DataViews flows, table-specific behavior, and viewport/performance stress.

## Recommended next step

The next implementation pass should make the non-source editor-window surface usable in the real app host:

1. Wire `EditorWindowContributionHost` into the desktop editor window/plugin lifecycle.
2. Wire the Fields `PropertiesEditorRegistration` skeleton into that host with enable/disable behavior and a minimal metadata/frontmatter service.
3. Connect `.zbase` embed activation/opening to the real DataViews/editor host path, keeping the block registration as the source-backed trigger.
4. Add Reading-view adapters after edit-mode inline/block/editor-window contracts stabilize.
5. Keep tables, broad Properties UI polish, generalized plugin marketplace concerns, and more block families out of the pass unless a test fixture needs a narrow example.

This moves Zorid from a block-only Live Preview plan to a three-surface editor architecture: Markdown block registrations for source-backed blocks, Markdown inline registrations for source-backed inline projections and interactions, and editor-window contributions for non-source UI around the document. The most important invariant stays the same: durable Markdown edits go through transactions, external durable edits go through explicit workspace/plugin APIs, and plugin DOM never owns the document model.

## Relationship to deep research artifacts

These goals are consistent with the deep research direction:

- The research recommends a semantic renderer registry rather than direct DOM mutation.
- The research recommends plugin renderer registration with priority, matching, activation hooks, keybindings/extensions, and preview adapters.
- The research emphasizes that Markdown text must remain the source of truth and durable widget edits should become transactions.
- The research separates Live Preview from Reading view and treats Reading parity as a later adapter layer.
- The research identifies custom Markdown dialect support as a language-layer concern, not something vanilla Markdown can fully cover.

The main extension beyond the research is stronger separation between three extension surfaces: source-backed block projections, source-backed inline projections, and non-source editor-window UI. This is not a conflict; it is a concrete API refinement of the research's renderer/lifecycle direction and keeps Properties/frontmatter UI from being mis-modeled as ordinary Markdown body content.
