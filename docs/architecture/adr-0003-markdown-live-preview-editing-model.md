# ADR 0003: Markdown Live Preview Editing Model

## Status

Accepted as product/UX direction; implementation pending phased planning.

## Context

Zorid's markdown editor is a live editor, not a separate source/preview split. Markdown constructs need predictable behavior while users type, navigate, select, copy, indent, and edit nested blocks.

The editor should preserve markdown source while presenting a rendered editing surface. The user clarified these decisions through a feature-grill session after heading live-preview behavior was implemented.

## Decision

Adopt a consistent live-preview editing model:

- Incomplete markdown triggers remain source/plain text.
- Once a supported construct is complete, it renders immediately unless explicitly specified otherwise.
- Decorative source markers are hidden, replaced, or converted into widgets according to element-specific rules.
- Selection generally keeps rendered preview stable.
- Copy preserves markdown source, including hidden markers and indentation.
- Escaped markdown markers stay literal/plain and do not trigger live preview.

## Element Decisions

### Headings

- `#` alone is plain text.
- `# ` activates heading rendering immediately.
- Inactive heading markers hide.
- Caret inside a heading reveals the marker, and the marker/space inherit the heading level style.
- Selection stays rendered; copy preserves source.

### Unordered Lists

- Applies to `- `, `* `, and `+ `.
- Marker alone is plain text.
- Marker plus trailing space immediately renders a bullet list item.
- The raw marker is replaced immediately, including while editing.
- Selection stays rendered; copy preserves the original marker.

### Ordered Lists

- Applies to number plus `. ` and number plus `) `.
- Render as typed once the delimiter and trailing space are present.
- Do not normalize, renumber, or correct user-entered numbers.
- `2. item`, skipped numbers, repeated numbers, mixed delimiters, and nested ordered lists render as typed.
- Enter continuation increments from the current number and preserves delimiter.
- Selection stays rendered; copy preserves source.

### Task Checkboxes

- Supported after unordered and ordered list markers, including `- [ ] `, `* [ ] `, `+ [ ] `, `1. [ ] `, and `1) [ ] `, with checked states `[x]` and `[X]`.
- Partial task syntax keeps the underlying list behavior until the full marker plus trailing space is complete.
- A complete task marker replaces the whole list/task marker with a checkbox widget.
- Checkbox remains rendered while editing and while selected.
- Click toggles source state. Focused checkbox Space/Enter toggles.
- Enter after a task creates the next task unchecked, preserving unordered marker or incrementing ordered marker and preserving delimiter.
- Copy preserves source.

### Inline Styling

- Applies to complete paired syntax for bold, italic, strikethrough, highlight, and inline code.
- Incomplete paired syntax remains source/plain.
- Inactive delimiters hide while content remains styled.
- Caret inside the construct reveals delimiters; delimiters inherit the same style as the content.
- Selection inside content only keeps delimiters hidden; selection touching delimiters reveals them.
- Nested styles combine. Inline code suppresses other markdown inside it.
- Copy preserves selected source.

### Links

- `[Page]` alone is plain text and is not a vault page link.
- Standard markdown links render only after complete `[label](target)` syntax.
- Wiki links are canonical vault page links: `[[Page]]` renders as `Page`, and `[[Page|Alias]]` renders as `Alias` linked to `Page`.
- Wiki links render only after closing `]]`.
- Inactive links hide delimiters/target syntax and show display text.
- Caret inside label, target, or alias reveals full source styled as a link.
- Selection inside visible display text keeps rendered display; selection touching syntax reveals source.
- Copy preserves source.

### Tags

- `#` alone is plain text.
- `#m` immediately renders as a tag chip; the chip remains rendered as the tag grows.
- Tag chips remain rendered while inactive, active, and selected.
- Clicking a chip is reserved for a future tag action.
- Clicking beside the chip places the caret for editing; arrow keys can navigate through source positions.
- Backspace/delete edits source when caret reaches tag positions. If reduced to `#`, the chip disappears.
- Copy preserves exact source, such as `#math`.

### Plain Blockquotes

- `>` alone is plain text.
- `> ` renders blockquote immediately.
- The raw quote marker is replaced/hidden while editing and while inactive.
- Selection stays rendered; copy preserves source.
- Tab adds one quote level (`> quote` to `> > quote`). Shift+Tab removes one quote level; top-level Shift+Tab unwraps to plain text.

### Obsidian Callouts

