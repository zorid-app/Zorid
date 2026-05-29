# Context Snapshot — Live Preview Widget Hardening

Date: 2026-05-29T11:32:49Z
Task statement: Autopilot the next plan-suggested implementation pass: harden the private fenced-code Live Preview widget foundation before adding public/plugin-facing widget APIs or broader widgets.

## Desired outcome

A small verified implementation pass that closes the current Pass 4 widget-foundation gaps: focused mounted source reveal/restore, pointer activation, source preservation, boundary semantics, and explicit atomic-range policy. No public plugin API, callout widget, table/properties work, or Reading view parity.

## Known facts / evidence

- `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md` approved a private fenced-code block widget foundation and explicitly deferred public renderer APIs.
- `packages/editor/src/live-preview/renderers.ts` contains `CodeBlockPreviewWidget` and private `code-block-widget` ranges.
- `packages/editor/src/live-preview/extension.ts` builds widget decorations through a private `StateField` and source-reveal suppression through selection intersection.
- `tests/editor-live-preview-widgets.test.ts` exists but lacks direct mounted focus reveal/restore, pointer activation, explicit start/end boundary semantics, and atomic-range policy documentation tests.
- `node_modules` is currently missing, so fresh verification needs dependency restore before test execution.

## Constraints

- Keep Markdown source canonical; widget DOM must not become durable state.
- Keep widget APIs private to `packages/editor/src/live-preview`; do not add `packages/platform-api` renderer/widget API.
- No tables, properties/frontmatter UI, callouts, embeds, math, Reading view parity, public plugin widget API, syntax highlighting, copy toolbar, or new dependencies.
- Changes should be small, test-first where practical, and committed at completion.

## Unknowns / open questions

- Whether current focused-state tracking in the widget `StateField` is sufficient under Happy DOM mounted focus tests.
- Whether pointer activation needs only selection dispatch or a private effect.
- Whether full-document widget range collection should be documented as acceptable for this pass or changed to viewport-bounded collection.

## Likely codebase touchpoints

- `tests/editor-live-preview-widgets.test.ts`
- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/renderers.ts`
- Possibly `.omx/plans/*live-preview-widget-hardening*`
