# PRD — Lezer Live Preview Parser Migration

Status: RALPLAN consensus approved
Date: 2026-05-30
Scope: Replace every regex-driven Markdown recognition path in `packages/editor/src/live-preview` with CodeMirror/Lezer syntax-tree parsing, and represent current custom syntax as private Lezer Markdown extensions. This is a Live Preview parser migration only: no Reading view migration, no public plugin API, no UI redesign, no new syntax features, and no editor replacement.

## Requirements Summary

Zorid's Live Preview currently projects Markdown source into marks, replacements, line decorations, and widgets by scanning text with regexes. That has already produced incorrect task-checkbox behavior because line-oriented regexes can overmatch and because suppression logic is duplicated outside the editor parser. The migration should make the CodeMirror Markdown parser the single semantic source for Live Preview recognition.

The desired end state is a private Lezer-backed parser/matcher layer where:

1. `packages/editor/src/live-preview` no longer contains regex/matchAll/exec parser paths for Markdown recognition, suppression, task toggling, or widget grouping.
2. Existing Live Preview behavior is preserved for headings, inline code, strong/emphasis/strikethrough/highlight, Markdown links, wiki links, tags, blockquotes, task checkboxes, fenced-code widgets, and callout widgets.
3. Existing custom syntax is represented through private `@lezer/markdown` extensions or syntax-tree nodes, not ad-hoc scanners.
4. Renderer output remains source-preserving CodeMirror decorations over canonical Markdown text.
5. Validation includes targeted fixtures, a static no-regex parser check, typecheck/lint, full tests, and a performance/no-worse gate.

## Grounding Evidence

### Repo-local evidence

- Deep Interview spec: `.omx/specs/deep-interview-lezer-live-preview-parsers.md:16-89` defines scope, non-goals, decision authority, and acceptance criteria.
- Editor installation: `packages/editor/src/index.ts:129-159` installs `markdown()` and wires Live Preview defaults into `livePreviewExtensionWithInternalRenderers`.
- Current regex parser paths:
  - `packages/editor/src/live-preview/renderers.ts:41-45` defines inline/strong/emphasis/strikethrough/highlight regexes.
  - `packages/editor/src/live-preview/renderers.ts:358-386` implements the generic `regexLivePreviewRenderer` matcher.
  - `packages/editor/src/live-preview/renderers.ts:388-547` registers regex-backed heading, inline, link, wiki-link, tag, task-marker, callout, blockquote, and widget range logic.
  - `packages/editor/src/live-preview/markdown-code-context.ts:27-147` uses regex/line scanning for fenced code, indented code, and frontmatter suppression.
  - `packages/editor/src/live-preview/task-toggle.ts:16-39` uses a task-marker regex and fenced-code guard for interactive toggles.
- Current contracts to preserve or intentionally migrate:
  - `packages/editor/src/live-preview/types.ts:13-43` defines `LivePreviewContext`, `LivePreviewRange`, and `LivePreviewRenderer.match(context)`.
  - `packages/editor/src/live-preview/internal-types.ts:4-28` extends ranges for internal line/widget projections.
  - `packages/editor/src/live-preview/block-renderers.ts:20-45` adapts private block renderers into widget ranges.
  - `packages/editor/src/live-preview/extension.ts:174-208` owns widget-first suppression and deterministic range sorting.
  - `packages/editor/src/live-preview/extension.ts:120-166` owns bounded visible/near-visible scan windows.
- Existing tests cover behavior and regression surfaces:
  - Preview/reveal primitives: `tests/editor-live-preview-primitives.test.ts:23-180`.
  - Semantic suppression/frontmatter/code fixtures: `tests/editor-live-preview-semantic-fixtures.test.ts:27-112`.
  - Widget viewport/suppression/code widgets: `tests/editor-live-preview-widgets.test.ts:65-240`.
  - Callout widgets and suppression: `tests/editor-live-preview-callouts.test.ts:49-150`.
  - Task toggle/source-preserving mutations: `tests/editor-task-toggle.test.ts:21-279`.
  - Performance/viewport fixtures: `tests/editor-live-preview-performance-fixtures.test.ts:17-97`.
