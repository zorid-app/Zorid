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

| Case | Exact oracle |
| --- | --- |
| Cards/List group collapse | Visible path sequence changes from Alpha/Gamma/Beta/Delta to Beta/Delta and back; `aria-expanded`; all five original files stay byte-identical. |
| All layouts modifier/middle opening | Exactly one new active tab in the same pane; original tab IDs/order and Base tab survive; exact note title; no vault bytes change. |
| File context actions | Exact native-host file menu labels/order; Open in new tab obeys the identity oracle; Bookmark persists and changes its action to Remove bookmark; vault bytes unchanged. |
| Cards/Kanban file drag | Actual native payload has exactly one `text/plain` value `[[Items/Alpha]]`; cancellation writes nothing. No external receiving-app/Finder claim. |
| Column insertion/cancellation/reorder | Visible column positions and insertion slot change before any save; actual Escape removes the drag state and preserves original config; completed drag saves exact Done/Todo/Later ordering. Cleanup `dragCancel` cannot satisfy the Escape assertion. |
| Sorted insertion/draft ownership | Alt-arrow in a real number draft retains exact input/focus and does not mutate disk; Escape cancels it; moving Gamma gives exact Beta/Gamma/Delta destination ordering and changes only Gamma's status bytes. |
| Failed move/recovery | Owned Items directory is temporarily mode0555. Actual save failure leaves original bytes and rolls visual card back; normal recovery storage retains the exact desired transformed draft. Permissions are always restored; normal UI navigation retries and commits exact intended status/body. This is an explicit negative fixture, not a positive filesystem edit or an atomicity claim. |
| Computed-group read-only | Root/group labels are exact; all column New controls are disabled and four cards are non-draggable; no source changes. No typed/null/folder grouping claim. |
| Theme/scale/keyboard | Exact light1180×820DPR1 and dark960×740DPR2 environment; four positive-sized cards stay inside container bounds; Base tab identity remains; actual Tab reaches Alpha's file link and Chromium AX reports role link/name Alpha. Screenshots are observations, not pixel-parity approval. |

After these cases, a normal signal-free app quit/restart rechecks exact note/Base
bytes and durable column order. The result's `layoutCases` marks each case passed
only after its assertions finish; failures throw and later cases are unexecuted.
There are no runtime soft-skips or fallback controller mutations.

## Explicit unresolved source coverage

- `LAYOUT-HOVER-001`: the authoring baseline's Workspace does not supply the
  layout hover callback. Reference modifier/delay research and a named lifecycle
  owner must land before positive hover-preview acceptance can be added. Absence
  of a preview is never counted as success.
- `LAYOUT-LIST-DRAG-001`: List does not route file dragging through the shared
  Workspace callback. Its ordinary anchor's browser document URL is not accepted
  as a correct Markdown file-drag payload. This campaign does not disguise that
  source gap as a passing arbitrary-payload observation.

Both remain in `result.json.layoutScope.unresolved` even if all nine authored
cases pass. Rich property widgets belong to the properties campaign; typed/null/
folder moves belong to the session campaign. Full Obsidian screenshot comparison,
OS foreground behavior, mobile, sync and performance remain separate acceptance.

The permission-negative case requires the normal non-root user filesystem
semantics. A failure to produce the specified error/recovery draft fails the
case; it is not skipped or replaced with a controller stub. The menu assertion
expects the native host's Version history capability. An unavailable capability
also fails explicitly so the coordinator can assess the actual run conditions.
