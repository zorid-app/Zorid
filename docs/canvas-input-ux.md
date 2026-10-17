# Canvas input ownership and resize responsiveness

This slice addresses the reported edit-button/resize overlap, wheel gestures
stopping over cards, and lag during resizing. It follows the current Zorid UX
priority; it is not a claim of exact reference or native parity. Source baseline
is `3fba86b`, implemented in the isolated Orca `canvas-interactions` worktree.
The separate Markdown visual-consistency change is not part of this slice.

## Behavior

- Card edit controls remain owned by the Markdown card but mount as a retained
  Canvas-world overlay above resize handles and the selection outline. Each card
  associates its controls through a unique `aria-owns` ID. Selection visibility,
  geometry, context menus, focus and disposal retain the same owner.
- Normal cards keep their complete stacking contexts. A later card body therefore
  covers an earlier card's obscured resize handles. An initial approach exposing
  all handles in the world stack was rejected during independent source review.
- Ordinary wheel gestures remain native when a scrollable ancestor can consume
  them. Exhausted or non-scrollable content hands the gesture to Canvas. Inner
  `overscroll-behavior: contain/none` boundaries stop the ancestor search on the
  corresponding axis. The helper accounts for horizontal/shift-wheel, RTL and
  elastic overscroll; native value controls and explicitly handled viewer events
  retain ownership. Actual browser scroll chaining remains a native acceptance
  item, including diagonal gestures and nested media/PDF viewers.
- Resize pointer moves retain only the latest input for one animation frame.
  Snapping, geometry and affected-edge painting run once for that input, retaining
  rich content owners. Release flushes pending input before the existing atomic
  transaction; cancellation, source replacement and destruction discard it.
  Generations prevent retired callbacks from consuming a newer gesture's input.
  Save failures, compare-and-set conflicts, undo and auto-pan semantics are kept.

## Focused verification

Author validation on 2026-10-17, serial execution with no build/native run:

```sh
node --test --test-concurrency=1 tests/canvas-input.test.ts
node --test --test-concurrency=1 tests/canvas-resize.test.ts tests/canvas-resize-interactions.test.ts tests/canvas-file-editor.test.ts tests/canvas-markdown.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

All 20 new input checks and 71 existing regression checks pass. TypeScript and
whitespace checks pass. One initial test compared floating-point CSS text exactly;
it was corrected to compare numeric displacement with a tolerance. No production
change was required by that failed assertion.

The burst regression dispatches 100 resize inputs before advancing the controlled
frame: one callback is queued, node attributes and source remain unchanged before
it runs, and one geometry read produces the latest bounds. Release produces one
save; undo restores original bytes. This is an operation-count result in jsdom,
not a native frame-time measurement. Existing resize fixtures explicitly advance
a controlled frame after moves; the new burst/cancel tests leave frames pending.

Independent source review cleared the repaired toolbar stacking, retained owner
lifecycle, per-axis scroll boundaries and frame cancellation. Synthetic layout and
computed z-index tests do not establish browser hit-test results.

## Native acceptance still required

1. At zoom 1, 0.5 and minimum zoom, click the selected card's edit button where its
   painted area overlaps resize hit areas; confirm editing and all exposed resize
   edges still work. Repeat with multiple selected cards.
2. Overlap earlier A=(100,100,200,100) and later B=(250,50,200,200). At world
   (300,150), B's body must own the hit instead of A's obscured right handle.
3. Scroll short/long Reading and Live cards, horizontal fences and nested viewers.
   Inner content should scroll while able; at exhaustion Canvas should pan without
   losing editor focus or changing source. Check trackpad inertia and diagonal
   gestures in the actual browser.
4. Resize a rich card quickly, then release, cancel or switch documents. Verify
   smooth painting, latest saved bounds, one-step undo, retained media/editor
   ownership and no late writes. Measure native responsiveness separately.
