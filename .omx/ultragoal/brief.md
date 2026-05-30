Implement the approved Live Preview Custom Block Foundation Pass 6 from the RALPLAN handoff.

Authoritative planning artifacts:
Context snapshot: .omx/context/live-preview-custom-block-foundation-pass-6-20260530T001837Z.md
PRD: .omx/plans/prd-live-preview-custom-block-foundation-pass-6-20260530T001837Z.md
Test spec: .omx/plans/test-spec-live-preview-custom-block-foundation-pass-6-20260530T001837Z.md
Consensus handoff: .omx/plans/ralplan-handoff-live-preview-custom-block-foundation-pass-6-20260530T001837Z.json
Discussion: .agent-context/pass6.md

Durable implementation stories:

Story 1: Add tests-first hardening fixtures for Live Preview selection/mapping, exact canonical Markdown clipboard/source extraction expectations, and viewport/performance boundedness. Use the PRD and test spec acceptance criteria. Keep the tests deterministic under Vitest/happy-dom.

Story 2: Introduce a private block renderer contract/helper under packages/editor/src/live-preview that adapts into the existing InternalLivePreviewRenderer/widget-renderer flow. It must not create a parallel decoration pipeline and must preserve collectLivePreviewWidgetRangesForVisibleRanges scan-window/dedupe semantics.

Story 3: Port or wrap existing fenced code block and callout widgets through the private block renderer contract without behavior changes. Keep code-block and callout renderer ids, source reveal behavior, safe DOM, widget suppression, ordering, and desktop style behavior intact.

Story 4: Enforce public/private boundaries and scope constraints. New block renderer helpers must not leak through packages/editor/src/index.ts, packages/editor/src/live-preview/index.ts, or packages/platform-api/src/index.ts. Do not add public plugin APIs, tables, properties, Reading parity, broad parser migration, product-visible calendar/timeline blocks, or new dependencies.

Story 5: Verify and finalize. Run the targeted Live Preview gate, editor typecheck, import-boundary lint, final cleanup pass, independent code review, final quality gate, and commit changed files with a plain descriptive commit message.
