# Saving and local recovery

[Architecture](README.md) · [Storage](storage.md) · [Sync](sync.md)

## Current save path

TypeScript NoteBuffer owns loaded text, scheduled writes, conflict state and the
saved baseline. Durable note state retains request identity/checkpoints and settles
host receipts. Native Rust commits source state and separately publishes ordinary
files. A publication can be recoverable/pending even after database commit.

The current native publication algorithm stages new content and moves the old
file to a UUID `.previous` path before replacement. It retains that old inode to
observe late writes through external handles. Completed attempts can continue to
inspect retained files. This is current implementation, not the desired final
snapshot-history design; accumulated artifacts and the import-status banner are
open user findings.

The banner reports incomplete scan/reconciliation; its presence alone does not
prove that the open note failed to save. Diagnose its actual status and retained
versions rather than hiding a real unresolved recovery condition.

## Accepted recovery behavior — implementation pending

The user wants this subsystem to match the inspected Obsidian autosave/File Recovery behavior:

- Roughly two-second coalesced autosave, plus blur/close/graceful-quit flushes.
- No accumulating per-save `.previous` files.
- Separate periodic File Recovery snapshots: five-minute interval, seven-day
  retention, unchanged-content deduplication and automatic expiry.
- Best-effort immediate capture of intended text after a catchable save failure.
- Version selection/preview and explicit restoration through the ordinary save path.

Snapshots belong in per-vault app-local `recovery.sqlite`, not the vault authority
DB and not synced history. A committed snapshot survives restart; this does not
make every keystroke durable or promise that an abrupt pre-autosave crash loses
nothing. Native suspension and browser lifecycle limits need explicit behavior.

Shared Rust recovery services should own content/hash/retention semantics; the
editor supplies change/save events and the recovery UI. The unified SQLite layer
provides persistence. A save-strategy change must reconcile current database/file
projection and external-writer guarantees before cutover; replacing projection
with direct writes is not a safe isolated filename change.

## Before implementation

Reproduce the reconciliation warning, account for current completed/pending
artifacts, specify cleanup/retention, and verify save/reopen/restart with external
changes. Preserve existing recovery evidence until its obligations are settled.
Synced version history remains a separate future decision from local File Recovery.

## Source map

[NoteBuffer](../../src/ui/note-buffer.ts),
[durable lifecycle](../../src/ui/note-durable-state.ts),
[publication](../../crates/zorid-native/src/native.rs),
[namespace handoff](../../crates/zorid-native/src/publication_handoff.rs),
[import status UI](../../src/ui/import-status.ts).
