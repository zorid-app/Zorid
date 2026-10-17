# Canvas text editing and document insertion checkpoint

This isolated batch begins at canonical `main` checkpoint `54ad814`. It retains
the reviewed linked-note editing host, tab runtime, dirty-save identity guards,
standalone media route, AGPL license and release tooling.

The attachment helper reuses existing image, PDF and native media viewers with
one owned resource boundary per card. Its stylesheet is loaded from the renderer
entry point. The document-input host supplies filtered note/media pickers and
validated local-vault file drag payloads. File inventory is materialized once per
drag event, rather than repeatedly scanning it for each selected file.

The attachment and input-host focused gate passes 27 tests before the final UI
assembly. Isolated helper tests do not establish real PDF pixels, media playback
or native pointer behavior. Text-card configuration currently supplies basic
paths, link opening and list defaults; it does not yet supply the complete linked
file-session wiki/embed/attachment-import services.

The native preview-task conflict is a required integration repair: a delayed
retained Live checkbox can accept a note update after switching to Reading. The
visible Reading preview must refresh to that accepted snapshot so its next task
action uses the correct expected source. The compare-and-set guard itself must
remain intact. The reviewed late-accept refresh repair and its actual-CodeMirror regression are included, without weakening the compare-and-set check.

No public API redesign is included. Native Canvas interaction and complete
reference parity remain separate root-owned verification work.

## Combined verification

The complete assembled UI, attachment and picker/drop host passes its 55-test
focused suite. The final checkpoint includes canonical main through `500c3be`,
including the matching preview fix and packaging collector correction.

The first broad run exposed five existing fixtures that still manipulated the
removed Canvas text textarea, including a deferred-read test that could not
release its gate. Those fixtures were migrated to real CodeMirror transactions
with bounded gates and independently cross-reviewed. Persistence failures,
external conflicts, dirty recovery, docking identity, selection and undo remain
asserted; production behavior was not weakened to satisfy old fixtures.

The final full suite passes all 1,573 tests at concurrency two (45.1 seconds),
with zero failures or skipped tests. TypeScript and production webpack pass;
the build retains three existing performance warnings. Checks ran sequentially
and no dependency installation or native app launch occurred in this lane.

Canvas attachment context-menu details, full text-card wiki/embed/transfer
services, actual transformed native geometry and complete reference parity
remain explicitly outside this verified scope.
