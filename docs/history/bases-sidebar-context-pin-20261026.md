# Sidebar Base current-note pinning

Implementation record, 2026-10-26. Source and focused tests are complete; native
Pin acceptance and final integration remain separate requirements.

The right sidebar exposes **Pin sidebar Base** and **Unpin sidebar Base** with
an accessible pressed state. A pin holds the file used by `this` while the main
pane changes. It does not freeze that file's properties: ordinary updates to the
same file remain visible. Blank and non-file main tabs select explicit null;
a main Base or other file remains a real current-file context. Undefined current
context still means the standalone Base's normal default.

Pin and Unpin first settle the existing session's accepted writes. An unfinished
draft refuses the change and retains its input and pin state. The sidebar is
temporarily inert and the pin control is disabled during that transaction;
already accepted writes retain their existing ownership. A newer sidebar
selection cannot inherit a pending pin. Unpin immediately catches up to the
latest main pane, including a pane activated while the save was finishing.
The control also disables immediately while sidebar replacement drains accepted
writes, and reenables if an unfinished draft refuses that close.
Pin's successful flush retires only that session's clean toolbar, property,
summary and renderer portals before awaiting its new current-file query. These
portals can live outside the sidebar host, so making the host inert alone would
leave keyboard activation able to admit a new draft. Dirty or failed panels are
retained and refuse the change; ordinary flush callers retain their behavior.

Pin state and the pinned context are saved in the existing window/vault workspace
state. They survive a normal restart even if another main note is active, or if
the sidebar was showing Outline at shutdown. A newly chosen Base starts
following the current main note. A known source or current-note rename preserves
the existing pin. Stable entry identity, when provided by the adapter, prevents
a same-path replacement from becoming the pinned note before query, summary or
context acknowledgement. Missing or replaced pinned notes resolve to null until
the user unpins; their recorded identity is retained for restart. Legacy adapters
use the existing live file token. Without a persisted stable identity, legacy
cross-restart path identity is not established by these tests.

## Reference and deliberate choices

The static reference is Obsidian **1.14.5**, profile ASAR SHA256
`3a349274f789b62c5b35ad19de10311909a94e8783033569c2210a4bac491780`;
`app.js` SHA256
`95b9fd3944625c3b88116878b03d655147fed8cdfe6ddf931f2064ead78ccd5b`.
Bounded REA evidence `ev_a4aa83d7aab366019f4925f483acff47263bf5eeb7f3854d1fad70534f24f1d0`
and `ev_857b23aa657ef1099db786bcd70cc556c7aa6e004b78965dcd1b3fcefb4c9d47`
cover fourteen inert slices, 3,980 bytes, with no parse failures. The private
provenance is under `/private/tmp/zorid-obsidian-pin-semantics-20261026-002`
and its `-extra` sibling. No proprietary source is included here.

The inspected Base file-open handler skips current-file updates for a pinned
leaf. The generic leaf pin action changes pin state, header state and saved
layout; the inspected path does not explicitly catch up the Base context on
Unpin. Sidebar leaves already disable ordinary file navigation. This establishes
the context-freeze starting model, not observed runtime pin behavior or broad
tab-pinning parity. Linked/grouped reference leaves have separate update routes.

Zorid deliberately refreshes immediately on Unpin and explicitly persists the
frozen context with the pin. The focused reference inspection does not prove
those two behaviors in Obsidian. The header button keeps this scoped capability
available without introducing generic main-tab pinning.

## Verification boundary

Actual Workspace/BaseSession/NoteBuffer regressions exercise public Pin controls,
query rows, normal restart, lazy restoration, null and main-Base contexts,
retained drafts, an accepted save held at its normal adapter write, latest-pane
catch-up, superseding sidebar selection, known renames and same-path replacement.
A separate shared-query contract suite covers explicit null request omission,
standalone defaults, saved and preview requests, summary witnesses and identity
checks before and after asynchronous reads. These are module-level tests, not
actual native UI or Rust query acceptance.

The authored native sidebar Pin campaign must still run against matching built
artifacts. The existing thirty-two-row sidebar race remains unchanged and must
pass independently; this feature's focused tests do not replace that gate.
