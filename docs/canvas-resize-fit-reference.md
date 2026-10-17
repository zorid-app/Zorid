# Canvas preview fitting and resize auto-pan

This is a bounded continuation of `canvas-resize-reference.md`. It records static reference observations and the original implementation choices for bottom/right double-click fitting and resize auto-pan. It does not establish native layout, pointer or mobile parity.

## Reference identity

The inspected artifact is Obsidian 1.14.4 `app.js`, SHA256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Historical renderer evidence E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; the extraction receipt is `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`. The current retained E3 record and old export were unavailable, so this follow-up used focused ordinary static reads of the previously extracted artifact, not a new REA trace. All offsets below are zero-based Unicode character positions in decoded UTF-8 text.

No reference application was executed or captured. In particular, the available reference app's personal vault was not used. No recovered implementation is copied into the project.

## Preview auto-fit

Single-node handle construction at **3362400–3364100** wires double-click only on the bottom and right edges. The multi-selection frame at **3283300–3283700** forwards those two edge actions to selected nodes. The base-node callback at **3374418** is empty; Markdown-backed behavior is in **3378013–3378950**.

The Markdown callback requires its preview renderer to be shown. Bottom fitting performs at most ten iterations: measure current client height, temporarily collapse the preview height to 1 px, measure scroll height, restore the temporary style, then adjust the card height by the content/client difference plus 1 px. It stops when the difference is smaller than half a pixel. This is a bounded measurement loop, not continuous text autoheight during a drag.

Right fitting holds height fixed, collapses the preview and records its initial scroll height plus a small tolerance. It performs at most ten rounded binary-search width trials between zero and the original width. A final validation rejects a candidate whose content height grew, restoring the original width. The temporary preview style is restored afterward. Trial count and final validation are separate; “ten trials” does not mean ten total layout reads.

The called `resize`/`moveAndResize` helpers at **3365603–3365870** round geometry and mark the node moved. They do **not** apply the drag path's 50-world-unit minimum or aspect correction. Applying those drag rules to auto-fit would change the observed contract. Exact final painted geometry still depends on the renderer and CSS.

Zorid exposes this behavior only for visible Markdown previews in text and linked-note cards. Active Live editors, unavailable/hidden previews, groups and media do not become measurement targets. Multiple eligible cards can fit in one action. Measurement adapters, finite/nonnegative measurement checks, preserved pre-existing inline styles, compare-and-swap validation and a single atomic geometry publication are original Zorid implementation choices. A failed measurement or source collision restores preview geometry without publishing a partial fit. These guarantees do not imply that the reference publishes one undo entry or save per double-click: its inspected loop requests saves while fitting.

## Auto-pan and resize ownership

`handleDragWithPan` at **3347224–3348100** captures the wrapper rectangle once. A real pointer move compares client coordinates against a 30 px inset. Outside distance is clamped independently on each axis to ±40 px. An active interval runs at `1000 / 60` milliseconds; each tick advances the world-space viewport center by the clamped distance times `0.5 / sqrt(currentScale)`.

`panBy`, beginning at **3318457** within **3318434–3318600**, increments both current and target world center coordinates, then marks the viewport changed. This position was rechecked by searching the decoded artifact directly; it is a Unicode character offset, not a byte offset. Consequently the content moves on screen in the opposite direction, with displacement magnitude equal to the clamped distance times `0.5 * sqrt(scale)` per tick. This distinction matters when a host stores screen translation instead of the reference's world center.

The timer does not invoke the wrapped resize-move callback. The inspected `markViewportChanged`/`requestFrame` path at **3326714–3329940** updates viewport transforms, grid, virtualization, dirty renderers, menus and the interaction layer; it does not replay the last pointer event. Hover hit testing at **3335850–3336420** is separately scheduled and suppressed while dragging. Therefore this inspected path leaves node world geometry unchanged between actual pointer events while the viewport pans. The next real move converts its absolute client coordinates using the new viewport position. This is a bounded static finding, not a native event-delivery observation.

Cleanup stops the interval and clears dragging/snap-rendering state. The single-resize cancellation path at **3369861–3371692** restores the original node rectangle and requests a save, but does not restore the viewport center. A completed auto-pan remains after cancellation. The general pointer helper at **873360–874609** distinguishes release/end from cancellation.

Zorid follows the no-synthetic-resize-move rule and retains viewport pan when canceling geometry. Its timer has explicit lifetime and generation guards, including inert retained callbacks after stopping or destruction. This guards the host lifecycle without claiming equivalent browser timer scheduling.

## Snap candidates after panning

The reference resize path at **3369861–3371692** obtains viewport-intersecting candidates on each actual move through **3321374–3321567**. Candidates newly brought into view can therefore participate; candidates moved out of view must stop participating.

Zorid builds a sorted coordinate index from all non-selected node bounds once per gesture, then filters the relevant coordinate window against the **current** viewport on each real move. The index is not rebuilt on every timer tick. This is an original bounded indexing strategy for the observed candidate policy. It does not promise constant-time queries when many candidates share a coordinate, nor does it establish native frame-rate behavior.

## Verification and remaining acceptance

Implementation is isolated in `.worktrees/canvas-resize-fit`, based on `45b7ae8` with original resize `1247482`. Final independent source-repair review reported **34 passing checks**: 22 actual-view tests, eight helper tests, three independent probes and one temporary composed fit-plus-`4ca382f` lifecycle probe. An earlier regression run passed 103 tests: the then-current 18 actual-view tests, eight helpers, 28 prior resize tests and 49 existing view/creation tests. These are separate snapshots, not additive final-suite counts. The author also reported final TypeScript and diff checks passing. The Base draft hook is not in this worktree's base; its temporary composition probe does not replace integration of that separate commit.

The late-measurement regression verifies that replacing the document during the second measurement leaves the replacement DOM correct, rather than restoring stale geometry over it. Another probe verifies rollback when a second card's measurement fails. The independent auto-pan probe retained the same CodeMirror instance across 100 timer ticks and observed zero `document.createElement`, `JSON.stringify` and save calls during those ticks. Those counters do not measure general DOM mutation, layout work, frame time or native responsiveness.

The focused checks cover bounded measurement, style/error rollback, source replacement during measurement, loaded note-session retention, timer cleanup, scale compensation, unchanged geometry between real moves and changing viewport snap eligibility. Synthetic dimensions and timers do not verify real text wrapping, native scroll height, pointer capture, painted snap positions, media playback or touch geometry.

Pending native acceptance uses original disposable fixtures:

1. Double-click bottom/right edges on short and long text previews and linked notes. Check actual wrapping, final width/height, saved Canvas geometry and one-step Zorid undo. Confirm an active Live editor stays untouched.
2. Hold an activated resize near each viewport edge at zoom 1 and 0.5. Check direction/speed, the 30 px interior stop region, no geometry recomputation without another pointer move, and newly visible object snapping on the next move.
3. Release, Escape, cancel capture, switch documents and close the view while panning. Check that callbacks stop, canceled node geometry restores, completed viewport pan remains and stale events cannot edit a replacement document.
4. Verify rich interior scrolling and touch/selected-corner interactions on their real platforms.

Saved snap-setting integration, visible snap guide lines and group-background aspect ratios remain outside this slice. Native measurement, visual comparison and mobile acceptance remain pending. Fenced Base configurations and core/API changes are unrelated to this work.
