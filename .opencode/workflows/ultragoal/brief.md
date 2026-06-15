# Markdown Heading Live Preview Behavior

Implement the approved markdown editor heading live-preview behavior.

## Goal

Headings should behave like editable markdown source with rendered live preview:

- `#` alone remains plain text.
- `# ` activates heading rendering.
- Heading content uses existing heading sizing and bold styling.
- When the caret leaves the heading line, the leading marker such as `# ` disappears visually.
- When the caret returns to the heading line, the marker reappears for editing.
- When a heading line is selected or copied, it remains visually rendered while copied text remains markdown source including the `#` marker.

## Constraints

- Preserve document source; live preview must not mutate markdown text.
- Preserve native/source clipboard semantics for selected markdown.
- Avoid renderer-id special cases in generic live-preview filtering.
- Add only optional/default-preserving public range metadata.
- Keep existing live-preview behavior for inline code, links, widgets, task markers, and block previews unless explicitly required by this feature.
- Treat the requested heading trigger as literal `# ` with an ASCII space after 1-6 heading marker characters.

## Approved Ralplan Decision

Add optional `LivePreviewRange.revealPolicy?: 'caret-or-selection' | 'caret' | 'never'`.

- Default `undefined` preserves current behavior, equivalent to `caret-or-selection`.
- Heading marker replacement ranges use `revealPolicy: 'caret'`.
- Heading content mark ranges use `revealPolicy: 'never'`.
- Generic filtering uses the per-range policy rather than hard-coded renderer names.

## Quality Gate

- Targeted primitive live-preview tests pass.
- Selection/widget regression tests pass.
- Typecheck and lint are run, or blockers are recorded.
- Independent code review approves or findings are resolved before marking final completion.
