# Canvas file editing and standalone media checkpoint

This branch combines reviewed standalone media routing with Canvas linked-note
preview/editing and its shared NoteBuffer host. Canonical `main` through
`0d65e8f` is included, preserving the AGPL-3.0-only license, media sizing,
publication safeguards, retained tab runtime and guarded saves.

The combined default-factory test opens a real Markdown file card through
Workspace, edits through the shared CodeMirror editor, observes the cached note
editor update, docks the Canvas tab and verifies editor identity, focus and undo.
It then verifies only the referenced Markdown file changed, Canvas JSON stayed
unchanged, and note undo persisted. The focused combined UI/session/host suite
passes all 36 tests; the initial media/docking/embed suite passes 39 tests.

Independent UI and host reviews include task-toggle persistence, read-only and
fragment guards, stale file identity, dirty recovery and clean invalid-session
closure. These are internal feature contracts; no public API redesign is part of
this checkpoint.

Standalone media retains its owned viewer through tab parking/docking and releases
it on teardown. Native controls preserve their browser context menu. Native
playback evidence from canonical main remains separate from this integration lane.

Canvas text cards still use the existing textarea editor. Adding documents, full
selection toolbar parity, fragment editing, transformed pointer geometry and
mobile gestures are not established here. Root owns actual desktop verification.

## Final verification

The frozen editor checkpoint passes all 1,496 repository tests with concurrency
two (43.4 seconds), zero failures and zero skipped tests. The final TypeScript
check and production webpack build pass; the build takes 4.7 seconds and retains
three existing performance warnings. Tests, compiler and build ran sequentially.

New release/packaging commits on canonical main were deliberately not merged
into this editor gate because their additional development dependencies were not
installed in the shared environment. Their separate packaging checks are not
included in the 1,496-test result. No dependency install, native launch or signing
operation occurred in this lane.
