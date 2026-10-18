# Canvas edge and corner resize: reference and acceptance

This records a bounded static audit of Obsidian 1.14.4 and the original Zorid implementation at `1247482e1807cd500e51e30dcc974c5689b0dd61`. Reference observations, implementation tests and native acceptance are separate. No recovered implementation or assets are included, and no reference application was executed or captured for this audit.

## Evidence identity and limits

The extraction receipt is `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`. Historical renderer analysis E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. Its current-session retained record and old exported bundle were unavailable. This audit reused the extracted artifact, checked its hashes and performed focused ordinary static reads; it is not a new REA runtime trace.

- `app.js` SHA256: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css` SHA256: `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
- Containing ASAR, from the extraction manifest: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.

All offsets below are **zero-based Unicode character offsets in decoded UTF-8 text**, not byte offsets. They identify this exact build. Theme overrides, native pointer dispatch, touch geometry and actual history timing remain runtime questions. The available reference app contained a personal vault; it was not opened or captured for verification.

## Static reference contracts

| Behavior | Observation | Anchor |
| --- | --- | --- |
| Eight targets | Four full-span edge targets and four corners. Top/bottom use `ns-resize`, left/right `ew-resize`, and corners the corresponding diagonal cursor. Side targets straddle the border. | `app.js` 3362400–3364000, 3369861–3371692; `app.css` 555257–557887 |
| Hit width and zoom | Nominal world hit width is 20 px times the zoom multiplier. The settled multiplier is the inverse square root of scale, giving screen width 20 times the square root of scale; it is not a constant screen hit width. | `app.css` 541796 and 555257–557887; `app.js` 3328345 |
| Pointer ownership | Primary mouse button starts resize; a nonmouse pointer requires the node to be selected. Multi-selection uses an outer selection frame rather than each selected node's handles. Mobile styling limits handles to corners; readonly styling hides them. | `app.js` 3369861–3371692, 3284297–3286789; `app.css` 555257–557887 |
| Coordinate mapping | Resize uses the current pointer's absolute world coordinate, with the initial opposite edge anchored. It does not preserve the pointerdown offset inside a wide handle. Client coordinates are translated relative to viewport center, divided by scale, then offset by the Canvas position. | `app.js` 3320596–3321110, 3369861–3371692 |
| Threshold and minimum | Drag activates at a 5-screen-pixel distance. The minimum dimension is 50 world units, applied before aspect correction; this does not establish that both final dimensions always remain at least 50 for extreme aspect ratios. Resulting geometry is rounded. | `app.js` 873360–874609, 3305903, 3365670–3365870, 3369861–3371692 |
| Multi-selection | Explicitly selected nodes scale proportionally within their collective bounds. Minimum outer dimensions account for the smallest relative node dimensions. Aspect locking defaults on when any selected node has a runtime aspect ratio; Shift toggles that choice. A pure text selection starts unlocked. | `app.js` 3284297–3286789 |
| Group bounds | Resizing a single group changes its own bounds; it does not implicitly scale contained cards. Group contents participate in multi-resize only when explicitly selected. | `app.js` 3395483–3399800, 3284297–3286789 |
| Media aspect | Loaded image/video dimensions establish runtime aspect ratios. A group background can establish a ratio when its background style is `ratio`. No serialized generic aspect field was established, and no single-node Shift aspect toggle was observed. | `app.js` 3382860–3383388, 3398820–3399230, 3369861–3371692 |
| Snap defaults and bypass | Object and grid snapping default on. Mac Control or non-Mac Alt disables snapping. No symmetric Alt-resize behavior was observed. | `app.js` 3421325–3421460, 3346562 |
| Grid | Grid size is 160, 80, 40 or 20 world units at logarithmic zoom boundaries −3.3, −2.16 and −0.91. | `app.js` 3320280–3320480 |
| Object snapping | Active edges/corners compare relevant coordinates against other viewport-intersecting nodes, excluding selected nodes and including groups. Candidates are bounding-box corners and center. Nearest x/y coordinates are chosen independently, without requiring perpendicular overlap, within `ceil(15 / scale)`; object snaps precede grid fallback. | `app.js` 3277398–3277712, 3281214–3282535, 3321374–3321567 |
| Text sizing | Ordinary drag calls the preview renderer's resize path, without continuous content autoheight. Bottom/right double-click fit visible preview content using bounded measurements; active Live/hidden preview is a different state. Only those two edges have this double-click route. | `app.js` 3378003–3379190, 3362400–3364000 |
| Auto-pan | Dragging near the viewport edge can pan the Canvas; this is a separate gesture helper. | `app.js` 3347224–3348100 |
| Cancel and history | The drag helper distinguishes end from cancellation. Single-node cancellation restores the captured rectangle; end/cancel request a save. Save/history processing includes debounce, so these source reads do not establish exactly one native undo entry per gesture. | `app.js` 873360–874609, 3369861–3371692, 3317058–3317200 |

