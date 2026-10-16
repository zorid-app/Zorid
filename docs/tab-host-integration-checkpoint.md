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
