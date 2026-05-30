# Live Editor Goals

## Product goal

Zorid's editor should be a Markdown-native live editor where Markdown text remains the durable source of truth, while Live Preview renders richer projections over that source. The editor should support ordinary Markdown authoring, Obsidian-style Live Preview behavior, first-party structured blocks, and plugin-provided blocks without turning the document into a hidden rich-text model.

## Capabilities the editor should support

### 1. Source-backed Live Preview

The editor should hide or visually transform Markdown syntax when the user is not actively editing that syntax, and reveal the exact source when selection, focus, or explicit activation intersects the rendered projection.

Required behavior:

- Markdown source remains canonical.
- Preview widgets and decorations are projections only.
- Copy, cut, undo, redo, save, and external file sync operate on Markdown text.
- Selecting or activating a previewed element reveals the relevant source range.
- If a syntax shape is unsupported or ambiguous, it should stay raw rather than render an inconsistent pseudo-preview.

### 2. Inline and block renderers

The editor should support both simple inline renderers and structured block widgets.

Examples:

- Inline marks/replacements: headings, emphasis, inline code, links, wiki links, tags, highlights.
- Source-backed interaction widgets: task checkboxes.
- Block widgets: fenced code blocks, callouts, future timeline/calendar/custom blocks.

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

The exact syntax does not have to be one-size-fits-all, but every supported shape should normalize into a common block match model.

### 4. External-reference blocks

The editor should also support blocks whose definition lives in an independent file, while the current Markdown file contains an embed/reference to that external definition.

Example:

```markdown
![[.zorid/views/tasks.zbase#open]]
```

This should render as a live block in the editor, but source reveal and clipboard behavior should preserve the embed syntax in the current Markdown file. The external file remains the durable definition for the rendered content.

### 5. Plugin-defined blocks

Plugins should eventually be able to register their own inline-defined blocks and external-reference blocks.

A plugin should be able to declare:

- what syntax it recognizes;
- how matches are converted into normalized block definitions;
- how to render the block widget;
- how activation/source reveal should work;
- which source range is copied/cut;
- what source mutations are allowed;
- whether extra CodeMirror extensions/keybindings are needed;
- how, later, the same semantic block can be rendered in Reading view.

Plugins should not directly mutate the editor content DOM. The editor host should own decoration/widget composition, ordering, source reveal, clipboard behavior, history boundaries, and error handling.

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
  clipboardSource: 'document-source';
  atomic: 'none' | 'widget';
  meta?: Readonly<Record<string, unknown>>;
}
```

### Public registration API

Because the editor has no external consumers yet, Zorid can design the public editor API now and revise it while first-party blocks prove the shape.

A target API could look like this:

```ts
interface MarkdownBlockRegistration<Match extends MarkdownBlockMatch = MarkdownBlockMatch> {
  id: string;
  priority?: number;

  syntax:
    | { kind: 'fenced-code'; info: string }
    | { kind: 'container'; marker: string; name: string }
    | { kind: 'embed-reference'; extensions?: readonly string[] }
    | { kind: 'custom'; match(context: MarkdownBlockMatchContext): readonly Match[] };

  render(match: Match, context: MarkdownBlockRenderContext): WidgetType | HTMLElement;

  activate?(match: Match, context: MarkdownBlockActivateContext): void;
  mutateSource?(command: string, match: Match, context: MarkdownBlockMutationContext): TransactionSpec | null;

  clipboard?: {
    copy?: 'document-source' | ((match: Match, context: MarkdownBlockClipboardContext) => string);
    cut?: 'document-source' | ((match: Match, context: MarkdownBlockClipboardContext) => string);
  };

  extensions?(): readonly Extension[];
  keybindings?(): readonly KeyBinding[];
  readingViewAdapter?(): unknown;
}
```

The first implementation can keep many context types small and internal. The important decision is to make first-party and plugin blocks use the same registration path.

### Matching strategy

Prefer parser-backed matching over ad-hoc regex scanning.

Recommended layers:

1. Use CodeMirror/Lezer Markdown as the base parser.
2. Add Zorid syntax extensions for known syntax families: wikilinks, embeds, callouts, tags, highlights, frontmatter, and future block forms.
3. Match common block syntaxes from syntax-tree nodes where possible.
4. Allow a custom matcher escape hatch for early plugin experimentation, but keep it bounded by visible ranges and source preservation rules.
5. Keep unsupported or ambiguous syntax raw.

### Unified built-in block families

Start with these built-in families:

1. `fenced-code` inline-defined blocks.
2. `callout` inline-defined blockquotes.
3. `.zbase` external-reference blocks from `![[path.zbase#view]]`.
4. One simple first-party custom inline block, such as `timeline`, to prove the API is not special-cased to current widgets.

### Source and history invariants

Every durable edit must become a CodeMirror transaction over Markdown source or over the external definition file through an explicit command path.

Rules:

- Widget-local UI state may be ephemeral.
- Durable document state must live in Markdown text or in the referenced external file.
- Copy/cut defaults to the current document source slice.
- Undo/redo should not depend on widget DOM state.
- External-reference widgets should reveal/copy the reference syntax in the current document, not silently copy the external file contents unless a block explicitly opts into a separate command.

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
3. Live Preview rendering for external-reference blocks such as `.zbase` embeds.
4. A first-party custom inline block proof that is neither code block nor callout.
5. Parser support for embed references and any chosen custom block syntax.
6. Tests that prove source reveal, clipboard, undo/redo, viewport bounds, and fallback/raw behavior across both block definition models.

## Recommended next step

The next implementation pass should be a public-internal block API pass:

1. Introduce the normalized `MarkdownBlockMatch` / `MarkdownBlockDefinition` model.
2. Introduce `registerMarkdownBlock` or an equivalent block registration facet inside `@zorid/editor`.
3. Port existing code-block and callout widgets to that registration path.
4. Add `.zbase` embed Live Preview as the first external-reference block.
5. Add one tiny inline-defined proof block, likely `timeline`, only after code-block/callout/.zbase are using the common path.
6. Keep Reading view parity, tables, properties editor, images/embeds beyond `.zbase`, and generalized plugin marketplace concerns out of this pass.

This moves Zorid toward plugin-defined blocks while keeping the core invariant simple: Markdown text or the referenced external file is the source of truth; Live Preview is the projection layer.
