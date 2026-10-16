# Inline file-tree creation and rename

Static inspection on 2026-10-16 reused the recovered Obsidian 1.14.4 renderer under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`. The reverse-engineer-anything skill guided evidence reuse. No reference runtime was opened and no recovered implementation or assets were copied into Zorid.

Artifact identity: `app.js` SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, retained REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. E3's expanded graph was incomplete; the observations below are focused ordinary static readings, not new REA semantic results. Offsets are zero-based Python decoded-text character positions. See [reference evidence](reference-evidence.md) and [file operations](file-operations-reference.md).

| Inspected range | Static observation |
| --- | --- |
| `app.js` 1789190–1789587, 1427682–1428371 | The file manager allocates a default localized folder name, using the vault's case-insensitive available-path allocator with numeric suffixes beginning at 1, and creates the folder before returning it. |
| `app.js` 1517188–1517315 | The toolbar's new-folder action supplies the root parent. Context-menu creation supplies the selected folder elsewhere in the explorer. |
| `app.js` 1519910–1521020 | After folder creation, a next-frame callback sorts the explorer, starts rename, and scrolls the folder into view. A placeholder row is not the folder's persistence model. |
| `app.js` 1526510–1527040 | Starting rename first saves/exits an earlier rename, expands ancestor folders, focuses the tree item and starts its title editor. |
| `app.js` 1502390–1502880 | The existing title becomes contenteditable, receives the spellcheck setting and selects its text. The enclosing row receives an editing class. |
| `app.js` 1526220–1526510 | Input is flattened to text when needed. Validation on input is advisory and displays an error tooltip. |
| `app.js` 1475608–1476490 | Validation rejects invalid platform characters, empty committed names, leading dots and duplicate names. The additional unsafe-character warning does not itself prevent saving. Persistence errors are returned for display. |
| `app.js` 1525870–1526220, 1527040–1528170 | Enter saves and exits only on success, ignoring IME composition. Escape exits without saving the draft. Blur saves then exits even if saving reports an error. Exit restores the authoritative title. |
| `app.css` 327780–328340 | The editing row uses a two-pixel focus ring; its title grows to available width, wraps and uses a text cursor. Focus within switches the ring to the accent color. |

Escape therefore leaves an already-created folder with its default name. This follows the inspected creation-before-rename sequence; it is not an observed runtime experiment.

## Original implementation contract

`createFolderInline` accepts a stable `owner` object (the captured vault), a fresh `paths` iterator, captured-vault `createFolder`, `isCurrent`, and `revealAndEdit`. Allocation and creation are serialized per owner so rapid clicks cannot independently select the same available path. Accepted requests stay bound to their original vault; stale completion suppresses presentation. The helper never deletes a successfully created folder when focus or vault ownership changes. External-process creation races remain the responsibility of authoritative no-overwrite persistence.

The host must expand ancestors, render using the normal sort policy, select/focus the new row and start `FileTreeRenameSession`. During reconstruction it reattaches the session to the matching row/label. Pass `focus:false` unless restoring the currently focused editor. The host must end sessions on vault changes/destruction, guard `save` with vault/path identity, enforce case-insensitive duplicate and platform-specific filename validation, and rebuild from authoritative entries after successful rename. A save callback may return the canonical **display name**, never the full path. The host supplies immediate collision warnings through `validate` and persistence failures through `save`.

The session preserves its draft across reattachment, isolates row navigation while editing, coalesces repeated Enter/blur, retains an erroneous Enter draft, restores the old name on failed blur, and suppresses stale error/finish callbacks. Its built-in character check covers the macOS slash/backslash/colon and leading-dot rules; additional Windows restrictions belong in the host's platform validation. Starting another rename should first await the old session's blur commit, then dispose it if still active. Escape cannot reverse a filesystem write already started by Enter; the host must reconcile its subsequent authoritative rename event.

## Verification and open gaps

Focused original jsdom tests cover unique case/NFC name allocation, numeric gaps, simultaneous creation, stale creation reveal, creation failure, selection, Escape preservation, composition, repeated Enter plus blur, rejected/corrected names, live ownership changes tree reconstruction and rich-paste flattening with caret retention. All 11 focused tests passed, as did a strict TypeScript check scoped to this helper. Independent file-tree review reproduced and verified the simultaneous-creation fix against the original Vault/MemoryAdapter. These establish helper behavior only. Workspace integration, actual sorting/ancestor expansion, native contenteditable focus/paste/selection, tooltip placement, mobile keyboards and visual parity remain unverified. No complete suite or build was run for this helper-only change.

## Host integration verification

Workspace now creates the default folder first, reveals ancestors, and binds the
inline rename session. Starting another rename/creation blur-commits the existing
draft. Rebuilding the tree preserves the draft and only restores its focus when it
owned focus before the rebuild. Explorer Rename and F2 use this same session.
Enter/Escape focus the rebuilt tree row only when the retiring edit owned focus;
this preserves keyboard continuation in the original host. Packaged exitRename
retains logical tree focus but does not explicitly restore DOM focus, so the exact
native focus comparison is still pending. Blur never steals focus from its target.

Captured vault and path-lifetime checks run again after dirty buffers flush and
inside the serialized rename operation; stale inline rename cannot target a new
vault or an observed replacement. Case/NFC destination collisions are checked
against the fresh queued snapshot. Native drag/selection/inline-edit geometry has
not been verified by these jsdom integration checks.

Default-folder allocation is also checked inside the vault mutation queue, after
refresh. A newly discovered case/NFC alias rejects safely rather than creating a
duplicate or selecting an unrelated existing folder. A subsequent user retry
allocates the next available name. Parent-folder lifetime is checked while the
captured vault remains active; a queued observed parent replacement cannot receive
this creation. An already accepted creation can still finish in its original vault
following a vault switch, but cannot take focus in the replacement workspace.
Changing note navigation, active pane, or explorer tab while allocation is pending
also suppresses its late rename presentation.
