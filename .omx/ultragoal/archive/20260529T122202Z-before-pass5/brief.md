Execute the approved RALPLAN for Live Preview Pass 4.

Planning sources:
- PRD: .omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md
- Test spec: .omx/plans/test-spec-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md
- Handoff: .omx/plans/ralplan-handoff-live-preview-pass-4-structured-widget-activation-20260529T095644Z.json

Scope:
Implement a private fenced-code block structured widget activation foundation for @zorid/editor Live Preview. Keep Markdown source canonical and keep new widget seams private to packages/editor/src/live-preview.

Goals:
1. Add tests-first coverage for fenced-code widget matching, complete-vs-open fence behavior, source preservation, active source reveal, pointer/selection activation, renderer suppression inside fenced code, mounted DOM behavior, and scoped desktop styles.
2. Implement the minimal private widget-capable Live Preview path using CodeMirror WidgetType / block Decoration.replace for complete fenced code blocks only.
3. Add scoped desktop styling for the fenced-code widget shell and update style-scope tests.
4. Run targeted and broad verification required by the PRD/test spec.
5. Run final cleanup/review gate, resolve blockers, and commit changed files with a plain descriptive commit message.

Explicit non-goals:
No tables, properties/frontmatter visual editor, callout widget, embeds/images/PDFs, math rendering, syntax highlighting, copy toolbar, Reading parity adapter, mobile behavior, broad Lezer rewrite, or public renderer/plugin API stabilization.
