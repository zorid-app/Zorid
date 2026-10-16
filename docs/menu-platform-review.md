# Browser menu ownership review

Original implementation hardening; this is a source/DOM review of Zorid, not new runtime evidence of Obsidian behavior. Reference menu labels/order remain in the individual reference reports.

## Reproduced failures and fixes

The independent temporary probe `/private/tmp/zorid-menu-review-20261016/probe.ts` exercised the original platform module in jsdom:

- A backward content selection at anchor 5/focus 1 returned as anchor 1/focus 5 after dismissal. The browser menu now captures immutable endpoint nodes/offsets and anchor/focus direction, and constructs fresh ranges only during valid restoration.
- Replacing the selected text node with identical text while a menu was open moved a cloned live Range to its connected parent at offset 0. The old connected-node check therefore restored a collapsed selection. Detached/reparented/changed endpoints now invalidate restoration; a newer DOM selection is left alone.
- A Cut menu opened on an input with selected offsets 0–3 executed against a replacement value `NEW DOCUMENT`, producing ` DOCUMENT` in a controlled execCommand stub. Browser role emulation now validates original target connection, parent, content-editable setting, input value/type/editability or owner text and original selection endpoints. It validates again after focusing, because synchronous focus handlers may replace the source. Invalid commands dismiss without execution. Callers still own validation of custom action IDs.
- A disabled-only menu left the input focused and did not prevent a printable key's default. The menu container is now focusable when it has no enabled rows, and the menu consumes keyboard defaults until dismissal. jsdom establishes focus/default cancellation; it does not simulate browser typing.
- Hovering an ordinary sibling while a submenu child was focused removed the active element and left focus on BODY. Hover now moves focus to the sibling (or parent panel for a disabled row) before removing child panels.
- Removed menu row handlers now ignore delayed clicks once the menu settles. Edit roles also reject execution when focus has moved outside the menu; keyboard handling releases ownership and preserves the new focus.
- Independent review reproduced a throwing browser command leaving its promise unresolved and keyboard handlers installed. Commands and restoration failures now dismiss safely; finalization removes the menu/listeners and resolves in a finally block.

These checks deliberately reject stale DOM instead of guessing how source offsets map to replacement nodes. An unchanged CodeMirror document can still redraw nodes; restoring logical CodeMirror selection across such redraws belongs to the owning editor, not this generic platform layer. No reconstructed proprietary source is included.

## Native bridge review and remaining contract

The desktop controller validates exact descriptor shapes, finite coordinates, unique bounded IDs, permitted roles, nesting and total item count. Native popup state is owned by a BrowserWindow; replacing a popup, closing its window, renderer destruction/process loss, or main-frame navigation settles and cancels it. The main-process sender gate restricts calls to the trusted main frame of the current single renderer window. Splits are in that renderer; this review does not establish multiple-window support.

Native edit roles execute inside Electron and return no guarded action ID. Browser safety checks do not protect those OS commands. A caller that changes the document, selection owner, editability, or input value while a native role menu is open must dismiss the menu **before** the change. Workspace teardown/vault replacement already call dismissal; all remaining editor/input transition paths require a separate lifecycle integration audit. An alternative is implementing guarded action IDs with an explicit clipboard/edit host; this patch does not silently change native clipboard semantics.

Coordinates are multiplied by webContents zoom and clamped to content bounds. Existing injected-controller tests exercise this contract. Physical native popup placement, OS role focus behavior, zoom/display scale combinations, mobile browser interaction and visual menu layout were not verified here.

## Validation

`node --test tests/context-menu.test.ts` covers ordinary/native bridge routing, selection and keyboard behavior plus the reproduced regression cases. TypeScript no-emit checking passes. Tests use the DOM and controlled command callbacks; they do not launch a browser, Electron, or the reference application.
