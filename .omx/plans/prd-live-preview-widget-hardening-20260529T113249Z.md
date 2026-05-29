# PRD — Live Preview Pass 4.5: Widget Foundation Hardening

Status: Autopilot ralplan consensus approved  
Date: 2026-05-29  
Scope: Harden the already-implemented private fenced-code Live Preview widget foundation. This pass does not add public/plugin-facing widget APIs, callouts, tables, properties/frontmatter, embeds, math, Reading parity, syntax highlighting, copy toolbar, or new dependencies.

## Requirements Summary

The current repository has a private fenced-code block widget path, but the prior analysis found evidence gaps around mounted activation/reveal behavior, pointer activation, boundary semantics, and the no-atomic-ranges policy. This pass should close those gaps with focused tests and minimal implementation repair.

## Acceptance Criteria

### Fenced-code widget activation and source reveal

- A mounted inactive complete fenced-code block renders `.z-live-preview-code-block-widget`.
- When the editor is focused and selection enters the opening fence, body, or closing fence activation range, the widget is suppressed and raw Markdown source is visible.
- Moving selection outside the activation range restores the widget.
- Cursor boundary semantics are explicit and tested: range start and range end count as intersecting the widget activation range; the next position after range end does not.
- Pointer/mousedown activation on the widget focuses the editor and dispatches selection to the documented source position without mutating Markdown source.

### Source preservation and lifecycle

- `editor.getText()` and `EditorState.doc.toString()` remain exact across mount, focus, selection movement, pointer activation, reveal, and restoration.
- Widget DOM remains safely constructed through DOM/text APIs; no user Markdown is injected as executable HTML.
- Widget identity remains stable through `eq()` or equivalent behavior.

### Atomic range and activation policy

- This pass either adds `EditorView.atomicRanges` with cursor/deletion tests or explicitly documents/tests that no atomic ranges are used because the current widget is suppressed on focused source intersection and pointer activation moves selection into source.
- If no atomic ranges are added, the implementation must keep source reveal deterministic and source-preserving.

### Scope boundaries

- Keep all widget APIs private to `packages/editor/src/live-preview`.
- Do not add `packages/platform-api` renderer/widget APIs.
- Do not add callout/calendar/plugin-facing widget support in this pass.
- Do not add syntax highlighting, copy toolbar, language loading, line numbers, durable widget-local editing, or new dependencies.

## Implementation Steps

1. Extend `tests/editor-live-preview-widgets.test.ts` with failing coverage for mounted focus reveal/restore, pointer activation, source preservation, and range boundary behavior.
2. If tests reveal a bug, minimally repair `packages/editor/src/live-preview/extension.ts` or `renderers.ts` without broad rewrites.
3. Add explicit no-atomic-ranges policy coverage or implementation comments/tests.
4. Run the targeted Pass 4 widget regression gate and static checks.
5. Commit changed files with a plain descriptive commit message.

## Verification Gate

Required targeted tests:

```bash
pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Recommended if feasible:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## Out of Scope

- Public/plugin-facing Live Preview widget API.
- Markdown processor adapter work.
- Calendar/callout/table/properties/embed/math widgets.
- Reading view parity.
- Syntax highlighting/copy toolbar/code actions.
- Broad parser migration.

## ADR

### Decision

Harden the private fenced-code widget foundation before adding more widget types or public APIs.

### Drivers

- Pass 4 intentionally introduced private widget mechanics first.
- The current implementation exists but needs stronger mounted activation and boundary evidence.
- Public widget API design should wait until multiple first-party widget behaviors validate the private shape.

### Consequences

- This pass is mostly test and correctness hardening, not a new visible feature.
- Plugin-facing calendar widgets remain future work.
- Callout/task checkbox visual widgets can proceed after this foundation is verified.
