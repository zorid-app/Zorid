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
  --show-window --cua-native-context-menus \
  --ready bases-native-and-frontend-frozen
```

No build is performed. The output must be fresh with an existing parent outside
source trees. All positive edits use actual visible app controls, hit-tested CDP
pointer input and keyboard input. DOM evaluation only reads/locates controls,
state, accessible names and the owned profile's persisted recovery/session data.
Real Chromium dragstart supplies `Input.dragIntercepted` data; the campaign never
fabricates DataTransfer contents or calls controller/workspace APIs to make a
positive operation happen. File context menus use the actual Electron native
menu, so they are handled by the explicit mixed CDP/CUA mode below.

The native menu flag is admitted only for this exact canonical Layouts campaign,
with the owned window shown. It creates five separate private
`native-context-menu-cua-NNNN-UUID/ready.json` rendezvous and emits
`CUA_NATIVE_CONTEXT_MENU_READY`. Each fresh nonce binds the current exact owned
app PID, executable/profile, one freshly observed visible native window and
renderer, mounted layout and Base tab to an authored request. The request's
`expectedLabels` are expectations, never observations of the native menu.

For every checkpoint, the coordinator must use CUA to inspect the actual owned
native AX menu, assert its exact labels and order, and retain the actual AX
read/screenshot and native input receipt separately. The first, fourth and fifth
menus must show `Open in new tab`, `Bookmark`, `Version history`, `Rename…`,
`Move to trash`, then receive a real click on `Open in new tab`. The second has
the same ordered labels and receives a real `Bookmark` click. The third must
replace only `Bookmark` with `Remove bookmark` and receive actual Escape.
The requested files remain Alpha, Alpha, Alpha, Beta and Gamma respectively.

Only after the actual AX assertion and native input, write the advertised
`{"token":"EXACT_FRESH_NONCE","action":"continue"}` to that checkpoint's
`continueFile`. No observed labels, selected command, value or product result is
accepted in this signal. Each checkpoint has a five-minute deadline, rejects
stale nonces, aliases and changed ready files, and cannot issue input. Existing
exact new-tab identity, persisted bookmark, source, restart and cleanup oracles
remain mandatory after continuing. A runner pass alone does not establish the
native labels/order assertion; final acceptance also requires those five actual
CUA AX/input receipts. This is mixed CDP/CUA execution, not default-CDP or
hardware-input acceptance. No renderer menu fallback or production override is
used. Without the explicit mode, the campaign fails before launching an app.

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
| Failed column-order save | Before the same ordinary header drag, arm the real relay for the exact entry and independently hand-patched complete Board group-order source. Hold its genuine inert preparation, deny only the owned vault.lock inode, release the unchanged reply and require a correlated uncertain checkpoint failure with no logical commit. Exact prior physical/logical Base bytes remain; the board reconciles to its prior visible order with no insertion placeholder. Read-only WAL-aware native checkpoint evidence must retain the exact original base, desired complete configuration, running client, guarded input, plan and unauthorized prepared intent. Restore the exact inode/mode in finally, verify old physical AND logical source/revision, then the original ordinary navigation replays the identical failed CAS and commits the original prepared token once. Reopen shows the saved order, then normal header dragging restores the fixture. No public-directory projection fault or legacy localStorage draft can satisfy this case. |
| Sorted insertion/draft ownership | Alt-arrow in a real number draft retains exact input/focus and does not mutate disk; Escape cancels it; moving Gamma gives exact Beta/Gamma/Delta destination ordering and changes only Gamma's status bytes. |
| Failed move/recovery | Arm the same approved prepared-reply/owned-checkpoint-lock protocol for the exact Alpha entry and literal full desired status/body source before its original card drag. Require the actual uncertain checkpoint failure, unchanged core/physical original, visible move error and card rollback. Its running-client native checkpoint retains exact base/draft/guard/plan and the original unauthorized prepared intent. Restore only the original inode/mode and prove unchanged logical/physical source before the same original navigation retry; the identical failed CAS succeeds before that original token commits exactly once. Full desired source and unrelated sources remain strict. This is a checkpoint-access fault, not a public-file projection failure, arbitrary I/O or power-loss claim. |
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

The two checkpoint-negative cases are source-authored; their actual case results
establish execution. They require the normal non-root user's filesystem access
semantics and the already approved real Recovery relay; no reply bytes, commands
or product objects are replaced. The exact Layouts campaign is the third explicit
relay admission beside Recovery and Safety; provenance remains exactly the three
unchanged Recovery control/protocol/relay sources and generated owned wrapper.
The shared owned-lock helper rejects aliases/hardlinks and restores only its
original open inode in finally. Its correlated native checkpoint failure must
precede any original-intent commit; a pre-capture error or projection failure
cannot satisfy the protocol. The legacy localStorage draft query was retired:
native buffers persist recovery checkpoints in SQLite. Read-only WAL-aware audit
preserves the original exact recovery-source assertion, including its running
client and native intent, without modifying storage or calling private product
state. A missing fault or checkpoint fails the case, without a substitute stub.

The column body's independent source oracle hand-patches only the unique known
Board groupOrder span. It rejects unexpected/ambiguous source format or prior
order before input, does not invoke the product configuration writer, and retains
the existing complete parsed-configuration oracle. Ordinary Alpha navigation
checks input.note-title.value and its actually mounted public Reading/Live Edit
surface; the retired contenteditable .inline-title selector is not used and no
extra focus, mode switch or input is injected. The menu assertion
expects the native host's Version history capability. An unavailable capability
also fails explicitly so the coordinator can assess the actual run conditions.
