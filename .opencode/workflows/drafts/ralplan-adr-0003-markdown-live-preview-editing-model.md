# RALPLAN Planner Draft: ADR 0003 Markdown Live Preview Editing Model

## Requirements Summary

Implement the accepted product/UX direction in `docs/architecture/adr-0003-markdown-live-preview-editing-model.md` as phased, test-driven editor work. This remains planning only and should execute as durable goals, not one patch.

Hard constraints from Architect review:

- Build indentation primitives before list/task/toggle goals.
- Add explicit collapsed-selection/copy architecture before any fold/toggle implementation.
- Split blockquote/callout non-collapsed behavior from fold/collapse behavior.
- Split toggle syntax/rendering from collapsed/selection/copy complexity if execution pressure requires it.
- Parser ownership: no production regex parser scans in `packages/editor/src/live-preview`; use CodeMirror/lezer syntax tree, parser facades, or accepted char-scanner style, respecting `tests/editor-live-preview-no-regex-parsers.test.ts`.
- Parser-extension path: non-standard syntax such as persisted toggles `>>+` / `>>-` must be implemented through a private Markdown parser facade, Lezer extension, or explicitly approved parser-owned char-scanner mechanism. The no-regex parser gate must cover any new parser-adjacent module, not only files under `packages/editor/src/live-preview`.
- API freeze: no new root exports and no platform/plugin contract expansion; keep helpers private unless a separate API review explicitly approves exposure.
- Separation of concerns: renderers project visuals; commands mutate source; widgets dispatch commands/actions and must not own source-rewrite logic.
- Horizontal rules are in scope: `---`, `***`, and `___` render only while inactive; caret/selection reveal the source line; copy/cut preserves the original markdown source.

## Repository Evidence

- ADR 0003 is accepted product direction and requires phased source-preserving live preview, escaped marker literal behavior, and element-specific active/selection/copy semantics.
- `packages/editor/src/live-preview/types.ts` already defines `LivePreviewRange.revealPolicy?: 'caret-or-selection' | 'caret' | 'never'`.
- `packages/editor/src/live-preview/renderers.ts` already has public renderers for headings, inline code, strong/emphasis/strikethrough/highlight, markdown links, wiki links, and tags; internal renderers for blockquotes, list markers, and task markers; widget block registrations for code blocks, callouts, and zbase embeds.
- `packages/editor/src/live-preview/syntax-tree-ranges.ts` already contains heading-specific marker behavior using `revealPolicy: 'caret'` and `revealPolicy: 'never'`, plus syntax-tree ranges for inline styles, links, wiki links, and tags.
- `packages/editor/src/markdown-list-commands.ts` currently handles bullet/task toggles, task continuation, and list indent/outdent conservatively; ordered list commands are intentionally limited today.
- `tests/editor-live-preview-no-regex-parsers.test.ts` forbids regex literals, `RegExp`, `.exec`, `.matchAll`, and parser-style `.match` in production live-preview/parser-extension modules, with only the renderer API method name exception.
- Existing tests cover live-preview primitives, selection mapping, clipboard, widgets, callouts, list commands, markdown keymap behavior, parser facades, and package wiring.

## Assumptions and Open Questions

- Assumption: code blocks, images/embeds, and tables remain regression-only for this implementation series.
- Assumption: copy preservation is source-backed for normal decorations, but collapsed widgets/toggles need explicit design and tests before fold behavior lands.
- Open question for execution: whether toggle lists ship fully in one late goal or split into syntax/rendering first and collapsed-selection/copy in a follow-up goal. Default remains split unless Goal 8 Architect review approves combining.

## RALPLAN-DR

### Principles

1. Preserve source first: visual preview must not corrupt markdown, indentation, escaped syntax, collapsed hidden source, or copy behavior.
2. Establish shared primitives before feature families: indentation and collapsed-selection/copy policy precede lists, callout folding, and toggles.
3. Respect parser ownership: live preview consumes CodeMirror/lezer syntax/facades or approved char scanners, never ad hoc regex parser scans.
4. Keep APIs frozen by default: implementation helpers stay private unless an explicit API review approves exported contracts.
5. Keep concerns separated: renderers project visuals, commands mutate source, widgets dispatch actions/commands.

### Top 3 Decision Drivers

1. UX contract breadth: ADR 0003 spans rendering triggers, active/inactive selection behavior, commands, copy semantics, source mutation, indentation, nesting, and collapsed content.
2. Regression risk: existing preview renderers, widgets, parser gates, selection mapping, keymaps, and package wiring already constrain safe change order.
3. Maintainability: future markdown constructs need reusable indentation, activation, command, widget, and copy/collapse primitives rather than duplicated renderer-specific logic.

