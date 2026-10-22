# Supplemental actual Electron layout interactions

**Authored source only; never executed by this implementation worker.** This is
an additional campaign, not evidence that the heavy journey or visual parity has
passed. Run only after the coordinator freezes matching native/frontend artifacts
and grants the one owned Electron runtime slot.

This directory owns its fixture, helper, journey and entrypoint. It depends on the
shared campaign bootstrap from `5c8c8a86` and the explicit layouts allowlist entry
from `efdf623b`. The campaign cannot choose arbitrary modules or mutate the frozen
source. It inherits the normal runner's app identity, disposable-vault guards,
source/artifact hashes, screenshots, failure report and process cleanup.

```sh
node tests/bases-electron-layouts-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-layouts-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

No build is performed. The output must be fresh with an existing parent outside
source trees. All positive edits use actual visible app controls, hit-tested CDP
pointer input and keyboard input. DOM evaluation only reads/locates controls,
state, accessible names and the owned profile's persisted recovery/session data.
Real Chromium dragstart supplies `Input.dragIntercepted` data; the campaign never
fabricates DataTransfer contents or calls controller/workspace APIs to make a
positive operation happen.

Live insertion can move a target element before release. Those cases use
`dropAtLast()` to release at the last successfully acknowledged drag-over point;
they never re-locate the moved target. The helper keeps its existing single
release/cleanup path, so completed drops are not followed by a redundant cancel.
Four offline protocol lifecycle tests cover relocated targets, rejected moves,
missing preview and failed-drop cleanup; they do not establish actual native
drag acceptance.

| Case | Exact oracle |
| --- | --- |
| Cards/List group collapse | Visible path sequence changes from Alpha/Gamma/Beta/Delta to Beta/Delta and back; `aria-expanded`; all five original files stay byte-identical. |
| All layouts modifier/middle opening | Exactly one new active tab in the same pane; original tab IDs/order and Base tab survive; exact note title; no vault bytes change. |
| File context actions | Exact native-host file menu labels/order; Open in new tab obeys the identity oracle; Bookmark persists and changes its action to Remove bookmark; vault bytes unchanged. |
| All layouts file drag | Actual native payload has exactly one `text/plain` value `[[Items/Alpha]]`; List begins from its actual filename link. Cancellation writes nothing. No external receiving-app/Finder claim. |
| Column insertion/cancellation/reorder | Visible column positions and insertion slot change before any save; actual Escape removes the drag state and preserves original config; completed drag saves exact Done/Todo/Later ordering. Cleanup `dragCancel` cannot satisfy the Escape assertion. |
| Normal Group-menu row drag | Uses the toolbar's ordinary Group dialog and actual draggable row grip. Real Tab reaches the source row; visible row positions preview Todo/Done/Later before drop while exact Base bytes remain unchanged. Actual Escape keeps the menu open, restores Done/Todo/Later and the exact source row's keyboard focus before cleanup. A completed drag saves the complete expected parsed configuration; another normal menu drag restores the fixture for subsequent cases. No alternate columns popover or keyboard-reorder substitution. |
| Failed column-order save | The owned vault directory is temporarily mode0555 to make a real atomic Base-configuration save fail. Exact prior Base bytes remain, the board reconciles to its prior visible order with no insertion placeholder, and normal recovery storage retains exactly the intended full configuration source. Permissions are always restored; ordinary navigation retries that exact source, reopening the board shows the saved order, then normal header dragging restores the fixture. This is a separate labeled negative fixture from the card-status failure below. |
| Sorted insertion/draft ownership | Alt-arrow in a real number draft retains exact input/focus and does not mutate disk; Escape cancels it; moving Gamma gives exact Beta/Gamma/Delta destination ordering and changes only Gamma's status bytes. |
| Failed move/recovery | Owned Items directory is temporarily mode0555. Actual save failure leaves original bytes and rolls visual card back; normal recovery storage retains the exact desired transformed draft. Permissions are always restored; normal UI navigation retries and commits exact intended status/body. This is an explicit negative fixture, not a positive filesystem edit or an atomicity claim. |
| Computed-group read-only | Root/group labels are exact; all column New controls are disabled and four cards are non-draggable; no source changes. No typed/null/folder grouping claim. |
| Theme/scale/keyboard | Exact light1180×820DPR1 and dark960×740DPR2 environment; four positive-sized cards stay inside container bounds; Base tab identity remains; actual Tab reaches Alpha's file link and Chromium AX reports role link/name Alpha. Screenshots are observations, not pixel-parity approval. |
| Reference-fixture hover | Exact authored `Hover.base`/`HoverCases/HoverTarget.md` from owned reference002 at1024×800DPR2dark; ordinary hover waits750ms with zero popups; trusted modifier-bearing mouse entry opens exactly one popup, default452px width/left alignment/10px gap, no autofocus; modifier-flag removal and pointer entry retain it; collapsed Properties/Open link controls and rendered text are present. Clicking its paragraph enters a focused editable body. Literal source replacement, normal navigation flush and exact file readback prove the durable edit; the normal note editor shows the same change. Clean outside click and parent navigation dismiss. No font or popup-height pixel oracle. |
| Zorid key hover | Actual Meta keyDown after ordinary entry opens one popup; keyUp alone retains it. This separately labeled Zorid check makes no reference runtime-parity claim because reference002's physical-key phase timed out before a terminal observation. |
| Binary image hover | Separate MediaHover Base opens an actual decoded1×1 PNG using a blob resource URL, with no editable text surface or preview error. Normal navigation dismisses it and exact original PNG bytes remain. This observes the loaded resource, not every bridge read or memory lease counter. |

After these cases, a normal signal-free app quit/restart rechecks exact note/Base
bytes and durable column order. The result's `layoutCases` marks each case passed
only after its assertions finish; failures throw and later cases are unexecuted.
There are no runtime soft-skips or fallback controller mutations.

## Composition and acceptance boundaries

This revision requires the reference-backed Base hover lifecycle and Workspace
factory and live Group-menu row insertion/cancellation implementation to be
composed. All fourteen authored cases fail explicitly if required
source hooks are absent; no missing preview is counted as success. The previous
`LAYOUT-HOVER-001` missing-source entry is removed in favor of positive assertions.
Rich property widgets and pending property-draft close guards belong to the
properties campaign; typed/null/folder moves belong to the session campaign.
Full Obsidian screenshot comparison, OS foreground behavior, mobile, sync and
performance remain separate acceptance.

The List file-drag source hook (`bfba7c3f` plus `d42520a1`) must be composed before
running this revision. A browser document URL fails the same exact Markdown
payload oracle used by Cards/Kanban; source tests do not establish actual native
List drag acceptance.

The two permission-negative cases require the normal non-root user filesystem
semantics. A failure to produce the specified error/recovery draft fails the
case; it is not skipped or replaced with a controller stub. The menu assertion
expects the native host's Version history capability. An unavailable capability
also fails explicitly so the coordinator can assess the actual run conditions.
