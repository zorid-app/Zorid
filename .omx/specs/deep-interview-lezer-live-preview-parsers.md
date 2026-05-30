# Deep Interview Spec — Lezer Live Preview Parsers

## Metadata

- Profile: standard
- Context type: brownfield
- Rounds: 4
- Final ambiguity: 0.13
- Threshold: 0.20
- Context snapshot: `.omx/context/lezer-live-preview-parsers-20260530T024321Z.md`
- Transcript: `.omx/interviews/lezer-live-preview-parsers-20260530T025513Z.md`
- Prompt-safe initial-context summary: not needed

## Intent

Replace fragile regex-based Live Preview parsing with Lezer/CodeMirror syntax-tree parsing so Markdown meaning is derived from parser nodes rather than ad-hoc string matching. The immediate motivation is to prevent rendering failures like misplaced task checkbox widgets while preserving Zorid's Markdown-source-as-truth Live Preview model.

## Desired outcome

A Lezer-backed Live Preview parser/matcher layer where:

- every live-preview Markdown recognition path uses Lezer parsing or syntax-tree traversal instead of regex parsing;
- existing Zorid/Obsidian-like custom syntax is represented through private Lezer Markdown extensions or syntax-tree nodes;
- existing Live Preview behavior remains intact for supported syntax;
- parser migration does not expand product scope into Reading view, public plugin API, or a new editor model.

## In scope

- Replace all regex parsing/matching in Live Preview/rendering paths, including suppression/context helpers and task toggles.
- Use Lezer/CodeMirror syntax trees to derive Live Preview ranges and widgets.
- Add private first-party Lezer Markdown extensions for existing supported custom syntax where built-in Lezer nodes are insufficient.
- Refactor private internal renderer contracts from regex-produced ranges toward syntax-node-backed matches.
- Preserve current preview behavior for:
  - headings;
  - inline code;
  - strong/emphasis/strikethrough/highlight;
  - Markdown links;
  - wiki links;
  - tags;
  - blockquotes;
  - task checkboxes;
  - fenced code block widgets;
  - callout widgets.
- Rewrite or add tests around syntax-tree-backed behavior.
- Add direct Lezer/CodeMirror parser dependencies if needed.
- Use temporary hybrid internals during migration only if the final accepted state has no live-preview regex parser paths.

## Out of scope / non-goals

- No Reading view renderer migration.
- No public plugin API for custom syntax/renderers.
- No UI redesign beyond visual changes caused by correct parsing behavior.
- No new syntax features beyond migrating existing supported syntax.
- No replacement of CodeMirror 6 with another editor stack.
- No dropping an existing Live Preview behavior simply because the parser migration is hard.

## Decision boundaries

OMX may decide without further confirmation:

- exact file/module layout for the Lezer-backed language and renderer layers;
- whether to add direct dependencies on Lezer/CodeMirror parser packages;
- how to define private Lezer nodes for existing custom syntax;
- how to change private internal renderer contracts;
- how to sequence a temporary hybrid migration, as long as final acceptance removes live-preview regex parser paths;
- how to rewrite tests from regex range expectations to syntax-tree-backed fixtures and behavior assertions.

OMX should ask before:

- adding user-visible syntax not already supported;
- introducing a public plugin API;
- changing the visual design intentionally rather than as a parsing correctness consequence;
- replacing CodeMirror or changing the high-level editor model;
- starting a Reading view renderer migration.

## Constraints

- Markdown source remains canonical; widgets/decorations remain projections.
- Existing preview behavior should be preserved before expanding capability.
- Direct parser dependencies are allowed when needed.
- Final implementation must have no live-preview regex parser paths.
- Temporary hybrid code is acceptable only as an implementation staging strategy, not as final state.

## Testable acceptance criteria

1. **No live-preview regex parsers:** a static/source check verifies live-preview Markdown recognition no longer uses regex/matchAll/exec parser paths.
2. **Existing previews preserved:** tests verify existing preview/reveal behavior for all currently supported renderers listed in scope.
3. **Checkbox bug fixture:** tests cover malformed/adjacent task-marker text like `- [ ]f- [ ]a 4- [ ]- [ ]` and prevent newline-spanning checkbox ranges.
4. **Custom syntax via Lezer:** existing Zorid/Obsidian-like custom syntaxes are represented as private Lezer Markdown extensions or syntax-tree nodes, not regex scanners.
5. **Full validation:** relevant targeted tests plus project lint and typecheck pass after migration.
6. **Performance no worse:** viewport/performance fixtures show no obvious regression from regex scanning to syntax-tree traversal.

## Assumptions exposed + resolutions

- Assumption: “all regex parsers” could mean every regex in the repository. Resolution: first pass targets every regex parser path in Live Preview/rendering, including suppression helpers and task toggles.
- Assumption: Lezer migration might justify dropping hard preview behavior. Resolution: existing previews must be preserved; build parser support first.
- Assumption: custom syntax means new features. Resolution: no new syntax features in this pass; custom syntax means private parser representation for existing supported syntax.
- Assumption: avoiding reinvention forbids new dependencies. Resolution: direct Lezer/CodeMirror parser dependencies are allowed if useful.

## Pressure-pass findings

The pressure pass revisited the “every live-preview regex” requirement and exposed the risk that current behavior may rely on fuzzy string matching. The resolved boundary is: OMX may add private Lezer extensions, change internal contracts, and use temporary hybrid internals, but final acceptance requires no live-preview regex parser paths and no dropped current preview behavior.

## Brownfield evidence vs inference notes

### Evidence

- `package.json` already includes CodeMirror editor/parser packages.
- `packages/editor/src/index.ts` already installs `markdown()`.
- `packages/editor/src/live-preview/renderers.ts` contains regex/matchAll-based semantic renderers and task marker matching.
- `packages/editor/src/live-preview/task-toggle.ts` uses a task-marker regex.
- `packages/editor/src/live-preview/markdown-code-context.ts` uses regex scanning for suppression contexts.
- Live Preview test coverage already exists across primitives, widgets, callouts, clipboard, selection mapping, performance fixtures, and task toggles.

### Inference

- The migration should likely introduce a Lezer-backed language/custom syntax module and adapt the renderer collection layer to syntax nodes before deleting regex parser paths.
- Planning should define the exact static check that distinguishes forbidden live-preview regex parsers from acceptable non-parser regex utilities elsewhere in the project.

## Recommended handoff

Use `$ralplan` next. This task has clear requirements but needs architecture and test-shape planning before implementation because it changes parser boundaries, private renderer contracts, and performance-sensitive traversal behavior.
