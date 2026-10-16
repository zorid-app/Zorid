# Live tab attachment and focus effects

The combined renderer snapshot `0a1197d` includes canonical `5e4ec97` and the reviewed same-window tab runtime. Its first runtime test failed because it required the entire immutable CodeMirror `EditorState` object to retain reference identity after moving a focused editor between containers.

A bounded transaction trace showed that `captureDOMFocus` restores the moved content DOM's focus. The live-math focus listener (`src/editor/live-math.ts`, `focus` and `change`) responds with a `{ focused: true }` state effect. This transaction changes neither document nor selection but legitimately creates a new `EditorState`. Live callout focus listeners also schedule state effects in microtasks. The production runtime does not recreate the `EditorView`, replace its state, flush the buffer, or dispose its resources during attachment.

The trace preserved the document object, reversed multiple selections, serialized Markdown folds, and one undo plus one redo entry. Redo after attachment changed the existing editor through the destination owner's callback. Suppressing focus effects or restoring an old complete `EditorState` would interfere with the installed renderer plugins; no production mutation is justified by this failure.

The corrected test retains stronger checks of the promised behavior: identical `EditorView` and document objects; identical history and fold state-field objects; identical full selection including direction and primary range; unchanged serialized folds and scroll; no document- or selection-changing attachment transactions, including queued focus effects; no published document edit during the move; and successful undo/redo of both original edits with destination ownership. It deliberately does not require complete `EditorState` reference identity, because renderer interaction state may update when focus is restored.

`node --test --test-concurrency=1 tests/tab-view-runtime.test.ts` passes all 16 tests. This is real CodeMirror in a simulated DOM with synthetic geometry. It verifies lifecycle/state contracts, not native dragging, browser rendering, separate-window transfer, or visual reference parity.
