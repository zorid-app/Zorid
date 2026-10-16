# Bases controller integration

`BaseController` connects `executeBaseQuery` to the existing Vault metadata index.
It is original code; it does not execute recovered reference artifacts. This is
host/controller work, not a claim of native UI or full Bases interaction parity.

The controller supplies immutable query results and versioned editing methods.
Creation, modification, rename, deletion and ready events use one fixed coalescing
window. At most one refresh runs with one queued refresh request. Snapshot failures
publish an error without replacing the last successful result. Semantically
unchanged results retain their version and observer state; replaced file identities
must receive a new version even when their values are equal. Invalidation also
rejects actions waiting in an asynchronous host queue before a new result publishes.

- `editProperty`: changes note frontmatter using the existing YAML editor, preserving
  Markdown body and other fields. Existing keys are matched case-insensitively.
- `moveToGroup`: persists a note grouping property. File and computed groupings are
  read-only. This does not implement visual Kanban order, duplicate list-valued
  membership, view DnD or whole-board interaction parity.
- `updateView`: uses `BaseDocument` to preserve unknown root/view fields and comments.
  An existing dirty base-config buffer is rejected rather than overwritten.
- `renameFile`: requires an injected, ownership-validated rename transaction. There
  is deliberately no direct disk or unguarded `NoteBuffer.rename` fallback.

The host must supply its shared `NoteBuffer` registry through
`createBaseMutationHost`, including existing dirty drafts. It must notify any open
editor panes after a buffer changes. The source transform executes once, against
current text, after awaiting buffer loading. The normal buffer recovery and content
comparison write mechanism handles persistence. A failed flush reports rejection
while keeping the transformed draft; it is never automatically replayed or rolled
back over newer user input.

## Validation and integration boundaries

Tests use actual Vault, MemoryAdapter and NoteBuffer instances, including dirty
editor text, disk conflicts, failed writes, source/target replacement, metadata
updates and queued refresh pressure. Workspace consumption is a separate step:
construct one controller per open base, mount selected view, pass every action's
rendered version, wire the shared buffer registry/pane updates/rename transaction,
and dispose controllers when closing or changing vault.

NoteBuffer now retains an optional accepted-draft lifetime validator through the
actual queued Vault write, retry and disposal. The same-content delete/recreate
regression passes without writing the old edit into the new file. Ordinary later
typing cannot remove a failed draft's guard. Successful complete saves (or reverting
a draft before any write intent exists) release it. Guards are in-memory callbacks;
after a process restart existing recovery still uses saved-content comparison.
External replacements not observed by Vault cannot be assigned an identity token.
An invalidated guarded draft remains recoverable; explicit reassignment to a new
file identity is not implemented by this controller.

Accepted mutation and snapshot validation are separate: the initial action checks
its rendered query version; queued persistence checks source and target lifetimes.
Thus metadata updates from its own first write do not block preserving additional
typing during a slow save. Controller disposal invalidates its pending guarded
writes; closing a view must flush accepted changes before disposal or retain the
resulting recovery error for the user.
