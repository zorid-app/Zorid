# Blank-note and title-to-editor focus

This audit addresses the reported empty-note screenshot and title Enter losing the caret after creating/naming a note. It reuses the pinned Obsidian 1.14.4 artifact and existing partial E3 REA evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. These are static observations, not reference runtime tests. No recovered code was copied into the implementation.

Artifacts under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`:

- `app.js`: SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css`: SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.

Offsets are zero-based character offsets in decoded UTF-8 text. [editor-reference.md](editor-reference.md) records the related measured-coordinate, pointer selection and hidden-frontmatter investigation.

## Reference behavior

The editor wrapper at `app.js` 2602600–2603100 places CodeMirror content inside a content container within a sizing element. CSS at 118760–119740 makes the editor flexible, gives the sizing element a minimum full height and column layout, and stretches a flexible content container. Thus editable content can occupy the remaining note area below the title/properties. It is not constrained to the first empty line's height. Embedded table editors have separate sizing rules near CSS 128300–128850.

The shipped CodeMirror mousedown handler near JS 405299 uses measured coordinates and native mouse-selection machinery; the detailed mapping contract is recorded in editor-reference.md. The wrapper click handler at 2607735 closes editor suggestions and schedules highlight removal; this bounded branch does not establish a separate arbitrary-wrapper click-to-end handler. The reconstruction's wrapper handler below is an original adaptation to its different DOM layout, not an assertion that the reference uses that exact mechanism.

The main file-view title key handler at JS 2629169–2630200 ignores composition and, for Enter, waits for the title save result. Only a successful save leaves the title and requests editor focus. The associated save routine checks the file being renamed and reports failed renames. The Markdown inline title attaches this inherited handler at 3086414–3086930. Its blur handler independently awaits saving near 3088443. Another embedded editor title implementation at 2690611–2692400 similarly awaits its title commit before leaving; it has distinct physical-keyboard/mobile rules.

Metadata's focus-after action at JS 3088210–3088440 requests editor focus with a start position. This supports keeping title/property controls and body focus as explicit, separate operations; it is not evidence to swallow every click within a note pane.

## Local cause and fix

Before this change, `.editor-host` had a minimum height, but its CodeMirror content could still be only one line high. The remaining visible space was the host or `.note-scroll` background and had no route into the editor. `installEmptyNoteFocus` adds a mouse-click route for those two bare wrapper backgrounds, below the measured content bottom. It focuses the owning CodeMirror view at document end. No layout/CSS change is needed, and the helper does not intercept CodeMirror text, rendered links, embeds, title/property inputs, other descendants or horizontal margins beside existing lines.

The helper waits for mouseup, leaves mousedown default behavior intact, and rejects movement/dragging, modifiers, secondary buttons, cancelled events, newer document/selection state, scrollbar gutters, disconnected/destroyed views and read-only/noneditable editors. It removes temporary listeners on completion/cancel/disposal. Properties-only source selects the body boundary at EOF; the existing `liveProperties` input filter adds the needed newline only when typing, preserving frontmatter. Pointer/touch-specific mobile behavior remains unverified.

The old title Enter handler blurred immediately, starting an asynchronous rename, then focused the editor that the rename subsequently destroyed. `bindNoteTitleFocus` instead serializes title save requests and transfers focus after the save and rebuild finish. Repeated Enter and the induced blur share the pending save. The title becomes read-only immediately while saving, so the replaceable input cannot accept a newer filename draft; failure restores its editability. Composition does not submit. Failure retains the title draft; a changed focus target or changed vault/pane/tab/path cancels the focus transfer. A reused tab object is checked by path as well as identity. `renamePath` now returns its resulting path; persistence behavior is otherwise unchanged.

New-note opening and final focus are guarded against vault/pane/path replacement and newer per-pane navigation requests. Navigation intent is recorded before asynchronous flushing, and a delayed creation cannot overwrite a more recent open request. A changed pane render also cancels the delayed opening. A visible inline title receives focus and filename selection; when the inline title is hidden, the actual body editor receives focus. New-note creation currently has no filename dialog. The command palette closes and restores its modal focus before starting the asynchronous create command, and a regression covers that route without modifying modal behavior.

## Integration and verification

The editor owner must call `installEmptyNoteFocus(view, parent)` after constructing the view and call the returned disposer before destroying that view. This is intentionally separate from workspace/title wiring and requires no new public EditorHandle API.

Tests use real CodeMirror DOM/state and real workspace rename/render/storage lifecycles with jsdom. Rectangles are synthetic, so they establish event ownership, selection, source preservation and focus identity rather than native geometry. Coverage includes empty notes, properties-only EOF, trailing blank space, read-only state, controls, drag/modifier rejection, stale/destroyed owners, asynchronous/repeated title Enter, composition/errors, navigation during rename, command-palette creation and hidden-title creation. Native screenshot/caret placement verification belongs to the root integration task.