- Use Obsidian callout syntax: `> [!type] Title`, with foldable forms `> [!type]+ Title` and `> [!type]- Title`.
- `> ` is first a normal blockquote. Callout rendering starts only after full marker plus trailing space.
- Complete callout markers replace immediately; title and body remain editable.
- Known Obsidian callout types and aliases should receive canonical visual styles where available; unknown custom types render as generic callouts.
- No `+`/`-` means normal expanded callout with no collapse interaction.
- `+` means expanded collapsible callout; `-` means collapsed collapsible callout.
- Chevron click mutates only `+` and `-`; it does not add fold markers to normal callouts.
- Collapsed title-only selection copies title line source only. Selection across the collapsed block copies full source including hidden body. Expanded body can be selected/copied independently.
- Callout title/marker lines cannot be indented with Tab/Shift+Tab.
- Callout body Tab adds a nested quote level (`> Body` to `> > Body`); Shift+Tab removes one nested quote level.
- Only quote-prefixed following lines are callout body. Unquoted lines after a callout are outside the callout.

### Toggle Lists

- Use explicit persisted source syntax: `>>+ ` for expanded toggles and `>>- ` for collapsed toggles.
- Typing shorthand `>> ` immediately mutates source to `>>+ ` and renders an expanded toggle.
- `>>`, `>>+`, and `>>-` without trailing space remain plain text.
- Toggling mutates `+` and `-`.
- Toggle headings are supported: `>>+ # Heading`, `>>- ## Heading`, etc. Typing `>> # Heading` auto-converts to `>>+ # Heading`.
- Toggle containment is indentation-based. Child content requires at least one full indentation unit beyond the parent toggle.
- One toggle indentation unit is 4 spaces or one tab. Auto-created child indentation uses 4 spaces. Tabs count as 4 spaces.
- Expanded toggles show children; collapsed toggles hide children and keep title visible.
- Collapsed title-only selection copies title line source only. Selection across the collapsed block copies full source including hidden children. Expanded child content can be selected/copied without copying the parent toggle.
- Empty expanded toggles show the visual-only placeholder `Empty toggle. Click or drop blocks inside.` Clicking it creates/places the caret on a new indented child line.
- Chevron click toggles and mutates source. Title click edits title. Title double-click selects title text. Empty row space after title places the caret at title end. Focused chevron Space/Enter toggles.
- Enter at end of toggle title creates a first child line indented 4 spaces.
- Enter inside child content inserts another indented child line. Empty child lines remain inside the toggle. There is no automatic exit on Enter.
- Enter at the end of a collapsed toggle title expands it and creates the first child line.
- Exiting a toggle uses Shift+Tab or Backspace at logical line start.
- Toggle outdent moves the current block out one indentation level, plus following same-level sibling blocks and their nested subtrees; previous siblings remain. If no children remain, show the empty-toggle placeholder.

### Horizontal Rules

- `---`, `***`, and `___` are valid horizontal rules.
- `--` stays plain text.
- Horizontal rules render only when inactive.
- Caret on the rule line or selection touching the rule line shows raw source.
- Copy preserves source.

## Out of Scope

Do not change these behaviors in the initial refinement pass:

- code blocks;
- images and embeds;
- tables;
- future tag click action implementation.

## Editor-Wide Indentation

- One indentation unit is 4 spaces. One tab counts as 4 spaces.
- Tab/Shift+Tab structurally indent/outdent bullets, ordered lists, tasks, toggles, and paragraphs.
- Normal paragraph Tab indents by 4 spaces and shows an indent guide; Shift+Tab outdents one unit.
- Plain blockquote Tab/Shift+Tab add/remove quote levels.
- Callout title lines do not indent; callout body lines add/remove quote nesting.
- Multi-line Tab indents non-empty selected lines. Blank lines between selected content lines may receive indentation to preserve structure; leading/trailing blank selected lines may remain unchanged.
- Indent guides show for all indented/nested lines, including paragraphs, lists, tasks, toggles, blockquotes, callouts, and nested blocks.
- Indent guides are visual only, active and inactive, and are not copied.

## Consequences

- Implementation should be phased; this ADR defines the product contract, not a single small patch.
- Tests should cover render triggers, active/inactive states, selection/copy semantics, Enter continuation, Tab/Shift+Tab behavior, collapse source mutation, and escaped marker suppression.
- Existing behavior for out-of-scope elements must not be changed accidentally.
- The live-preview engine needs element-specific source preservation and reveal policies beyond simple selection intersection.
