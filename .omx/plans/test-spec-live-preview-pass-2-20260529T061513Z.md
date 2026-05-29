# Test Spec — Live Preview Pass 2: Source-Backed Task and Replace-Preview Foundation

Status: Ralplan consensus approved  
Date: 2026-05-29

## Test Objectives

1. Prove task checkbox interaction mutates Markdown source only through CodeMirror transactions.
2. Prove preview decorations and replace-preview behavior preserve source text unless an explicit command mutates it.
3. Prove current Markdown keymap behavior is understood and protected before custom input work.
4. Protect editor ownership, autosave, extension composition, and import boundaries from regression.

## Unit / Primitive Tests

### Task marker parsing

- Detect unchecked marker in `- [ ] task` and return the exact bracket/range.
- Detect lowercase checked marker in `- [x] task`.
- Detect uppercase checked marker in `- [X] task` and apply the documented normalization/toggle policy.
- Detect nested/indented markers such as `  - [ ] nested`.
- Reject non-task lines such as `- item`, `[ ] not a task`, code spans, and table rows.
- Preserve leading bullet and whitespace exactly.

### Task toggle command

- Cursor on marker toggles unchecked → checked.
- Cursor elsewhere on same task line toggles according to documented policy.
- Checked marker toggles back to unchecked.
- Non-task line is a no-op.
- Multiple unrelated lines remain byte-for-byte unchanged.
- Transaction changes only the marker bracket content or documented marker span.

### Live Preview active/inactive behavior

- Inactive task marker receives preview class.
- Focused cursor intersecting task marker reveals source by removing preview decoration.
- Moving cursor away restores preview decoration.
- Preview-only rendering does not mutate `EditorState.doc`.

### Replace-preview primitive

- Inactive chosen marker family renders with replace-preview behavior.
- Focused selection intersection reveals raw source.
- Adjacent chosen marker ranges remain deterministic.
- Replace-preview preserves `EditorState.doc`.
- Undo/redo after unrelated text edits does not corrupt preview state.

## Mounted Editor / Integration Tests

### Mounted task toggle

- Mounted editor command toggles source and `getText()` reflects the new Markdown.
- `onChange` receives the toggled source exactly once for user-command dispatch.
- Undo returns source to previous text.
- Redo reapplies source change if supported in the mounted test harness.
- External `setText()` remains silent by default.
- Stale external replacement does not echo as a user edit after a newer toggle.

### Markdown keymap behavior

- Enter on unordered list uses current CodeMirror Markdown continuation behavior.
- Enter on task list uses current CodeMirror Markdown continuation behavior if provided.
- Backspace at empty continued list/task item uses current CodeMirror Markdown deletion behavior if provided.
- Enter/Backspace on blockquote uses current CodeMirror behavior if provided.
- If a desired behavior fails, add a failing test before composing an official CodeMirror extension/keymap.

### Existing mounted behavior

- `Mod-s` save shortcut still fires through the mounted editor factory.
- Plugin extension composition still guards unsupported `unknown` extension values.
- Default Live Preview renderers are still wired into mounted editors.

## Desktop Regression Tests

- Desktop markdown autosave still writes the latest source snapshot.
- Desktop vault/editor service can create, open, edit, save, snapshot, and restore as before.
- Desktop Live Preview styles remain scoped to `.markdown-editor` if any CSS changes are made.

## Static / Boundary Tests

- `pnpm --filter @zorid/editor run typecheck`
- `pnpm lint:boundaries`
- `pnpm typecheck`
- `pnpm lint`

## Manual / Optional Smoke Checks

- Open a note with headings, inline code, links, tags, and tasks.
- Toggle a task and confirm the Markdown file source changes from `[ ]` to `[x]` or back.
- Move the cursor into and out of the chosen replace-preview range and confirm raw source reveal/restore.
- Confirm normal typing and autosave still use Markdown source.

## Non-Goals for This Test Pass

- No screenshot/pixel-diff acceptance for full Obsidian parity.
- No table widget tests.
- No properties/frontmatter UI tests.
- No embeds/callouts/math/image widget tests.
- No Reading view parity tests.
- No public plugin renderer API tests.

## Completion Gate

The pass is complete only when:

- New task toggle tests pass.
- New keymap behavior tests pass or explicitly document unchanged/deferred behavior.
- New replace-preview tests pass for the selected tiny slice.
- Existing editor and desktop regression tests listed in the PRD pass.
- Editor typecheck and import boundaries pass.
- Any deferred click handling is documented in tests or implementation notes as deliberately out of scope.
