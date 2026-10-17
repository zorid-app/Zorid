# Canvas Markdown visual consistency

Owner: editor_cross_review. Branch `tingkai-c/canvas-markdown-visuals`, Orca
worktree `canvas-markdown-visuals`, based on main `906dab6`. The independent
Canvas interaction worker owns `view.ts`/`view.css` scrolling, toolbar and resize
behavior. This change owns card typography/source-spacing presentation, its
helper and tests, plus one stylesheet import in `src/main.ts`.

## Observed cause

The user supplied one selected-card screenshot and reported a difference when
switching edit mode; it is not a paired measurement. Source inspection found:

- `live-inline.css` overrides Live headings to e.g. H1 1.8em/650/1.35, while
  preview inherits the theme's 1.618em/700/1.2. This changes wrapping and height.
- Preview paragraphs use fixed margins and collapse soft line breaks. Live Edit
  retains source blank lines and physical soft breaks.
- The first Live heading has .65em top padding, while Reading's first heading
  has no top margin. Both surfaces otherwise have a 16px card inset.

## Bounded change

Paired card-local heading rules use the existing theme metrics on both surfaces, including inherited heading
syntax-highlight weights while retaining explicit strong text and widget styles.
The outer editor's first heading no longer adds top padding. Nested table cells
and embedded-note editors are outside these selectors; shared note-pane styles,
source storage, selection, undo, IME and scroll ownership are unchanged.

Ordinary cards made entirely of paragraphs and ATX headings receive preview
spacing derived from actual source blank lines. Soft line breaks, repeated
spaces and trailing empty lines retain their source geometry. Inline code uses
the Live font size and padding. This changes presentation, never note source or
the shared Reading renderer's DOM ownership.

The mapping is conservative: top-level lists, quotes, fences, tables, setext
headings, properties, replacement embeds and display math keep shared Reading
layout. Inline constructs that remove physical source lines (e.g. multiline
code spans or link destinations), and comment-only empty blocks, also retain that layout. Exact layout parity
for those rich blocks is not established by this change. Revealing Markdown
markers at the active caret may legitimately change that line's width.

## Verification status and acceptance

Independent source review identified the heading cascade, display-math class
and multiline-inline edge cases; source candidate `b1b4778` addresses them.
With the root coordinator's exclusive scoped slot, the following checks passed
on 2026-10-17 in this worktree using the existing root dependencies:

- `node --test --test-concurrency=1 tests/canvas-markdown-layout.test.ts tests/canvas-markdown.test.ts tests/canvas-markdown-focus.test.ts tests/canvas-file-editor.test.ts`
  passed all 46 tests, including eight new layout regressions (session 9150,
  exit 0). The original estimate of 42 tests was low; no extra suite was run.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed
  (session 7142, exit 0); `git diff --check` passed.
- Source-only comparison with main `90e7b91` found no changes since the base in
  the six owned paths or relevant renderer/editor/CSS dependencies.

The tests verify DOM/source mapping, retained controls and editor lifecycle;
they do not measure rendered geometry. No build, native app or browser pass was
launched. The runtime slot was released after these checks.

Pending rendered acceptance:

1. In an actual rendered card use an H1 plus three paragraphs, including a long
   wrapping paragraph. At widths 240px and 480px and Canvas zoom .5, 1 and 2,
   toggle preview/Live while keeping the caret in the final paragraph. Compare
   the heading's font/weight/line-height and the preceding paragraph bounds.
2. Repeat at text sizes 16px and 20px; verify the last line remains reachable,
   the caret maps to the clicked line, editing/undo preserve source, and a rich
   table/task/embed card retains its existing controls and scrolling.

Native, mobile and broad Markdown/reference parity remain unverified.