- Dependency facts:
  - Root `package.json:32-35` and `packages/editor/package.json:18-23` already include CodeMirror packages.
  - `pnpm-lock.yaml:3132-3140` resolves `@codemirror/lang-markdown@6.5.0` with `@lezer/markdown@1.6.3` transitively.
  - `pnpm-lock.yaml:3525-3528` resolves `@lezer/markdown@1.6.3` and `@lezer/common@1.5.2`.

### Official/upstream evidence

- CodeMirror Markdown support exposes `markdown(config)` and `config.extensions?: MarkdownExtension`; `markdownLanguage` includes GFM plus subscript/superscript/emoji support. Source: https://code.haverbeke.berlin/codemirror/lang-markdown (current package docs; `@codemirror/lang-markdown` 6.5.0 in repo).
- `@lezer/markdown` produces Lezer-style syntax trees, not HTML, and its `MarkdownConfig` supports `defineNodes`, `parseBlock`, `parseInline`, `remove`, `wrap`, and nested extension arrays. Source: https://code.haverbeke.berlin/lezer/markdown (`@lezer/markdown` 1.6.4 upstream as of 2026-05-28; repo lock has 1.6.3).
- `@lezer/markdown` GFM includes `TaskList`, `Strikethrough`, `Table`, and `Autolink`; TaskList supports `[ ]`/`[x]` prefixes on list items. Source: https://code.haverbeke.berlin/lezer/markdown.
- CodeMirror language APIs expose `syntaxTree(state)`, `ensureSyntaxTree(state, upto, timeout)`, `syntaxTreeAvailable(state, upto)`, and `forceParsing(view, upto, timeout)`; `syntaxTree` may be incomplete. Source: https://codemirror.net/docs/ref/.
- Lezer trees are cheap concrete syntax trees; clients should use `TreeCursor`, `SyntaxNode`, or `Tree.iterate` for traversal. Source: https://lezer.codemirror.net/docs/ref/.

## RALPLAN-DR Summary

### Principles

1. **Parser is source of semantics**: Live Preview semantic recognition comes from CodeMirror/Lezer parser nodes, not regex text scanning.
2. **Source remains canonical**: Widgets and marks are disposable projections over Markdown text; no separate document model.
3. **Private migration before public surface**: Internal renderer contracts may change, but no public plugin API is introduced.
4. **Parity before expansion**: Existing previews and interactions must survive before adding any new feature.
5. **Bounded work stays explicit**: Syntax-tree traversal must remain viewport/near-viewport bounded unless a test justifies a narrow exception.

### Decision Drivers

1. The current regex system is duplicated across renderers, suppression helpers, task toggles, and widgets, so partial replacement would keep the root cause.
2. CodeMirror already installs Markdown support and has official extension/tree APIs suitable for private custom syntax.
3. Parser completeness and viewport behavior are non-trivial; migration must make partial parse handling and performance gates first-class.

### Viable Options

#### Option A — Lezer language facade + syntax-node collector layer (preferred)

Approach: Add a private Zorid Markdown language module that composes `markdown({ extensions: [...] })`; add a tree-backed Live Preview collector facade that derives existing range objects from syntax nodes; migrate renderers/task toggle/suppression to consume collector output while preserving decoration and widget seams.

Pros:
- Centralizes parser configuration and all custom syntax nodes.
- Minimizes disruption to CodeMirror decoration code by keeping `LivePreviewRange` output shape.
- Gives static tests a single target: no regex parser paths in live-preview production code.
- Supports staged migration behind private contracts without exposing a plugin API.

