Implement the approved Lezer Live Preview Parser Migration.

Planning artifacts are .omx/context/lezer-live-preview-parsers-20260530T024321Z.md, .omx/specs/deep-interview-lezer-live-preview-parsers.md, .omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md, .omx/plans/test-spec-lezer-live-preview-parser-migration-20260530T031309Z.md, and .omx/plans/ralplan-handoff-lezer-live-preview-parser-migration-20260530T031309Z.json.

Story 1: Add tests-first migration gates. Add failing static/no-regex parser gate covering live-preview production code and private parser-extension modules, checkbox malformed-adjacent fixture, parser-order/frontmatter/callout fixtures, barrel/export compatibility checks, and collector tests that install the private Markdown language support.

Story 2: Introduce the private Zorid Markdown parser facade and dependency wiring. Replace raw markdown() editor setup with a private wrapper that composes CodeMirror Markdown/GFM plus private Lezer extensions for existing custom syntaxes, without adding public plugin APIs or changing visible product behavior.

Story 3: Add the syntax-tree Live Preview range collector and migrate public inline/mark renderers. Use CodeMirror/Lezer syntax trees with bounded ensureSyntaxTree/syntaxTreeAvailable policy, preserve LivePreviewRange output shape, and replace heading/inline-code/strong/emphasis/strikethrough/highlight/link/wiki-link/tag regex matching.

Story 4: Migrate internal widgets, suppression, blockquote, fenced code, callouts, and task toggle to syntax-tree-derived ranges. Preserve source text, CSS classes, reveal/activation behavior, widget suppression, task transactions, and no-regex final state.

Story 5: Final verification, cleanup, independent review, and commit. Run targeted Live Preview suites, static no-regex gate, lint, typecheck, full tests, performance/no-worse evidence, ai-slop-cleaner, independent code review, architect review, and commit changed files with a plain descriptive message.
