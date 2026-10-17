# Canvas/Bases native verification — 2026-10-17

## Initial candidate

Source `6869abf`, based on main `050d7ef`. Production build session83614
passed TypeScript and webpack with bundle-size warnings. Native session94401
used disposable fixture `/private/tmp/zorid-canvas-bases-ux-js6p8dp9` and its
isolated profile. `launched-build.json` records actual artifact hashes.

The app opened the synthetic Canvas and Work.base. Accessibility exposed the
four expected Base rows and toolbar actions. This alone did not prove layout:
the user's screenshot showed the standalone Base collapsed to a narrow centered
strip. Cause: inline-size containment removed intrinsic width while the generic
attachment host centered its children. The native gate correctly remains failed
until sizing is repaired and rechecked.

CUA native screenshot captures returned nearly white images despite the actual
rendered app shown in the user's screenshot. This is a capture limitation, not
evidence of a blank renderer. No visual verification is inferred from AX data.
The test app was quit through UI, session94401 exited0, and the read-only fixture
inventory reported no changed/added/missing vault files. No user vault was used.

Sizing repair and repeat native verification are in progress. No main
integration or completed UX outcome is claimed by this initial pass.

## Repaired practical pass — 09:08 local

Reviewed sizing repair `8d464a7` is included as `e888d9f`; production rebuild
session1945 passed. Session22552 used that same built source; subsequent
`b275268` changes were documentation only. User explicitly approved Electron
`webContents.capturePage()` to work around the native screenshot tool defect.
Capture helper existed only in the disposable fixture, not production code.

Observed through actual native controls and captured renderer images:

- Bases fills its standalone pane; horizontal toolbar and table visible.
- Previously saved Score ascending survives reopening (Beta, Alpha, Gamma, Delta).
- Filter `note.score > 2` saves and returns Gamma, Delta. An initial automation
  typing attempt appended to the field's `true`; correcting the field through
  its accessibility value produced the intended result. This was not a query bug.
- Split right produces two narrower panes with icon-only toolbars. The Filter
  panel fits the viewport with fields and Apply/Cancel visible.
- Canvas selected-card Edit button activates the live editor. Paired captures
  show ordinary heading/paragraph vertical geometry retained; active heading
  source marker is intentionally visible.
- Native scroll over the short card pans the whole Canvas, confirmed by the
  relative card positions before and after. Embedded Base shows the same two
  filtered records as the standalone view.

Local captures: `bases-wide.png`, `bases-split.png`, `bases-popover.png`,
`canvas-preview.png`, `canvas-edit.png`, `canvas-wheel.png` in the disposable
fixture directory recorded above. These contain synthetic data only.

App quit through UI; session22552 exited0. Only Work.base changed; no added or
missing vault files. Slot explicitly released via `msg_52236cefade5`.

This short practical pass supports integration of the reviewed batch. It does
not measure resize latency, prove all zoom/overlap hit cases or all rich-block
preview geometry, or establish mobile parity. The earlier 91 interaction, 46
Markdown and 39 Bases scoped tests remain regression evidence; they were not
needlessly rerun. Further native resize/scroll-boundary polish stays tracked.
