# Core Plugin: Search

## Purpose

Provide user-facing search over indexed Markdown, filenames, headings, tags, fields, and object summaries.

## v0 behavior

- Search panel UI.
- Command palette integration through shell command registry.
- Full-text indexed note search.
- Filename/path search.
- Result snippets and open-on-select.
- Virtualized results.

## Uses

- `SearchAPI`
- `MetadataAPI`
- `WorkspaceAPI`
- `CommandRegistry`

## Acceptance criteria

- Search queries do not scan the whole vault synchronously in the renderer.
- Results are ranked sufficiently for v0.
- Search works after index rebuild.
- Search UI is separate from the search/index service.