Cons:
- Requires careful mapping from Lezer node names/ranges to current CSS/range semantics.
- Initial custom extensions for wiki links, tags, highlights, frontmatter, and callouts must be robust enough to replace regex scanners.
- Tests must be rewritten from regex range expectations to syntax-tree behavior, which is wider than a local bug fix.

#### Option B — Direct renderer-by-renderer Lezer traversal

Approach: Keep each renderer module mostly intact, but replace each regex matcher with direct `syntaxTree(state).iterate` logic scoped to that renderer.

Pros:
- Smaller conceptual jump for each renderer.
- Easier to review one syntax at a time.
- Allows localized test failures to guide migration.

Cons:
- Risks duplicating tree traversal, suppression, and parse-completeness policy across renderers.
- Makes custom syntax extension ownership less clear.
- Static “no regex parser” can pass while design still fragments parser semantics.

#### Option C — Standalone `@lezer/markdown` parse per Live Preview pass

Approach: Do not use CodeMirror state language trees. Parse the relevant document slice manually with `@lezer/markdown` whenever Live Preview collects ranges.

Pros:
- Simple in unit tests.
- Avoids partial editor parse timing questions.
- Can be implemented behind one collector function.

Cons:
- Duplicates CodeMirror's parser work and risks worse performance.
- Harder to coordinate with editor viewport, incremental parsing, and installed language extensions.
- More likely to drift from what CodeMirror highlights/understands.

### Preferred option

Use **Option A**. Build a private `zoridMarkdown()`/language-extension facade and a private `collectLivePreviewSyntaxRanges(...)` facade. Keep existing range and decoration behavior as the output contract while changing the recognition input from regex text to syntax nodes.

Reject Option B as the final architecture because it keeps parser policy scattered, though it may be used internally as a short-lived stepping stone while migrating individual renderers. Reject Option C because it duplicates parser work and weakens integration with CodeMirror's incremental/viewport parse model.

## Acceptance Criteria

1. **No live-preview regex parser paths**
   - Production files under `packages/editor/src/live-preview` contain no regex literals, `RegExp`, `.match`, `.matchAll`, or `.exec` used for Markdown recognition.
   - A source/static test enforces the rule and lists intentional non-parser exceptions if any are absolutely necessary. Target final state is zero exceptions in live-preview production code. The retained `LivePreviewRenderer.match(context)` method name is not itself a forbidden regex/String match call.
2. **Lezer-backed parser ownership**
   - `packages/editor/src/index.ts` installs a private Zorid Markdown language support wrapper rather than bare `markdown()`.
   - Custom syntaxes currently recognized by Live Preview are represented by `@lezer/markdown` extensions or syntax-tree nodes.
   - Built-in GFM support is reused for TaskList and Strikethrough instead of reimplemented with regex.
3. **Current behavior preserved**
   - Existing tests for headings, inline code, strong, emphasis, strikethrough, highlight, Markdown links, wiki links, tags, blockquotes, task checkboxes, fenced-code widgets, callout widgets, reveal semantics, source preservation, and widget suppression pass with updated tree-backed expectations.
4. **Checkbox bug fixture**
   - Add regression fixtures for malformed/adjacent task marker text such as `- [ ]f- [ ]a 4- [ ]- [ ]`.
   - The fixture proves no newline-spanning checkbox ranges and no task widgets/toggle targets unless the parser identifies a real task-list marker.
5. **Suppression and context from tree**
   - Fenced code, indented code, frontmatter, callout widget bodies, and inactive widgets suppress overlapping previews via syntax-tree/container ranges rather than line regex scanners.
6. **Performance no worse**
   - Existing viewport/performance fixtures pass.
   - New tests or instrumentation prove tree traversal is bounded to visible/near-visible ranges and does not force full-document parsing for normal viewport rebuilds.