### Viable Options

#### Option A: Foundations-first durable goals (recommended)

Build shared policy/test helpers, indentation primitives, and collapsed-selection/copy architecture first; then layer lists/tasks, inline syntax/horizontal rules, non-collapsed blockquotes/callouts, fold/collapse behavior, toggles, and final quality gates.

Pros:

- Matches Architect review ordering and minimizes rework in toggles/folds.
- Keeps parser/API/separation constraints visible from the first implementation goal.
- Creates reviewable checkpoints for broad ADR scope.

Cons:

- Slower first visible feature delivery.
- Requires disciplined handoff so foundational work does not expand into architecture redesign.

#### Option B: Element-by-element vertical slices

Implement each ADR element independently with local renderer/command logic.

Pros:

- Faster initial visible changes.
- Easier to assign isolated files at first.

Cons:

- Violates the desired primitive-before-feature ordering.
- Raises risk of inconsistent selection/copy/collapse behavior.
- Encourages renderer-owned source mutation or duplicated parser scans.

#### Option C: Toggle-first delivery

Prioritize persisted toggle syntax and interaction before shared indentation/collapse architecture.

Pros:

- Delivers the most novel ADR behavior early.
- Exposes hard nested/collapsed cases quickly.

Cons:

- Highest risk because toggles depend on indentation, collapse/copy semantics, widgets, source mutation, and key handling.
- Likely to rework after parser/API/separation constraints are applied.

### Recommendation

Choose Option A. Execute with `ultragoal` because the work is broad, sequential, and benefits from ledgered checkpoints, per-goal acceptance criteria, and Architect/Critic reviews between risky phases.

## ADR for This Implementation Plan

### Decision

Implement ADR 0003 through sequential durable goals ordered by dependency: shared policies, indentation, collapsed-selection/copy architecture, lists/tasks, inline syntax, horizontal rules, non-collapsed blockquote/callout behavior, fold/collapse behavior, toggles, and final regression lock.

### Drivers

- Architect review requires indentation and collapsed-selection/copy architecture before list/toggle/fold implementation.
- Existing implementation is partial and already constrained by parser gates, package wiring, reveal policies, renderers, widgets, and command modules.
- ADR 0003 includes both visual projection and source mutation, requiring explicit renderer/widget/command separation.

### Alternatives Considered

- One large patch: rejected as too risky and impossible to review against parser/API/copy constraints.
- Toggle-first: deferred because it depends on indentation plus collapsed selection/copy architecture.
- Renderer-only pass: rejected because ADR behavior includes source mutation commands, keyboard behavior, and widget dispatch.

### Consequences

- Execution takes multiple commits/goals.
- Toggle and folding work may split further if collapsed copy/selection constraints reveal CodeMirror limitations.
- Tests must be added continuously, including the no-regex parser gate and API/package-wiring checks.

### Follow-ups

- Architect review should validate foundational private helper boundaries, parser ownership, and command/widget separation before Goal 4 starts.
- Critic review should challenge copy/selection gaps before any collapse/fold/toggle hiding lands.
- Architect review is required immediately before Goal 8 to approve the parser-extension path for non-standard toggle syntax/rendering and confirm the no-regex gate covers every new parser-adjacent module.
- API review is mandatory before any proposed new root export or platform/plugin contract change; default is no API expansion.

## Proposed Ultragoal Sequence

### Goal 1: Shared Preview Policy Primitives and Test Fixtures

Touchpoints:

- `packages/editor/src/live-preview/types.ts`
- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/syntax-tree-ranges.ts`
- `packages/editor/src/live-preview/source-text.ts` if source/copy helpers are needed
- `tests/editor-live-preview-primitives.test.ts`
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-live-preview-no-regex-parsers.test.ts`

Deliverables:

- Codify private activation/reveal semantics for caret-only, selection-stable, never-reveal, and syntax-touching cases.
- Add reusable fixtures for source preservation, escaped marker suppression, and private helper behavior.
- Keep helpers private; do not add root exports or public platform/plugin contracts.
- Preserve current heading marker behavior.

Acceptance criteria:

