# Core Plugin: Tags

## Purpose

Expose tag navigation and filtering over Markdown tags/frontmatter tags.

## v0 behavior

- Tags panel.
- Tag counts.
- Open search/filter by tag.
- Update from index changes.

## Uses

- `MetadataAPI`
- `SearchAPI`
- `WorkspaceAPI`

## Acceptance criteria

- Tags are indexed from Markdown/frontmatter.
- Tag panel handles large tag sets with filtering/virtualization.
- Tag selection can open matching notes through workspace APIs.