7. **Quality gates**
   - Targeted live-preview tests pass.
   - `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass before implementation is considered complete.

## Implementation Plan

### Phase 0 — Lock behavior and define the forbidden-pattern gate

- Add/extend tests before migration:
  - Malformed adjacent task marker fixture in `tests/editor-task-toggle.test.ts` and/or `tests/editor-live-preview-semantic-fixtures.test.ts`.
  - Source/static test, likely `tests/editor-live-preview-no-regex-parsers.test.ts`, that scans production live-preview files and the private Zorid Markdown/parser-extension module for forbidden parser tokens. Prefer AST/token-aware scanning over brittle raw grep where practical; explicitly allow the renderer API method name `match(context)` if that seam remains.
  - Barrel/export compatibility test for `packages/editor/src/live-preview/index.ts` so removing or replacing markdown context helpers is intentional and source-compatible where required.
  - Syntax-tree fixture tests that assert node/range extraction for existing syntax before decoration rendering.
  - Parser-order fixtures for frontmatter and callouts so private block extensions have explicit precedence expectations.
- Make the static test fail against current code first, then migrate until it passes.
- Keep the existing behavior tests as parity gates; update only expected implementation details, not product behavior.

### Phase 1 — Introduce private Zorid Markdown parser facade

- Add a private module such as `packages/editor/src/live-preview/markdown-language.ts` or `packages/editor/src/live-preview/zorid-markdown-language.ts`.
- Export a function used by `packages/editor/src/index.ts` instead of raw `markdown()`.
- Compose built-in Markdown/GFM support plus private extensions for current custom syntax:
  - built-in/common nodes: headings, emphasis/strong, inline code, links, blockquote, fenced code, indented code, GFM task list, GFM strikethrough;
  - private inline extensions: wiki links, tags, highlights;
  - private block/container extensions: frontmatter and callout markers/groups as needed for current behavior.
- Add direct package dependencies only where imports require them (`@codemirror/language`, `@lezer/markdown`, `@lezer/common`, possibly `@lezer/highlight` if node styling needs direct tags). Keep versions compatible with the installed lockfile.

### Phase 2 — Add tree-backed Live Preview collection facade

- Add a module such as `packages/editor/src/live-preview/syntax-ranges.ts` that:
  - is tested with editor states that install the private Zorid Markdown language support, not bare `EditorState.create({ doc })` without language data;
  - obtains a syntax tree with `ensureSyntaxTree(state, upto, timeout)` for the relevant visible/near-visible upper bound, falling back only in a documented/tested way;
  - traverses with `Tree.iterate` or `TreeCursor` over the requested window;
  - emits a normalized private match model containing `rendererId`, source range, activation range, syntax node name, and optional semantic payload (task checked state, code info/body, callout type/title/body);
  - exposes helpers for suppression/container ranges from syntax nodes.
- Keep `LivePreviewRange` and `InternalLivePreviewRange` as the output to decoration assembly unless implementation evidence shows a narrower internal change is required.
- Centralize mapping from node names to renderer IDs so renderer modules do not each reimplement parse traversal policy.

### Phase 3 — Migrate public inline/mark renderers

- Replace `regexLivePreviewRenderer` and inline pattern constants with node-backed collectors for:
  - heading;
  - inline code and inline-code delimiter ranges;
  - strong/emphasis;
  - strikethrough via GFM;
  - highlight via private extension;
  - Markdown links;
  - wiki links via private extension;
  - tags via private extension.
- Preserve current CSS class names and reveal behavior.
- Preserve exclusion semantics inside inline code, fenced/indented code, frontmatter, and widgets via syntax node containment, not regex suppression.

### Phase 4 — Migrate internal line/widget renderers and task toggle

- Replace blockquote line matching with blockquote syntax-node traversal.
- Replace task marker rendering and `findTaskMarkerAtPosition` with GFM TaskList/list-item node traversal.
- Replace fenced-code widget matching with fenced-code syntax nodes, preserving info string, code body, activation boundaries, pointer activation, and complete-fence behavior.
- Replace callout widget grouping with private callout nodes or syntax-node-derived blockquote groups. Preserve current grouping fixtures: conservative marker type, quoted body lines, quoted blank lines, no lazy continuation unless already fixture-locked, nested raw unless safely represented.
- Replace `markdown-code-context.ts` regex helpers with syntax-node range helpers or delete the module if the syntax range facade subsumes it.

### Phase 5 — Delete regex parser helpers and harden static gates

- Remove `regexLivePreviewRenderer`, regex constants, and line scanners from production live-preview code.
- Ensure task toggle and suppression no longer call regex helpers.
- Run and strengthen the static source check until final state has no live-preview regex parser exceptions.
- Keep any non-parser string operations explicit and documented; avoid hiding parser logic in “utility” functions.

### Phase 6 — Full verification and performance pass

- Run targeted suites first:
  - `pnpm vitest run tests/editor-live-preview-primitives.test.ts tests/editor-live-preview-semantic-fixtures.test.ts tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-callouts.test.ts tests/editor-task-toggle.test.ts tests/editor-live-preview-performance-fixtures.test.ts`
- Run project gates:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm perf:smoke` if migration performance remains uncertain after test evidence.
- Compare performance fixture behavior before/after where practical, including a short before/after timing note when fixture evidence is borderline; if no benchmark harness exists, preserve and extend current bounded-window tests as the minimum “no worse” signal.