## Zorid implementation and recorded verification

The original implementation is in `src/canvas/resize.ts`, `src/canvas/view.ts` and `src/canvas/view.css`. It provides eight handles, a multi-selection frame, absolute world-pointer geometry, the activation threshold, minima, intrinsic loaded image/video ratios, proportional multi-resize with Shift toggling, and default grid/object snapping with platform bypass.

Preview updates existing card/edge DOM without committing document changes. Release performs one atomic geometry transaction after checking the original target records. Cancellation discards the preview. Unknown record fields survive; ambiguous or changed target records are rejected. Tests exercise exact-source undo, failed persistence/retry, retained rich editor/media owners and duplicate-ID collisions. These are Zorid acceptance choices; its atomic undo guarantee is not a claim about the reference application's native history timing.

Recorded author and independent-review results for the implementation snapshot:

- 28 resize/helper tests passed in `tests/canvas-resize.test.ts` and `tests/canvas-resize-geometry.test.ts`.
- Four independent review probes passed: loaded media/single and mixed-selection aspect behavior; pure-text multi-selection and pointer-move operation counts; same-source acknowledgement versus replacement/capture cancellation; and target-record lookup scaling. Another 49 existing Canvas tests passed. TypeScript and diff checks passed. These counts are reported by the implementation owner and independent reviewer, not a new full-suite run performed for this document.
- Review identified quadratic target-record resolution: the initial 96-target pointerdown probe performed 9,216 indexed record reads; the repaired probe observed at most 480. The helper resolves targets in one record scan; its 10,000-target regression reads 10,000 records.
- The independent pointer-move probe observed zero `document.createElement`, `JSON.stringify` and save calls during 100 moves after activation. This is bounded operation-count evidence, not an absence of DOM mutations/layout work or a frame-rate/native latency measurement.

## Remaining gaps and native acceptance

The implementation does not yet provide edge auto-pan, bottom/right double-click preview autofit, visible snap guide lines, host wiring for saved snap preferences, or group-background aspect ratios. The group background renderer is itself unavailable. Native/mobile geometry and visual equivalence have not been established. Tests using synthetic DOM events and geometry shims do not certify touch hit testing, real media layout, scrolling or native caret behavior.

Use an original disposable fixture for the pending native pass:

1. At zoom 1 and 0.5, check all four edges and corners, cursor directions, border hit areas, opposite-edge anchoring and minimum-size behavior. Check dragging from inside the hit area as well as directly on the visible border.
2. Verify object/grid snapping and Mac Control bypass. On non-Mac, verify Alt bypass. Check that nearby groups participate as snap candidates and rich card interiors remain interactive.
3. Select several text cards and then a mixed media selection. Check proportional geometry, default aspect behavior and Shift toggling; resize a single group and confirm its contents remain unchanged.
4. Cancel with Escape and verify unchanged source and geometry. Complete a resize, inspect saved `.canvas` bytes, undo/redo, reopen and confirm persisted dimensions. Confirm unrelated content and unknown fields survive.
5. Resize cards containing a focused editor, long scrolling note, table and media. Check scroll access, retained editor selection/undo, playback ownership and edge-handle interference with the rich interior.
6. Check selected touch-card corners and the multi-selection frame on mobile. Record actual hit geometry and interaction separately from desktop results.

Until those checks are recorded, this slice is source-reviewed and covered by bounded automated tests, with native acceptance pending.
