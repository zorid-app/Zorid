# Mapped ordinary-editor selection across Base property writes

Source-authored minimal native campaign; actual execution remains required.
One Base and one ordinary Live Edit note occupy separate panes. Real keyboard
navigation establishes a collapsed caret immediately before BRAVO on a plain
body line containing a crab emoji. A Base edit changes score1→123456789, growing
the frontmatter prefix by eight UTF16 units. Clicking the existing note tab
restores ordinary editor focus; the body caret must retain its exact line and
column. Shift+Right then selects BRAVO. A second Base edit changes score→2,
shrinking the prefix by eight units; the same tab focus route must restore the
exact nonempty forward selection.

The only body click is initial setup, before either capture. After capture,
focus returns exclusively through the existing active note tab. No private
EditorView/NoteBuffer APIs or DOM Selection setters establish or restore the
range. `window.getSelection()` and a detached DOM Range read the visible line
prefix only; that Range is never installed as the selection. Exact fixture body
and frontmatter strings independently map body UTF16 positions to source
positions before/after each edit. This separates the hidden frontmatter prefix
from visible DOM text and detects a Unicode code-point/UTF16 mismatch.

Every property save requires the entire independently authored note source,
including unchanged body and unrelated property. Base and registry bytes remain
exact. A normal quit/restart must retain final source, the split tabs, visible
ordinary body and fresh Base score2, followed by another normal quit. Restart
verifies data/UI durability; selection persistence across sessions is not an
acceptance claim. No mobile, dirty-body race, crash, clipboard or OS foreground/
physical-keyboard parity follows from this focused campaign.

Before each single property double-click, a read-only fixture precondition
requires the existing grid/controller to be settled: explicit updating/error/
busy false, matching controller/rendered/widget versions, and no retained cell
editor. Actual selection001 reached its second click while query refresh was
busy with a pending widget despite aria-disabled false. This readiness predicate
does not establish a product cause or alter selection expectations; it waits for
the next intended edit to be available. No extra click, retry, product flush or
private controller call is used. The original pointer action still performs its
ordinary hit/enable checks.

Setup also observes completion of the one Split right action before the one
sidebar note-open click: exactly two current mounted Base grids and the cloned
tab active with a different public DOM tab ID. Note readiness first awaits the
expected title and matching Reading or Live Edit surface. Reading receives one
normal mode switch, then its mounted Live Edit surface is awaited. Actual002
stopped before any caret/range phase after its note click followed Split Enter
by eight milliseconds; retained DOM showed two Bases. The async setup ordering
and a possible product navigation race remain distinct: these test preconditions
do not prove or repair a product cause. No note-open retry or additional click
is added, and all mapping actions/oracles after setup remain unchanged.

After matching source/native/frontend artifacts are frozen and the coordinator
grants the serialized runtime slot:

```sh
node tests/bases-electron-selection-integration/run.mjs \
  --root /absolute/frozen/integration --expected-head FULL_FROZEN_HEAD \
  --native /absolute/matched/preserved/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/NEW_MAPPED_SELECTION_EVIDENCE \
  --ready bases-native-and-frontend-frozen --show-window
```

The existing guarded runner supplies the fresh disposable fixture, exact
source/artifact/campaign provenance, one-GiB gate, actual owned-window evidence,
first-failure diagnostics and process cleanup. Positive actions use ordinary
controls; no app or artifact is implicitly built. The new directory is appended
to the existing canonical admission/provenance list only.

Bounded offline checks:

```sh
node --test --test-concurrency=1 tests/bases-electron-selection-integration/selection-oracle.test.mjs tests/bases-electron-selection-integration/table-readiness.test.mjs tests/bases-electron-selection-integration/setup-readiness.test.mjs tests/bases-electron-integration/owned-fixtures.test.mjs
node --check tests/bases-electron-selection-integration/campaign.mjs
node --check tests/bases-electron-selection-integration/run.mjs
```