- Existing heading behavior remains intact.
- Future tests can distinguish visible-content selection from hidden-syntax selection without duplicated setup.
- Render-trigger fixtures cover complete vs incomplete syntax, escaped syntax, active caret reveal, selection-touch reveal, and inactive rendered state.
- Copy/cut fixture helpers assert exact source preservation, not visual text, for source-backed decorations.
- Parser ownership gate remains green; no production regex parser scans are introduced.
- Package/API wiring tests show no new root exports unless separately approved.

### Goal 2: Editor-Wide Indentation Primitives and Guides

Touchpoints:

- `packages/editor/src/markdown-list-commands.ts` or a private shared indentation command module
- `packages/editor/src/live-preview/renderers.ts` / private guide renderer modules as needed
- `apps/desktop/src/renderer/src/styles.css`
- `tests/editor-markdown-list-commands.test.ts`
- `tests/editor-markdown-keymap.test.ts`
- new/extended indentation guide tests

Deliverables:

- Define one indentation unit as 4 spaces, with tabs counting as 4 columns.
- Implement structural Tab/Shift+Tab primitives for paragraphs and multi-line selections first, then make list/task/toggle/blockquote/callout goals consume these helpers.
- Add visual-only indent guides across nested/indented lines.
- Keep source mutation in commands; renderers only project guides.

Acceptance criteria:

- Paragraph Tab indents by 4 spaces; Shift+Tab outdents one unit without crossing line starts.
- Multi-line behavior handles non-empty lines and internal blank lines per ADR.
- Enter behavior remains source-preserving and undoable after indentation changes; Tab/Shift+Tab mutations are single undoable transactions where editor conventions support it.
- Later list/task/toggle/blockquote/callout tests can call the same command primitives rather than duplicating source rewrite logic.
- Guides are visual-only and are not copied.
- No new public exports; helper access stays package-private.

### Goal 3: Collapsed Selection and Copy Architecture

Touchpoints:

- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/source-text.ts`
- private widget/collapse policy module if needed
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-live-preview-clipboard.test.ts`
- `tests/editor-live-preview-widgets.test.ts`

Deliverables:

- Define private policy for hidden/collapsed source: visual hiding must not delete source, selection must map predictably, and copy must preserve markdown source unless ADR explicitly says visual-only placeholder.
- Define source range derivation for collapsed blocks: title marker/title text range, hidden body range, hidden child range, and full block/subtree range.
- Define DOM/editor selection mapping for collapsed blocks: title-only selection, selection crossing from visible title into hidden body, selection crossing hidden body/children, and selection spanning across sibling boundaries.
- Define cut/delete/undo behavior for collapsed blocks before any fold ships: title-only cut affects only title source; cross-hidden-range cut/delete affects the corresponding source range predictably; all mutations are undoable source transactions.
- Define widget dispatch pattern: widgets emit actions/commands; commands mutate source; renderers/widgets do not directly rewrite document text.
- Add tests or documented failing/xfail-style follow-up expectations for collapsed subtree selection/copy before any fold/toggle collapse implementation.

Acceptance criteria:

- Clipboard tests cover source preservation for hidden/collapsed candidate ranges and visual-only placeholders.
- Tests cover source range derivation for collapsed callout/toggle candidates, including title-only selection, crossing hidden body/children, full subtree copy, cut/delete, and undo behavior.
- Selection mapping tests prove DOM/editor selections round-trip between rendered title controls and hidden source ranges without dropping hidden markdown.
- Widget tests demonstrate dispatch-to-command/action separation without renderer-owned mutation.
- Collapse/fold/toggle implementation is blocked until this architecture is accepted.

### Goal 4: List and Task Behavior

Touchpoints:

- `packages/editor/src/live-preview/list-marker-ranges.ts`
- `packages/editor/src/live-preview/task-marker-ranges.ts`
- `packages/editor/src/live-preview/task-toggle.ts`
- `packages/editor/src/live-preview/renderers.ts`
- `packages/editor/src/markdown-list-commands.ts`
- `tests/editor-live-preview-primitives.test.ts`
- `tests/editor-task-toggle.test.ts`
- `tests/editor-markdown-list-commands.test.ts`
- `tests/editor-markdown-keymap.test.ts`

Deliverables:

- Complete unordered markers `- `, `* `, `+ ` as immediate replacement widgets while marker-only text stays plain.
- Add ordered marker rendering for `N. ` and `N) ` without renumbering or normalization.
- Extend task support across unordered and ordered markers, including `[ ]`, `[x]`, `[X]`, click toggle, Space/Enter on focused checkbox, and Enter continuation preserving marker/delimiter with ordered increment.
- Consume Goal 2 indentation primitives for indent/outdent behavior.

Acceptance criteria:

- Marker-only lines stay plain; complete markers render immediately.
- Incomplete and escaped list/task markers remain source text with no preview widget.
- Active caret/selection behavior matches ADR: marker syntax reveals when touched; inactive complete markers render.
- Copy/cut preserves exact list/task source, including ordered delimiters and checkbox marker case where not intentionally mutated.
- Ordered list rendering preserves typed number/delimiter and skipped/mixed numbering.
- Task widgets dispatch source-mutating commands that change only checkbox state.
- Focused task checkbox Space toggles; Enter continues task list as ADR specifies.
- Enter continuation, Tab, and Shift+Tab behavior is covered for unordered, ordered, and task lines and remains undoable.

### Goal 5: Inline Styling, Links, Wiki Links, Tags, and Horizontal Rules

Touchpoints:

- `packages/editor/src/live-preview/syntax-tree-ranges.ts`
- `packages/editor/src/live-preview/markdown-inline.ts`
- `packages/editor/src/live-preview/renderers.ts`
- `apps/desktop/src/renderer/src/styles.css`
- `tests/editor-live-preview-inline-registration.test.ts`
- `tests/editor-live-preview-primitives.test.ts`
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-live-preview-clipboard.test.ts`
- `tests/editor-live-preview-no-regex-parsers.test.ts`

Deliverables:

- Ensure paired inline styles hide delimiters only for complete syntax and reveal delimiters when caret or selection touches syntax.
- Ensure inline code suppresses nested markdown preview.
- Ensure markdown links render only after complete `[label](target)` and reveal full source when caret is inside label/target or selection touches syntax.
- Ensure wiki links render after closing `]]`, display aliases correctly, and preserve source on copy.
- Ensure tag chips render from `#m`, remain rendered while active/selected, and disappear when reduced to `#`.
- Render `---`, `***`, and `___` as horizontal rules only when the line is inactive and complete per ADR behavior.
- Reveal the original horizontal-rule marker line when the caret is on the line or the selection touches the source.
- Preserve exact horizontal-rule source for copy/cut and keep visual rule chrome out of clipboard text.

Acceptance criteria:

- Incomplete inline/link/wiki syntax remains plain.
- Escaped delimiters/markers do not preview.
- Selection inside visible content stays rendered where ADR requires; selection touching hidden syntax reveals source.
- Copy tests preserve exact markdown source.
- Complete `---`, `***`, and `___` render only while inactive; caret/selection reveal exact source.
- Incomplete or escaped horizontal-rule syntax remains plain source text.
- Horizontal-rule copy/cut preserves original markdown source and undo restores the same source.
- No regex parser scans or public API expansion are introduced.

### Goal 6: Plain Blockquote and Non-Collapsed Callout Rendering/Commands

Touchpoints:

- `packages/editor/src/live-preview/renderers.ts`
- `packages/editor/src/live-preview/markdown-code-context.ts`
- `packages/editor/src/markdown-list-commands.ts` or a private markdown block command module
- `apps/desktop/src/renderer/src/styles.css`
- `tests/editor-live-preview-callouts.test.ts`
- `tests/editor-markdown-keymap.test.ts`
- new/extended blockquote command tests

Deliverables:

- Plain `> ` blockquotes render immediately while `>` alone stays plain.
- Tab/Shift+Tab add/remove quote levels through command helpers; top-level Shift+Tab unwraps.
- Detect complete non-collapsed callout title syntax `> [!type] Title`; apply known/generic styling and body containment for quoted following lines.
- Prevent Tab/Shift+Tab indentation on callout title lines while allowing body quote nesting.
- Do not implement fold/collapse chevrons or hidden-body behavior in this goal.

Acceptance criteria:

- Blockquote selection stays rendered and copy preserves source.
- Incomplete or escaped `>`/callout marker syntax remains literal source.
- Active caret/selection behavior reveals syntax only where ADR requires; inactive complete blockquotes/callouts render.
- Non-collapsed callouts style correctly without adding or mutating fold markers.
- Tab/Shift+Tab and Enter behavior for quote/body lines is source-mutating through commands and undoable.
- Renderer code projects visuals only; source changes remain in command modules.

### Goal 7: Callout Fold/Collapse Behavior

Touchpoints:

- `packages/editor/src/live-preview/renderers.ts` / private callout widget modules
- `packages/editor/src/live-preview/source-text.ts`
- private collapse policy module from Goal 3
- `apps/desktop/src/renderer/src/styles.css`
- `tests/editor-live-preview-callouts.test.ts`
- `tests/editor-live-preview-clipboard.test.ts`
- `tests/editor-live-preview-selection-mapping.test.ts`

