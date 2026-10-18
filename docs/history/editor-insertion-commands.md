# Editor insertion commands

User-scoped editor work, based on main `30c1349`, separate from paused durable-write implementation. No default keybindings are added. The command palette and configurable Settings share the editor command catalogue; ordinary note palette captures its editor/selection and denies stale owners. Existing formatting/folding commands also become discoverable there. Canvas palette targeting is outside this slice.

Eight insertion actions share one transaction helper across hotkeys and the context Insert menu:

- Table: two-column Markdown skeleton; selected source stays before it; first header selected.
- Callout: note callout, prefixing every selected line including blanks.
- Code block: selected bytes retained, backtick fence longer than any selected run.
- Math block: selected content wrapped in display delimiters; conflicting delimiters rejected.
- Horizontal rule: `***` avoids accidental YAML frontmatter at document start.
- Link/image: escaped selected label, destination caret; empty insertion starts in label.
- Footnote: unused numeric reference plus document-end definition in one undo step, selected source becomes the definition. This adds source syntax; rendered footnote resolution remains a separate capability.

Commands preserve unrelated text, multiple-selection main index and selection direction where meaningful. Block insertions establish blank-line boundaries; all edits isolate undo from preceding/following typing. They deny readonly/composing owners, rectangular table selections, partial code/structured syntax and unparsed late document contexts. Table children permit only inline link/image actions through the existing serializer; block/footnote insertion is disabled there. Definitions never append into recognized unfinished code/math/HTML containers.

Validation: the coordinator ran the eight-file bounded suite serially; corrected gate passed 101/101 tests in approximately 3.9 seconds, including five independently authored context-safety regressions and thirteen actual Workspace/CodeMirror palette tests. Direct TypeScript checking passed. Independent final source review cleared the helper, unique context action identities and captured palette lifecycle. The initial run exposed three source/fixture safety defects (fully selected bracket labels, terminal HTML-comment definitions and composition before first DOM input), plus two stale catalogue/menu expectations; repairs preserve the original regressions. The final menu identity regression also proves legacy wiki Add link remains distinct from Markdown Insert link. No full repository suite or production build was run for this scoped gate. Native menu geometry, platform IME, physical clipboard and mobile behavior are not established by this implementation. No adapter/core changes, new persistence protocol or Canvas feature changes are included.


## Main-based integration check — 2026-10-16

Candidate `6e44bf2` cherry-picks reviewed `cb6f5d7` onto main `a71c8df` in
`editor-insertion-integration`. Editor/UI and affected test blobs remain identical
to the reviewed source. The findings document merged both sessions' updates.
No main checkout edits or paused durable-consumer work were included.

The following **new eleven-file integration check** passed 112/112 tests (session
59432, exit 0, 5.31 seconds). This is not a claim to reproduce the original eight-file
command, which was not recorded above:

```sh
node --test --test-concurrency=1 tests/editor-insertions.test.ts tests/insertion-commands-review.test.ts tests/workspace-insertion-palette.test.ts tests/format-menu.test.ts tests/hotkey-settings.test.ts tests/editor-hotkeys.test.ts tests/editor-hotkeys-review.test.ts tests/workspace-editor-hotkeys.test.ts tests/hotkeys.test.ts tests/workspace-hotkeys.test.ts tests/menu-hotkeys.test.cjs
node node_modules/typescript/bin/tsc --noEmit
```

The full TypeScript check also passed (session 51297, exit 0, no diagnostics).
Node was v26.10.0. A temporary symlink reused the primary checkout's existing
`node_modules`; no packages were installed and the symlink was removed afterward.
Logs are `/private/tmp/zorid-editor-insertion-integration-tests.log` and
`/private/tmp/zorid-editor-insertion-integration-tsc.log` on the validation machine.
No production build, aggregate suite or native UI check was run in this gate.
The previously stated native focus/IME, rendered-footnote and mobile limits remain.