## Risks and Mitigations

- **Risk: parser tree incomplete for requested viewport.** Mitigation: use `ensureSyntaxTree(state, upto, boundedTimeout)` or `syntaxTreeAvailable` checks for required bounds; document fallback behavior and test partial parse tolerance.
- **Risk: custom Lezer extensions become regex parsers in disguise.** Mitigation: allow character-by-character delimiter checks and Lezer APIs, but forbid broad regex/matchAll scanners in extension implementation; review custom parsers with the static gate.
- **Risk: exact current regex quirks become impossible or undesirable to preserve.** Mitigation: preserve product-visible behavior, not bugs; checkbox malformed fixture explicitly rejects current bad behavior.
- **Risk: performance regresses due to whole-document syntax traversal.** Mitigation: traverse by visible/near-visible windows, preserve widget scan margin policy, and add instrumentation tests for traversal bounds.
- **Risk: public renderer exports imply plugin API breakage.** Mitigation: keep public root exports source-compatible where reasonable but treat internal renderer contracts as private; do not add new public plugin API.
- **Risk: frontmatter/callout parsing is awkward in Lezer Markdown.** Mitigation: implement private `parseBlock`/`parseInline` extensions with explicit fixtures; defer visual expansion rather than reintroducing regex fallback.

## ADR

### Decision

Adopt a private Lezer/CodeMirror syntax-tree-backed Live Preview parser layer and migrate all Live Preview Markdown recognition from regex scanners to parser nodes.

### Drivers

- User explicitly requires no live-preview regex parsers and custom syntax via Lezer.
- Current regex parsers are spread across renderers, suppression helpers, widgets, and task toggles.
- CodeMirror/Lezer already provide official Markdown extension and syntax-tree APIs in the installed editor stack.

### Alternatives considered

- Renderer-by-renderer direct traversal: usable as a temporary migration technique, rejected as final architecture because it scatters parse policy.
- Standalone `@lezer/markdown` parse per render pass: rejected because it duplicates CodeMirror parsing and weakens viewport/incremental behavior.
- Keep regex fallback for custom syntax: rejected by acceptance criteria except as a temporary internal step before final deletion.

### Why chosen

A private parser facade plus collector facade gives one parser configuration, one traversal policy, and a stable range output contract. It satisfies the deep-interview requirements while keeping editor decorations, source preservation, and tests grounded in current architecture.

### Consequences

- Implementation is a multi-phase migration, not a small patch.
- Tests will shift from regex-produced range assumptions to syntax-tree fixtures and behavior assertions.
- Some direct dependencies may be added for packages already present transitively.
- Future Live Preview syntax should start as parser nodes, not renderer-local text scans.

### Follow-ups

