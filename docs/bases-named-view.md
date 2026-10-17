# Named Base view binding

The internal `BaseControllerOptions.viewName` and `BaseSessionOptions.viewName`
options bind an embedded Base to an exact, case-sensitive view name. Each fresh
configuration resolves that name before executing the query; reordering the
configuration cannot publish another view by accident. Duplicate names select
the first exact match, consistent with the existing embed lookup.

`selectedViewIndex` identifies the resolved controller index. The session uses
it when publishing its selector and mounted view; configuration edits use the
same resolved index. Explicit selection of another view retargets the local
name binding. Named selection before the initial configuration is ready rejects
instead of guessing from an empty document. A rejected selection leaves the
previous selector choice intact. A new embedded session still starts with the fragment supplied by
its host. Unbound standalone sessions retain positional selection.

Removing or renaming the selected name publishes a visible missing-view error,
with no fallback. The previous rendered view can remain visible for recovery,
but stale mutations reject. Active, failed, composing and pending property
edit handling remains owned by the existing session lifecycle. Restoring the
name refreshes the view; replacing a mounted renderer still waits until its
active draft is finished or canceled.

Validation covers real Vault/NoteBuffer configuration edits after reordering,
unknown-field retention, case-sensitive missing names and recovery, local
selection, rejected/pre-ready selection, in-flight refresh selection, and a real session draft surviving
reorder/removal. This is an internal integration fix, not native or reference
visual parity verification.
