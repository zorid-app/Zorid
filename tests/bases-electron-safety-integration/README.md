# Supplemental actual Electron Bases safety campaign

Status: **authored, not executed**. This is an independent supplement to the
heavy-user and matched visual campaigns. It uses the normal Electron app/native
host and visible production controls. The common runner's optional campaign seam
(`5c8c8a86`) must be composed before execution. No product API applies positive
mutations; DOM evaluation only observes controls/state. External writes, a path
rename/recreation and recovery conflicts are explicitly labeled negative fixtures.

The coordinator supplies a matching frozen source/frontend/native set and the
runtime slot. This harness never builds or chooses binaries. Invoke the existing
runner through this small wrapper, retaining all ordinary provenance/owned-app
and normal-quit guards:

```sh
node tests/bases-electron-safety-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-safety-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

The output parent must exist. The output directory must be new and outside source
and artifact roots. Fixtures own `Properties.yaml` and output folders; the default
heavy-user fixture/registry is not injected. Only this owned disposable vault is
written. There is one app launch, normal quit, restart/readback and final normal
quit, using the same guarded runner lifecycle as the main journey.

## Exact acceptance steps and independent durable oracles

| Name | Actual actions | Required result |
| --- | --- | --- |
| `shared-dirty-body-and-property-commit` | Split Base, open A in ordinary editor, append body text, edit score from the other pane. | Disk still contains original bytes immediately before the Base property commit, proving actual overlap; then exact appended body, unrelated fields and score9 save together. If native autosave wins the precondition, fail rather than call it dirty-buffer coverage. |
| `editor-undo-owns-body-only` / redo | Undo/redo in ordinary CodeMirror after the Base edit. | Only appended body reverses; Base score9 survives; redo restores exact previously saved bytes. |
| `base-undo-preserves-unrelated-external-content` | External writer changes an unrelated field/body; Base undo/redo. | Score alone reverses/restores; external body and unrelated value survive exactly. |
| `conditional-undo-touched-property` | External writer changes score; invoke Base undo. | Visible touched-property rejection and exact external bytes unchanged. |
| `partial-clear-first-file-durable` | Type body draft in B, externally change B before autosave, wait for real retained recovery conflict; navigate to fresh saved Base, select A/B score range with keyboard and Delete. | A clears durably; B refuses through its retained NoteBuffer; visible message names partial completion and B. B's external bytes stay exact. This is a real per-file conflict boundary, not simulated I/O failure or multi-file atomicity. |
| `partial-command-undo-restores-only-success` | Base undo after partial clear. | All A property values and exact body restored; B external bytes unchanged. Property reinsertion order is not claimed as byte-exact undo. |
| `partial-bulk-recovery` | Save B recovery copy through native recovery UI; repeat range clear and undo. | One copy holds exact typed draft, original B retains external source; fresh bulk succeeds and undo restores every property value and exact body in both files. Recovery copies are excluded by explicit A/B filename membership. |
| `property-settings-stale-draft` | Retain option-label draft; externally edit the same Properties.yaml definition; Apply. | Visible conflict, exact external registry unchanged and local input retained. Reopen/load fresh definition; accepted UI save preserves unrelated registry sentinel. |
| `summary-stale-newer-draft` | Acknowledge expression A; type B, external writer replaces saved summary before debounce; then type C. | External777 remains authoritative, B/C drafts retained visibly and neither silently adopts an unrelated source baseline. This does not exercise a failed durable-save retry. |
| `path-reuse-retained-draft` | Retain Replace score draft; external rename original to Retired/Original.md and create a replacement at Replace.md; commit original editor. | Visible stale/replacement refusal; original/replacement bytes exact; original input8 remains until Escape. |
| `close-guard-retains-draft` | Retain unapplied property-settings input, close Base tab. | Close refused with feedback; exact local settings input and original Base remain, registry unchanged. Cancel then close/reopen succeeds. This covers an unapplied draft, not a held durable I/O write. |
| `named-reference-partial-retry` | Retain host body conflict; rename Old view through Base configuration. | Base name acknowledged; clean reference updated; dirty host external source untouched; exact retained Retry save appears. |
| `named-reference-retry-preserves-alias-other-view-and-external-body` | Save host recovery copy through global recovery UI, then Retry save in original rename panel. | Copy holds exact typed draft; original changes only matching wiki/Markdown fragment spellings, preserving alias, Other view and external body. The recovery copy created after capture is not rewritten by the older plan. Reopened embed binds Renamed view. |
| `scalar/list/date/link-group-move-*` | Real Chromium pointer drag into a column identified by its captured target card. | Exact scalar destination, whole list replacement, date source string or rooted transfer-safe link with alias; body and unrelated fields unchanged. No display-string-to-property conversion in the harness. |
| `*-column-new-*` | New from scalar/list/date/link columns. | Exactly one ordinary note in configured folder with independent expected scalar/list/date/link data. |
| `move-to-null-removes-group-property` / `null-column-new-preserves-safe-filter-default` | Move existing card to empty group; New in an empty configured group under a safe equality filter. | Existing field removed; New preserves inferred Todo rather than writing/deleting it due to null group. |
| `template-column-new-copies-complete-conflicting-source` | Column New using conflicting full template. | Byte-for-byte template, literals/body preserved, original template unchanged, visible outside-view/unchanged-copy explanation. |
| `folder-group-move-*` / New | Move file between actual folders via board, then New in destination. | Old path absent, new path exact bytes; one new note in target folder and none additionally in fallback Created. |
| `safety-restart-exact-*` | Signal-free quit/restart; reopen named host and read saved note/config/registry/group files. | Named view binds correctly, all captured durable bytes and recovery copy survive exactly. |

The source-authoring check is `node --check` for all three modules plus offline
fixture YAML parsing. Those checks establish syntax/fixture structure only.
Unavailable controls, failed preconditions and assertion mismatches fail the
campaign; there are no silent skips or conditional acceptance branches.

## Boundaries still open

- No injected native I/O interruption, lost reply or uncertain creation receipt.
- No actual failed-live-save queued-newer-draft retry; stale configuration CAS is
  distinct. Do not infer retry correctness from that scenario.
- No claim that the ordinary note's caret position is unchanged; body undo/source
  preservation are asserted. A dedicated mapped-selection oracle remains needed.
- No pending durable I/O close/remount proof; unapplied draft close protection is
  tested explicitly.
- No native OS clipboard, IME, accessibility/screen-reader, light/scaling or matched
  Obsidian screenshot acceptance. Those remain independent required scenarios.
- No mobile, sync, crash/power-loss, large-vault/performance or main integration
  acceptance follows from this campaign.
