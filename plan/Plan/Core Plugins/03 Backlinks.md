# Core Plugin: Backlinks

## Purpose

Show inbound links and unresolved references for the active note.

## v0 behavior

- Backlinks panel.
- List linking note, heading/context snippet, and link text.
- Update when active file changes.
- Update after index changes.
- Show unresolved links separately if useful.

## Uses

- `MetadataAPI`
- `WorkspaceAPI`
- `EventBus`

## Acceptance criteria

- Backlinks are derived from the index, not ad-hoc file scans.
- Opening a backlink navigates to source note/location.
- Panel remains fast for large backlink sets via virtualization or pagination.
