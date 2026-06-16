# Ultragoal: ADR 0003 Foldable Callouts and Toggles

## Objective

Implement approved ADR 0003 support for foldable Obsidian callouts, toggle lists, and toggle headings while keeping source Markdown canonical and editable.

## Approved Behavior

- Stable rendered UI for callouts and toggles.
- Source reveals only at structural positions.
- Collapsed body/children are edited by expanding first.
- Collapsed copy/cut/selection semantics preserve source-backed behavior.
- Enter, Shift+Tab, Backspace, placeholder, CSS, and motion behavior are covered.
- Chevrons are pointer-clickable but not tabbable.
- Empty toggle placeholder is visual-only and clickable.
- Collapse/expand animates content and chevron at 120ms.
- Reduced motion disables content motion and chevron rotation.

## Architecture Constraints

- Source is canonical.
- Expanded callout/toggle title, body, and children remain CodeMirror-editable source-backed document content.
- Whole-block `Decoration.replace` or `MarkdownBlockRegistration` replacement is disallowed for expanded callouts/toggles.
- Existing `CalloutPreviewWidget` / `calloutMarkdownBlockRegistration` must be retired, bypassed, or limited for expanded states.
- Parser ownership stays with Lezer/Zorid parser facade or approved parser-owned character scanner; no ad hoc regex parser scans.
- Renderers project visuals, widgets dispatch commands/actions, and commands mutate source.
- No public API expansion.

## Goal Sequence

1. G001 Shared preview policy primitives and test fixtures.
2. G002 Editor-wide indentation primitives and visual-only guides.
3. G003 Collapsed selection/copy/cut architecture.
4. G004 List/task behavior regression and shared command alignment.
5. G005 Inline styling/link/tag/horizontal-rule regression alignment.
6. G006 Plain blockquote and non-collapsed callout rendering/commands, including no whole-block widget for expanded callouts.
7. G007 Callout fold/collapse behavior.
8. G008 Toggle syntax and expanded rendering.
9. G009 Toggle collapse, selection/copy, and subtree commands.
10. G010 Final quality gate and regression lock.