Deliverables:

- Add fold state support for `+`/`-` callout markers only after Goal 3 policy is accepted.
- Chevron widgets dispatch commands/actions to mutate only existing fold markers.
- Collapsed body hiding uses shared collapsed-selection/copy semantics and never deletes source.

Acceptance criteria:

- Callout chevron mutates only existing `+`/`-` fold markers and never adds a fold marker to normal callouts.
- Collapsed/expanded selection, title-only copy, crossing-hidden-body copy, cut/delete, and undo behavior are covered by tests from the Goal 3 architecture.
- Incomplete/escaped fold marker syntax remains literal source and does not create a collapse control.
- Visual-only controls/placeholders are not copied.

### Goal 8: Toggle Syntax and Non-Collapsed Rendering

Touchpoints:

- New private `packages/editor/src/live-preview/toggle-*` modules as needed
- `packages/editor/src/live-preview/renderers.ts` or block registration path
- `packages/editor/src/markdown-list-commands.ts` or a private markdown toggle command module
- `apps/desktop/src/renderer/src/styles.css`
- new `tests/editor-live-preview-toggle-lists.test.ts`
- `tests/editor-markdown-keymap.test.ts`

Deliverables:

- Start with Architect review before implementation to approve the private parser-extension path for non-standard `>>+` / `>>-` syntax, confirm whether a private Markdown parser facade, Lezer extension, or approved parser-owned char scanner is used, and expand `tests/editor-live-preview-no-regex-parsers.test.ts` to every new parser-adjacent module.
- Implement persisted `>>+ ` and `>>- ` syntax and shorthand `>> ` / `>> # Heading` auto-conversion to expanded toggles.
- Implement title rendering/editing interactions, keyboard toggle dispatch on focused chevron, and empty expanded-toggle placeholder behavior.
- Use Goal 2 indentation primitives for containment with 4 spaces or one tab as one unit and 4-space auto-created children.
- Implement Enter behavior for expanded titles and child content; exit through Shift+Tab or Backspace at logical line start.
- Defer collapsed subtree hiding/selection/copy to Goal 9 if needed.

Acceptance criteria:

- `>>`, `>>+`, and `>>-` without trailing space remain plain text.
- Escaped toggle-like syntax remains literal source.
- Shorthand conversion, Enter, Tab, Shift+Tab, and Backspace-at-logical-start mutations are command-owned, source-preserving where applicable, and undoable.
- Active/inactive selection behavior is covered for toggle marker, title text, and placeholder; selection touching marker syntax reveals source when required by ADR.
- Copy/cut preserves exact toggle source and excludes visual-only chevrons/placeholders.
- Toggle syntax/rendering works without regex parser scans and without public API expansion.
- Empty expanded toggles show a visual-only placeholder that is not copied.
- Indentation containment tests cover spaces, tabs, children, siblings, and outdent edge cases.

### Goal 9: Toggle Collapse, Selection, Copy, and Subtree Commands

Touchpoints:

