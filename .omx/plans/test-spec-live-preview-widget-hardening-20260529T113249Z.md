# Test Spec — Live Preview Pass 4.5: Widget Foundation Hardening

Date: 2026-05-29

## Test Objectives

1. Prove mounted fenced-code widgets reveal raw source when focused selection intersects the widget source range.
2. Prove moving selection out restores inactive widget preview.
3. Prove pointer activation reveals source at a deterministic position without source mutation.
4. Freeze start/end boundary semantics for widget activation ranges.
5. Record the no-atomic-ranges policy unless implementation evidence requires atomic ranges.

## Required Tests

### Boundary semantics

- Unfocused/inactive complete fence emits `code-block-widget`.
- Focused cursor at `range.from` suppresses widget.
- Focused cursor inside body suppresses widget.
- Focused cursor at `range.to` suppresses widget.
- Focused cursor at `range.to + 1` restores widget if within document.

### Mounted reveal/restore

- Mount text containing a complete fenced-code block and outside paragraph.
- Assert widget DOM exists and source is unchanged.
- Focus editor and dispatch selection into fence/body/closing fence.
- Assert widget DOM is removed/suppressed and source is unchanged.
- Dispatch selection outside block.
- Assert widget DOM returns and source remains unchanged.

### Pointer activation

- Dispatch `mousedown` on `.z-live-preview-code-block-widget`.
- Assert event is handled by focusing editor/dispatching selection to the documented source position.
- Assert widget is suppressed after activation and `editor.getText()` remains exact.

### Atomic policy

- If no `EditorView.atomicRanges` extension is introduced, assert source reveal/pointer activation tests cover deterministic cursor entry and restoration.
- If atomic ranges are introduced, add cursor/deletion boundary tests.

## Regression Tests

- Existing widget matcher/source-preservation tests remain green.
- Existing Live Preview block/primitive/task/keymap/package tests remain green.
- Desktop style scoping remains green.
- Autosave/vault editor regressions remain green.
- Editor typecheck and import-boundary lint remain green.
