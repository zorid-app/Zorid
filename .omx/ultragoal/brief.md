Execute the approved RALPLAN handoff for Live Preview interaction + internal block architecture hardening.

Authoritative planning artifacts:
- PRD: .omx/plans/prd-live-preview-interaction-block-architecture-hardening-20260530T041814Z.md
- Test spec: .omx/plans/test-spec-live-preview-interaction-block-architecture-hardening-20260530T041814Z.md
- Handoff: .omx/plans/ralplan-handoff-live-preview-interaction-block-architecture-hardening-20260530T041814Z.json

Constraints:
- Markdown source remains canonical.
- Selection and clipboard are primary acceptance criteria.
- Keep block architecture private under packages/editor/src/live-preview.
- Preserve Lezer/no-regex parser ownership.
- Do not implement public plugin API, tables, Properties/frontmatter visual editor, Reading parity, embeds/images/math, or broad parser rewrite.
- Verify and commit changed files.

Story 1: Selection and mapping hardening.
Add/strengthen tests and implementation for selections spanning mark, replace, line, and widget ranges. Cover cursor positions at start/end boundaries, activationTo, after widget/range end, mixed selections around inline code delimiters, task checkboxes, code-block widgets, and callout widgets. Preserve canonical source except explicit source-backed commands.

Story 2: Clipboard/source preservation hardening.
Upgrade clipboard coverage from helper-only source slicing to behavior-level coverage. Attempt mounted or filter-level copy/cut behavior using CodeMirror clipboard seams; if Happy DOM blocks that, document the limitation and prove an equivalent command/filter path. Cover inline code, task checkbox, fenced code widget, callout widget, mixed selections, ordinary text passthrough, cut undo/redo where implemented, and multi-selection if practical.

Story 3: Activation and atomic-range policy decision.
Make the atomic policy explicit and test-backed. Either keep no-atomic-ranges with stronger cursor/deletion/pointer evidence or introduce private EditorView.atomicRanges for selected widget ranges with cursor motion, deletion, and pointer activation tests.

Story 4: Private internal block architecture refinement.
Add a private contract checkpoint for source range, activation range, clipboard source policy, and optional atomic policy. Refine the private LivePreviewBlockRenderer path so code-block and callout widgets share match-to-widget-to-activation metadata without exporting public block APIs. Verify live-preview/index.ts, package root exports, and packages/editor/package.json do not leak private helpers.

Story 5: Viewport/performance regression, final cleanup, review, and commit.
Extend large mixed-document fixtures for headings, tasks, code blocks, and callouts. Run targeted Live Preview suites, no-regex gate, lint, typecheck, full tests, ai-slop-cleaner on changed files, independent code review, architect review, final commit, and Ultragoal final checkpoint.