- After migration, consider whether public root Live Preview exports should be marked more explicitly experimental or moved behind private/internal paths.
- If performance fixtures are insufficient, add a benchmark/perf smoke case specific to syntax-tree traversal.
- Only after several private syntaxes stabilize should a public plugin syntax/rendering API be reconsidered.

## Available-Agent-Types Roster

- `explore` — fast repo mapping and symbol/file evidence.
- `researcher` — official/upstream docs for CodeMirror/Lezer APIs.
- `dependency-expert` — direct dependency/version/license evaluation if package changes become contentious.
- `architect` — parser/language boundary and contract review.
- `executor` — implementation lanes.
- `test-engineer` — fixture design, static gate, and performance test coverage.
- `critic` / `code-reviewer` — plan/diff review and regression risk challenge.
- `verifier` — final claim validation and evidence collection.

## Follow-up Staffing Guidance

### Recommended default: `$ultragoal`

Use `$ultragoal` for durable sequential ownership because this is a multi-phase migration with hard gates. Suggested lanes/checkpoints:

1. Test-engineer checkpoint: failing static/no-regex and checkbox bug fixtures.
2. Architect/executor checkpoint: private Zorid Markdown parser facade and dependency wiring.
3. Executor checkpoint: syntax range collector + migrated inline renderers.
4. Executor checkpoint: internal widgets/task toggle/suppression migration.
5. Verifier checkpoint: static gate, targeted tests, lint/typecheck/full test/perf evidence.

### Parallel path: `$team + $ultragoal`

Use Team for parallel implementation only after Phase 0 and Phase 1 land, because later lanes can split by renderer family.

Suggested Team lanes:

- Lane A (`executor`, medium): parser facade, dependency wiring, and syntax range collector ownership.
- Lane B (`executor`, medium): public inline/mark renderers and syntax node mapping.
- Lane C (`executor`, medium): internal widgets, callouts, blockquotes, fenced code.
- Lane D (`executor`, medium): task toggle and checkbox regression fixtures.
- Lane E (`test-engineer`, medium): static no-regex gate, performance fixtures, and parity tests.
- Lane F (`verifier`, high): integration verification and source/public export audit.

### `$team` launch hints

- `$team "Implement .omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md with test spec .omx/plans/test-spec-lezer-live-preview-parser-migration-20260530T031309Z.md; split lanes by parser facade, inline renderers, widgets/task toggle, and verification."`
- `omx team --agents 5 --prompt "Lezer Live Preview parser migration from .omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md"`

### Team verification path

Team must return checkpoint evidence for: no-regex static gate, checkbox bug fixture, custom syntax nodes/extensions, targeted live-preview suites, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and performance/no-worse evidence. Ultragoal should checkpoint those artifacts as durable completion proof.

### Ralph fallback

Use `$ralph` only if the user explicitly wants a persistent single-owner verification/fix loop instead of durable goal tracking. It is not the recommended default for this migration.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — recommended default for this implementation migration.
- `$team + $ultragoal` — recommended if parallel delivery is desired after parser facade boundaries are set.
- `$performance-goal` — only if syntax-tree traversal causes measurable performance regression requiring a dedicated optimization workflow.
- `$autoresearch-goal` — not recommended; the required external research is already sufficient for planning.


## RALPLAN Changelog

- Applied Architect improvement: static no-regex gate must cover private parser-extension modules, not only existing live-preview files.
- Applied Architect improvement: add barrel/export compatibility coverage for `live-preview/index.ts`.
- Applied Architect improvement: add parser-order fixtures for frontmatter/callouts.
- Applied Architect improvement: collector tests must install the private Markdown language support.

- Applied Critic improvement: clarify `LivePreviewRenderer.match(context)` is not a forbidden regex/String match call.
- Applied Critic improvement: prefer AST/token-aware no-regex static checks over brittle grep where practical.
- Applied Critic improvement: require before/after timing notes when performance fixture evidence is borderline.
