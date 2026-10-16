# Bases integration checkpoint

The isolated integration branch combines the reviewed query executor and Table,
Cards, List and Kanban presentation modules. These are original implementations
with bounded reference evidence in their individual documents. Their inclusion
is not a claim of complete Bases support or a production `.base` workspace view.

The query/Table/Cards/List focused suite passes 76 tests; Kanban passes 19 tests,
including actual query output with typed empty groups. TypeScript passes for the
combined modules. Native geometry, interactions, persistence and mobile behavior
are not established by these fixtures.

## Unresolved host boundary

The presentation modules emit tagged `BaseExpressionValue` edit values and accept
query revision tokens typed as string or number. The reviewed controller
accepts raw YAML-compatible `BaseValue` values and generates numeric revisions.
Those values cannot safely be cast between interfaces. No adapter, public API
change or workspace routing has been introduced during this integration pass.

Kanban's presentation capability includes grouping by `file.folder`, while the
controller's property-edit route handles note properties. File moves require a
separate guarded rename route. List-to-scalar grouping transitions lack verified
membership semantics; the controller now rejects a scalar destination for an
existing list-valued group. Explicit whole-list destinations remain supported.
Presentation-to-controller conversion and these host routes remain unwired.

The user requested an architecture discussion before further API design. Existing
module contracts are retained; namespace/data/plugin/sync/mobile API redesign and
new view/controller adapters are deliberately not part of this checkpoint.

## Guarded controller assembly

The reviewed controller and its NoteBuffer lifetime repair are also included.
Controller edits use the workspace-owned buffer contract rather than independent
writes, preserve dirty Markdown drafts, and validate both the action snapshot and
source/target lifetimes. The optional accepted-draft validator survives queued
writes and retries, so a deleted-and-recreated path cannot receive an older edit.
An invalidated draft remains recoverable rather than being silently redirected.
This does not replace native compare-and-write guarantees or establish protection
against external replacements not observed by the vault. Controllers must flush
accepted changes before disposal or preserve the resulting recovery error.
