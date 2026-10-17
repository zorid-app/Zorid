# PDF menus and per-type Live embed controls checkpoint

The isolated candidate begins at canonical `main` commit `30a59bd` and combines
the reviewed PDF menu implementation/tests (`33253bd`, `3ebb0ca`), PDF link host
(`e87d0c3`) and per-type Live embed controls (`5419069`, `a59e992`). Runtime
upgrades and other embed-type work are separate lanes.

PDF selection, annotation and thumbnail menus receive guarded host link formatting
through standalone viewers, Markdown embeds and Canvas attachments. Link format
uses the audited empty-source policy, preserves destination escaping and rejects
retired file/view/vault owners. The existing PDF renderer owns the actual
selection and document state.

Live embed controls follow the active renderer type, including transitions from
loading or errors. Retired links suppress navigation; a renderer replacement
cannot keep an obsolete Open or copy-link capability alive. Source-edit controls
remain available on renderer failure.

The combined PDF, menu, formatter, actual Workspace host, Live embed, media and
Canvas attachment focused gate passes all 118 tests. Independent combined review
also exercised actual Workspace/CodeMirror PDF-to-note-to-PDF transitions:
retired PDF callbacks became inert, removed note anchors blocked navigation, and
new PDF callbacks addressed the current viewer.

These checks do not certify native menu layout, PDF engine selection geometry,
mobile behavior or complete reference parity. Root owns subsequent native checks.
No public API redesign or runtime dependency change is introduced by this batch.

## Image integration and final verification

The independently reviewed image helper (`4d07711`) and host (`eb6180b`) are
also included. The icon merge retains both the existing Dashboard and new ZoomIn
aliases. Image/Live embed/editor/icon checks pass all 62 tests. Two independent
actual Workspace/CodeMirror probes cover wiki and Markdown image target
selection, replacement by a PDF, PDF source reveal and return to an image; retired
PDF callbacks are inert and exactly one current image toolbar remains.

Canonical main documentation through `09486b4` is included. The frozen combined
source passes all 1,631 repository tests at concurrency two in 44.3 seconds, with
zero failures or skipped tests. Final TypeScript and production webpack checks
pass; webpack takes 4.9 seconds and reports three existing performance warnings.
The full suite, compiler and build ran sequentially.

An independent privacy/credential scan of the source delta examined eight commits
and 25 blob versions, finding no confirmed credentials, private-path references
or binary additions. Final documentation receives a separate delta scan.

The concurrent Electron/runtime upgrade, Canvas playback-focus repair and static
Canvas embed helper are not included. Their separate checks must not be inferred
from this feature checkpoint. No native app was launched in this integration lane.