- Private toggle command/collapse modules from Goal 8
- collapse policy module from Goal 3
- `tests/editor-live-preview-toggle-lists.test.ts`
- `tests/editor-live-preview-clipboard.test.ts`
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-markdown-keymap.test.ts`

Deliverables:

- Implement collapse/expand source mutation changing only `+`/`-` where applicable.
- Hide collapsed toggle children visually while preserving exact source and copy behavior.
- Implement subtree outdent behavior for current block plus following same-level siblings and nested subtrees.

Acceptance criteria:

- Collapsed toggles hide children visually without deleting source.
- Toggle source mutation changes only the collapse marker.
- Selection/copy tests cover collapsed children, title-only selections, crossing hidden body/children, visual-only placeholders, and full subtree copy.
- Cut/delete/undo behavior follows the Goal 3 collapsed-source architecture and does not silently drop hidden descendants.
- Subtree outdent behavior preserves containment and sibling boundaries.

### Goal 10: Final Quality Gate and Regression Lock

Touchpoints:

- All changed tests under `tests/*.test.ts`
- `docs/architecture/adr-0003-markdown-live-preview-editing-model.md` only if implementation status notes are explicitly requested

Deliverables:

- Run focused tests after each goal and `pnpm quality:fast` at the end.
- Add regression coverage for code blocks, images/embeds, and tables remaining unchanged.
- Add final regression expectations for render triggers, incomplete/escaped syntax, active/inactive selection behavior, copy/cut source preservation, Enter/Tab/Shift+Tab behavior, undoable source mutations, and no-regex parser ownership across all new parser modules.
- Document deferred ADR behavior as explicit follow-up tasks rather than silent gaps.

Acceptance criteria:

- `pnpm test tests/<changed-test>.test.ts` passes for every touched test file during goals.
- `pnpm test tests/editor-live-preview-no-regex-parsers.test.ts` passes after parser-adjacent changes.
- `pnpm quality:fast` passes before execution handoff completion.
- No package-boundary/API-wiring regressions and no unreviewed public exports.
- ADR behavior matrix is satisfied or each remaining gap is explicitly documented as a follow-up with owner and blocked reason.

## Risks and Mitigations

- Risk: collapsed selection/copy semantics are harder than source-preserving decorations. Mitigation: dedicate Goal 3 before fold/toggle work and require tests before implementation proceeds.
- Risk: indentation semantics drift between lists, blockquotes, callouts, and toggles. Mitigation: implement shared indentation primitives first and make later goals consume them.
- Risk: parser convenience introduces regex scans in live preview. Mitigation: keep `tests/editor-live-preview-no-regex-parsers.test.ts` in every parser-adjacent verification set and prefer CodeMirror/lezer syntax tree/facades or approved char scanners.
- Risk: helper exposure leaks into public APIs. Mitigation: default to private modules; require API review for any root export or platform/plugin contract proposal.
- Risk: renderer/widget/command responsibilities blur. Mitigation: acceptance criteria require renderers to project visuals, widgets to dispatch, and commands to mutate source.
- Risk: ordered list/task changes conflict with current conservative commands. Mitigation: add ordered-specific tests before command changes.

## Verification Plan

Per goal:

- Run focused Vitest files for changed behavior, e.g. `pnpm test tests/editor-live-preview-primitives.test.ts`, `pnpm test tests/editor-markdown-list-commands.test.ts`, `pnpm test tests/editor-live-preview-callouts.test.ts`, or new toggle tests.
- Run `pnpm test tests/editor-live-preview-no-regex-parsers.test.ts` for any parser-adjacent module change, including new private parser facades, Lezer extensions, or approved char-scanner modules outside `packages/editor/src/live-preview`.
- Run `pnpm lint` or `pnpm typecheck` when changing command modules, renderer seams, or TypeScript types.

Final:

- `pnpm quality:fast`
- `pnpm lint:boundaries` if new modules or aliases are introduced.
- If CSS/layout changes are significant: `pnpm test tests/desktop-live-preview-styles.test.ts`.

## Available Agent Types and Suggested Staffing

- `planner`: maintain ultragoal ledger, split deferred behavior, and update plan/ADR notes.
- `architect`: review primitive boundaries, parser ownership, private helper design, and renderer/widget/command separation before Goals 4 and 7; perform a required toggle parser-extension review immediately before Goal 8.
- `critic`: review each goal for scope creep, missing copy/selection tests, API leaks, and ADR mismatches.
- `executor`: implement one durable goal at a time with tests first.
- `code-review`: review completed diffs for correctness, test adequacy, parser/API boundaries, and source preservation.
- `general` / `explore` / `explorer`: perform bounded repo lookups when a goal needs extra context.
- `ultragoal`: recommended execution coordinator for the full sequence.
- `autoresearch` / `autoresearch-goal`: not needed unless execution uncovers unresolved CodeMirror behavior requiring validator-gated research.

## Execution Handoff Guidance

Use `ultragoal` to create durable repo-native goals matching the sequence above. Each goal should:

1. Start by adding or updating tests for the specific ADR behaviors and constraints in that slice.
2. Implement the smallest private renderer/command/widget/style changes needed for those tests.
3. Run focused tests before moving on.
4. Stop and record explicit follow-ups rather than broadening the patch.

Do not implement all ADR 0003 behavior in one patch. Do not start lists/tasks/toggles before indentation primitives. Do not start fold/collapse/toggle hiding before collapsed-selection/copy architecture is accepted. Do not modify out-of-scope code block/image/embed/table behavior except to protect it with tests.

## Stop Rules

- Stop a goal when its acceptance criteria and focused tests pass.
- Stop and return to planning if a goal requires public API expansion, platform/plugin contract changes, renderer/preload exposure, or a materially different editing model than ADR 0003.
- Stop the whole execution sequence after Goal 10 passes `pnpm quality:fast` or when remaining ADR items are explicitly documented as follow-ups.
