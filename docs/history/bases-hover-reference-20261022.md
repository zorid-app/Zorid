# Bases file-hover reference — 2026-10-22

Owner: `bases_docs_model`. Bounded shipped-source follow-up for Base file/link
hover previews, not a global editor-preview implementation or runtime acceptance.
No application was launched; the existing 51-pair reference capture set contains
no executed hover-popup scenario proving the behavior below visually.

Target is Obsidian 1.14.4, ASAR SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`,
`app.js` SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
REA parent:
`ev_bc3040653227bcbb26cfda376133f2839d32de16eeb7692f4e80dd9515129299`.
Private provenance: `/private/tmp/zorid-bases-hover-reference/provenance.json`.
Thirteen prepared inert JS files, 13,535 bytes, 4,377 AST nodes, zero parse
failures; semantic graph capped at 1,000/200 with external dependencies unknown.
An initial Kanban callback preparation stopped inside its nested condition;
the complete callback was retained before the final successful receipt. Recovered
code stays outside the repository.

## Source policy

| Area | Static observation |
| --- | --- |
| Base hover event | Bases registers source `bases` with `defaultMod: true`. Shared file-link and Cards renderers emit `hover-link` on boundary mouseover, including event, source, hover parent, target element and link text. Kanban uses mouseenter and suppresses the event while the body is grabbing. |
| User policy / modifier | The enabled-by-default Page preview plugin uses a saved per-source option when present, otherwise the source's default. `Mod` is Meta on macOS and Ctrl elsewhere. With the default, ordinary hover alone does not open a preview; holding the modifier on entry or pressing it while still over the target can open it. Modifier gating applies to opening, not continuous visibility. Releasing the key alone does not hide an otherwise retained popup. |
| Waiting without Mod | Temporary document listeners cancel the pending modifier opportunity on a click, leaving the target/document, navigation/character input, removed target, or the retained two-second mousemove debounce. The event filter also suppresses touch/synthetic-mouse-like input according to its existing pointer heuristics. This is not mobile/touch acceptance. |
| Default timing | `JZ` defaults to **300 ms** before showing. `E1` begins embed loading after `max(0, waitTime − 100)`, normally **200 ms**, checking hidden/cancelled state first. Content completion is asynchronous; these timers do not guarantee ready content at exactly 300 ms. |
| Pending/show/hide | Leaving before show cancels immediately. Leaving a shown popup schedules a hide after `waitTime` (normally 300 ms); returning cancels that hide. Target hover, popup hover, explicit focus, active-element containment, or a retained descendant keeps it open. |
| Parent ownership | The plugin reuses an existing nonhidden popup for the same target. On show, a popup hides its parent's prior popup and becomes `hoverParent.hoverPopover`; on hide it clears that pointer. This pointer ownership is not automatic Component-child attachment. |
| Placement | Explicit position wins; otherwise the target rectangle anchors the popup. A target taller than 300 px can instead capture pointer position. Placement uses a 10 px gap, prevents overlap, respects RTL/window coordinates and fits the viewport, choosing below/above according to available space. There is no fixed right-side placement rule in these methods. |
| Dismissal/resources | Outside click/contextmenu cancels pending popups immediately and hides eligible unfocused shown popups after 5 ms. Pointer reconciliation runs every 500 ms. Hide clears timers/target listeners, detaches, handles descendant popups, clears parent ownership and unloads; unload disconnects resize observation. Global tracking is removed when no shown popup remains. |
| Content interaction | Markdown embeds initially render unless source mode was requested, but the factory explicitly enables editing. An eligible click can enter the editor and retain focus/keymap ownership. A permanently read-only popup is not the complete inspected reference interaction. |
| Escape / drag | No own Escape or drag-dismiss binding appears in inspected `JZ`/`E1`. The editor scope inherits application behavior; this does not establish global Escape absence. Kanban's grabbing guard is separately observed above. |

Base emitters in these slices omit `sourcePath`; the page-preview handler defaults
that argument to an empty origin. This is a reference call-site fact, not a
reason for Zorid to discard its captured resolved target/subpath or retarget an
asynchronous preview after a rename, revision change or recycled cell.

## Exact scope and remaining validation

Ranges are Python decoded Unicode-character offsets, end-exclusive, not byte or
UTF-16 indexes: Base registration3233013–3233091; shared file renderer
2189653–2190892; Cards3150929–3151084; Kanban3174032–3174219; page-preview plugin
3521396–3523700 and settings3523701–3524360; global tracking2418485–2419425;
`JZ`2419426–2423406; `E1`2549756–2551317; modifier1217900–1218053; pointer filter
854033–854229; placement863193–864570; debounce544936–545544. Provenance retains
raw/prepared hashes and inert declaration/terminator changes.

Keep implementation scoped to Base file-hover integration. Validate plain versus
modified hover, modifier pressed after entry/released after opening, fast leave,
popup enter/leave/focus, target retirement/revision replacement, layout refresh,
dragging and teardown with the actual app. Compare corresponding reference
screenshots before asserting timing/geometry/interaction parity. If an initial
Base-only popup deliberately omits editing or per-source configuration, report
that boundary explicitly rather than claim complete reference behavior. This
audit does not activate a global preview framework or deferred mobile work.

## Actual owned reference pass001 — partial, stopped on first failure

The coordinator subsequently granted an actual reference slot. New evidence is
isolated at `/private/tmp/zorid-bases-hover-runtime-reference-20261022-001`;
the old 51-pair catalog and screenshots were not overwritten. The packaged
launcher loaded the same hashed 1.14.4 archive from the existing owned profile.
Only new synthetic `Hover.base` / `HoverCases/HoverTarget.md` were added. Page
preview was disabled in the old fixture, so it was explicitly enabled for this
pass; the original workspace/plugin settings were captured and restored afterward.

`01-baseline` and `02-ordinary-hover` retain actual PNG, DOM/body, frame, active
element and coordinate snapshots at **1024×800 CSS pixels, DPR2, dark theme**
(2048×1600 PNG). The Base file link's rectangle was x352/y154.516,
74.258×17.063 CSS px; unmodified pointer hover for 700 ms plus capture delay
produced **no popup**. This is the sole completed hover behavior in this pass.

The next Meta-hover input sequence stopped with
**`CDP deadline: Input.dispatchMouseEvent`**. `FIRST_FAILURE.json` retains its
request/stack; no Meta-popup assertion or terminal screenshot was reached. There
is insufficient evidence to attribute that protocol/session failure to reference
source behavior or a particular unjournaled mouse action. Popup geometry,
modifier release retention, entering/editing the body and dismissal remain
unobserved; the static facts above must not be relabeled as completed runtime.

The pass did not restart. Browser.close itself timed out; cleanup verified the
exact disposable profile/PID85786 before SIGTERM and then SIGKILL. `cleanup.json`
records no remaining owned process and a closed debugger endpoint. Initial/final
note and Base source are identical, fixture settings are restored, and the old
capture catalog's hash is unchanged. `report.json`, the two captures, source
snapshots, launch/target/version receipts and cleanup are retained in the new
directory. No real vault or clipboard was changed. A fresh campaign requires a
new coordinated slot and should journal each input acknowledgement before
repeating the missing scenarios; this partial pass establishes no popup parity.

## Actual owned reference pass002 — popup/edit/dismiss observed

A second explicit coordinator slot used a fresh owned process and a new output
folder, `/private/tmp/zorid-bases-hover-runtime-reference-20261022-002`.
The prepared helper passed syntax checks and independent source review before
launch. It journals each CDP send/reply/deadline, per-action acknowledgement and
debugger pause/resume/crash event. The exact archive hash was checked before
launch; the load log confirms the same owned 1.14.4 package. PID1465, start
`2026-10-22 02:28:17` local, used the disposable profile from pass001.
Browser identity is Electron31.6.0/Chrome126.0.6478.234 with the 1.7.4 launcher;
the page title and loaded archive establish the actual 1.14.4 application.

Eight PNG/DOM/frame/input captures completed at **1024×800 CSS px, DPR2, dark**:

| Capture | Actual observation |
| --- | --- |
| `01-baseline`, `02-ordinary-hover` | No popup; ordinary trusted hover waited700 ms plus capture delay. |
| `03-modifier-mouse-hover` | Direct CDP mouse entry with modifier flag4 produced trusted `mouseover`/`mousemove` with `metaKey:true` and opened one rendered popup. No physical Meta-key down was used in this phase. |
| `04-unmodified-mouse-retains` | Trusted `metaKey:false` mousemove at the same target retained the popup. This is mouse-modifier removal, not proof of physical key release. |
| `05-enter-popup-body` | Moving into the rendered paragraph retained the popup without a modifier. |
| `06-enter-popup-editor` | Clicking the paragraph changed the popup to `is-editing`, focused a visible CodeMirror `.cm-content` with `contenteditable="true"`, and retained it. No text was inserted or changed. |
| `07-outside-dismiss` | An outside click followed by700 ms yielded zero popups. |
| `08-hover-before-key` | Ordinary hover again yielded zero popups before the separate Meta-key scenario. |

The rendered popup rectangle was **x352/y181.515625, 452×260.3515625 CSS px**,
below the link rectangle x352/y154.515625,74.2578125×17.0625. Its first paragraph
was x385/y344.8671875,386×24. After entering editing, the popup remained at the
same anchor with **452×340.2578125** dimensions; the visible editable body was
x429/y297.7109375,342×191.0625. These are measurements of this short fixture,
not universal fixed heights. Rendered and editor screenshots were inspected.

Before the final key scenario, a separately retained bounded request refreshed
ordinary pointer entry immediately before keyDown, avoiding an unbounded delay
between helper invocations; the original prepared request was preserved. Both
moves and the Meta `Input.dispatchKeyEvent` acknowledged successfully. After the
750 ms wait, the final DOM `Runtime.evaluate` call9 timed out. No pause, crash or
runtime-exception event was recorded before that deadline. No terminal key-phase
screenshot/assertion was reached; key-after-hover popup state and physical Meta
release retention remain unobserved. This narrows the failure boundary relative
to pass001 but does not establish a reference source defect or its cause.

The first failure was terminal: no further inputs, retry or restart. Browser
close timed out; exact PID/start/profile checks preceded SIGTERM/SIGKILL.
`cleanup.json` records no owned processes, a closed endpoint, unchanged note/Base
bytes, unchanged original51-pair catalog and all four restored configuration
hashes matching their originals. The heavy runtime slot was explicitly released.
New `capture-catalog.json` contains only these eight captures. `report.json`
SHA-256 is `f2a02db9315b765cf264687848f434974c2d9858548f8ac01d7dfd044239a29b`.
These reference observations add no Zorid parity or runtime-acceptance claim;
remaining physical-key behavior stays qualified by static evidence above.
