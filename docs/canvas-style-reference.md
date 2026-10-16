# Canvas surface style: bounded reference ledger

This is an original implementation guided by static facts from the supplied Obsidian 1.14.4 artifact. It does **not** establish exact rendered parity. No recovered implementation or assets were placed in the project, and the reference application was not executed for this task. Icons come from the project's independently installed Lucide package through `icon(name, size, ownerDocument)`.

## Identity and evidence boundary

- Source root: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`.
- `app.js`: SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css`: SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`, 668223 bytes.
- Retained REA renderer evidence: E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, renderer node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. Its semantic graph is partial. The audit reused that renderer identity and inspected only the Canvas CSS, relevant default variables, and already located Canvas JavaScript routines. It did not repeat broad analysis.
- The CSS locations below are zero-based UTF-8 byte offsets. JavaScript locations are zero-based Unicode character offsets. Intervals locate bounded inspection windows, not complete runtime coverage.

## Observed facts and implementation

| Surface | Static evidence | Original implementation |
| --- | --- | --- |
| Background and dots | CSS 63370–63895, 541719–542925: primary background, base-30 dot color. JS 3307923: dot radius/center .7; 3320316: world grid 20, 40, 80, 160 across log2 zoom thresholds -.91, -2.16, -3.3; 3327500–3328410: translated pattern phase, square-root inverse zoom compensation. | Dedicated screen-space SVG pattern; dots retain radius while spacing changes and panning updates phase. Pan/zoom do not edit document data. |
| Zoom bounds | JS near 3327200–3328410: scale is 2 to the zoom power, zoom clamped from -4 through 1; zoomed-out marker at -1.7. | Scale range 1/16 through 2, matching compensation and file-caption hiding threshold. Fit uses an original bounded fit calculation. |
| Card frame | CSS 547070–547642: 1px border, medium radius, primary fill, stationary shadow, grab cursor. Radius defaults 83093–83135: small 4px, medium 8px. Canvas neutral color 541570–541719: light #c0c0c0, dark #7e7e7e. | Separate clipped inner frame preserves captions outside bounds; border/radius/shadow use shared variables with audited defaults. |
| Selection and dragging | CSS 549377–550900: selected accent border and 2px ring; themed border 70% color and inset stroke; themed selected uses its color. CSS 549620 and shadow variables 99287/102666: drag shadow. | Selection and drag classes retain source-independent state; existing node and edge DOM updates during pointer movement. Dark/light shadow fallbacks differ. |
| Card colors | CSS 63468–63708 and palette defaults 97799–97980, 99983–100165: presets red, orange, yellow, green, cyan, purple. Themed content 554737: 7% color. | Theme-aware preset colors and validated hexadecimal custom colors; unknown values remain unchanged in source. Colored frame/content treatment uses OKLCH mixing. |
| Text | CSS 553335–554100: embedded Markdown horizontal padding 16; vertical flex spacing capped at 16, dependent on card height. | Literal text currently uses 16px padding, shared text font and size, line-height 1.5. Rich Markdown flow and dynamic vertical spacing are explicitly incomplete. |
| Groups | CSS 551488–553335: transparent frame, 7% fill, label above card; 4px gap multiplied by compensation, label padding 4×8, radius 4, font 1.5em. JS 3397480–3398300: colored label foreground chooses light/dark. Brightness helper at 1263211 uses weighted RGB threshold 150. | External group label and compensating scale; default preset foregrounds switch with light/dark theme, hex custom colors use weighted RGB contrast. Arbitrary theme overrides to preset colors do not yet recompute contrast. Group interior hit testing still differs from the reference's unselected pass-through behavior. |
| File/link captions | CSS 547642–548661: faint captions above frame; hide when zoomed out. JS 3380859–3381600 and 3392145: file-label setting, short filename/subpath and URL captions. | Captions outside clipping; file basename with Markdown extension removed and subpath suffix, literal URL caption. File resolution and label-preference settings remain incomplete. |
| Placeholder content | CSS 548661–549377: centered content, padding 24, font 32 semibold, color tint. | Existing file/link open affordances use this bounded placeholder layout. They are not rendered file, image, PDF or remote website embeds. |
| Connections | CSS 559697–560900: display width 2×compensation, hit target 24×compensation, hover/selected 5.5×compensation with 10% hit tint. JS 3399800–3400800, 3404420–3406108: side inference, outward shift 7, Bézier reach clamped 70–150, triangle arrowheads and rotations. | Separate display/hit paths share geometry; original cubic construction follows these geometric facts; arrowhead wrappers follow endpoint side. Arrowheads and edge width compensate as zoom changes. |
| Connection labels | CSS 561130–561801: 20px type, line-height 1.3, padding 6, radius 4, primary fill, max-width 17em, all zoom compensated. JS 3404035 and 3408554–3410650: center of cubic at parameter .5, HTML label. | HTML labels use the cubic center and remain selectable/context-menu targets; dragging updates existing labels with edges. |
| Zoom/history controls | CSS 545574–547070: top/right 8, vertical groups gap 8; border 1, radius 4, input shadow; padding 8, icon 16, stroke 2. JS 3309854–3311900: settings, zoom in/reset/fit/out, undo/redo, desktop help groups. | Implemented zoom and history groups use icon-only buttons with accessible names and observed order, dimensions, colors, and placement. Quick settings/help groups are not falsely presented as working controls. |
| Creation tray | CSS 543840–545574: bottom 16, centered, small radius, input shadow, dark secondary/light primary fill, padding 8, 32px icons, stroke 1.25. JS 3308346–3309854: text/note/media buttons; text click centers creation. Defaults near 3305600: text 250×60. | Add-card button uses shared sticky-note icon, bottom tray placement and centered 250×60 card creation. Note/media pickers and tray drag creation remain missing. |
| Selection box | CSS 543100–543510: rectangle border 2 with 10% accent fill; separate group selection decoration. | Existing drag-selection rectangle gets the observed border/fill. Separate multi-selection outline/toolbar remain missing. |

Input shadow defaults were inspected at CSS 98806 and 102060; large shadows at 99287 and 102666. Unused transparent shadow layers were omitted. Shared theme variables take precedence over fallback colors. The patch contains original selectors and structure, not a copied stylesheet.

## Safety and regression verification

The style changes retain document/view separation, byte-preserving untouched source, ordered persistence, active-editor flush, failed-save rejection/retry, pending-change reporting, and destroyed-owner guards. Context menus remain the implementation documented in `menus-canvas-reference.md`.

Two independent menu findings were also fixed: newly created web cards become selected, and editor and drag commits resolve the unchanged raw record retained by the view projection rather than a captured array index. Reordering before opening the editor or during an interaction cannot redirect the edit. If the target was replaced/removed/ambiguously duplicated while editing, the editor keeps its draft and `flush()` rejects instead of overwriting another record. Escape can discard that draft explicitly.

The focused tests exercise actual DOM/event behavior: bounded drag updates, connected geometry, arrow direction, zoom/pan grid invariants, caption placement, shared SVG icon creation, centered creation/undo, HTML edge-label selection/deletion, record-preserving edit conflicts and persistence failure. They do not perform layout or screenshot comparison and therefore cannot establish visual parity.

## Native visual comparison checklist

Use matching viewport size, device-pixel ratio, OS font environment, zoom, and default light/dark theme. Disable snippets/community theme overrides for the first comparison. Use the same local `.canvas` data and capture both surfaces at the same pan/zoom. Root owns native verification.

- [ ] Empty canvas at 100%: primary background, .7-radius dots, 20px spacing, top/right controls at 8px, bottom tray at 16px; compare shadows and Lucide icon alignment.
- [ ] Zoom at 200%, 100%, 50%, 25%, 12.5%, 6.25%; pan fractional and integral distances. Check spacing transitions, phase, card-caption hiding, edge/arrow/label compensation, reset and fit.
- [ ] Plain text cards: single line, wrapped paragraph, empty, very small and large cards. Compare 8px corners, neutral stroke, padding and selected 2px ring. Record remaining Markdown flow discrepancies separately.
- [ ] Each of six preset colors and bright/dark custom hex: ordinary and selected frames, 7% fill, group label foreground; repeat in light and dark theme.
- [ ] Group label above bounds, long truncated label, empty label and nested groups; compare unselected group hit testing (known gap) separately from appearance.
- [ ] File/link captions with long paths and subpaths; compare label height and zoom suppression. Mark resolved embeds as unavailable rather than comparing placeholders as equivalent content.
- [ ] Connections on all four sides, both/no/single arrowheads, self-loops, near and distant cards; hover/selection stroke, arrow tip alignment and cubic midpoint label.
- [ ] Single-line and multiline connection labels, long unbroken labels, selected and dragging nodes. Check label follows connection without recreation during drag.
- [ ] Drag selected colored/plain nodes; verify shadows and immediate connected-edge movement. Cancel and undo; inspect saved file for unchanged unrelated metadata.
- [ ] Reopen after editing text/labels, then simulate failed save before close. Visual work must not regress draft retention or save errors.

## Remaining boundaries

No pixel comparison, reference runtime observation, or native screenshot was performed by this worker. Exact parity remains unverified. Rich Markdown rendering/editing, file/media/website embedding, file selection, resize/connection handles, selection floating toolbar, settings/help controls, drag-to-create tray behavior, group background media, file-label preferences and full reference gestures remain broader Canvas work. Default preset group contrast is implemented; custom theme palette changes need dynamic contrast recalculation. Typography, antialiasing, precise frame layout, edge scaling and control interaction states require the native checklist above.
