# Same-window tab host integration checkpoint

This checkpoint installs the reviewed docking controller and retained tab-view
runtime in Workspace, with the docking preview stylesheet loaded by the main
renderer entry point. It is based on canonical `main` commit `c656637`, retaining
the Bases/NoteBuffer save guards, Canvas own-save history repair, and local-media
CSP correction.

Loaded tab content can be parked and restored or moved between panes without
reconstructing its editor/view. Callback ownership moves with the tab. Cached
views participate in external updates, flush, unload checks and disposal. The
focused integrated workspace, runtime, docking and split suite passes all 158
tests with test concurrency one. Tests exercise real CodeMirror retention and
source updates, while some resource views use injected factories.

This is same-window integration only. Cross-window transfer/tear-off, native
pointer geometry and mobile behavior are not established here. The new Bases
view/controller adapter and production routing remain unwired; no public API
redesign is included. Root owns subsequent native verification.

## Reviewed lifecycle repairs and final checks

Independent review found and corrected two integration issues before the final
checks. Clean externally deleted cached tabs now retire their resources before
their paths are cleared; dirty Markdown, pending Canvas edits and failed flushes
retain their owners for recovery. Unrelated vault topology changes preserve warm
embedded PDF/media viewers. Actual dependency changes in parked views are
coalesced until reconnection, with stale async results rejected and bounded
pending-set cleanup.

The checkpoint also incorporates canonical `main` through `2d41b32`, including
reviewed file labels and audio sizing, plus the reviewed explorer focus repair
`973b6d9`. No standalone media workspace route or Canvas file-card editor changes
are included.

All 1,454 repository tests pass with test concurrency two (35.8 seconds), with
zero failures or skipped tests. The final TypeScript check passes. The production
webpack build passes with the existing three performance warnings. Tests, compiler
and build were run sequentially; no dependency install or native app launch was
performed in this integration lane. Native drag, layout and interaction checks
remain a separate root-owned verification step.
