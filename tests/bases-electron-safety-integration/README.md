# Supplemental actual Electron Bases safety campaign

Status: **authored, not executed**. This is an independent supplement to the
heavy-user and matched visual campaigns. It uses the normal Electron app/native
host and visible production controls. The common runner's optional campaign seam
(`5c8c8a86`) must be composed before execution. Sidebar rename phases also require
the composed sidebar fixes `bc22d072` and `8f7377ec` (isolated
`8f6c043b` → `062aa020`). No product API applies positive
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
written. The campaign uses the same guarded runner lifecycle as the main journey, with
normal quit/relaunch freshness boundaries before partial bulk and after the
settings stale-draft assertion, plus final restart/readback and normal quit.

## Exact acceptance steps and independent durable oracles

| Name | Actual actions | Required result |
| --- | --- | --- |
| `shared-dirty-body-and-property-commit` | Split Base, open A in ordinary editor, use Cmd+ArrowDown with passive native caret proof at the final empty line, press actual Enter and type a single-line marker, then edit score from the other pane. | Passive terminal-line/caret receipts must show the independently intended blank line and marker before any Base mutation. Disk still contains original bytes immediately before the Base property commit, proving actual overlap; then the independently constructed whole body (original + LF + marker), unrelated fields and score9 save together. If native autosave wins the precondition, fail rather than call it dirty-buffer coverage. |
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
| `sidebar-clean-base-file-rename-*` / folder rename | Mount context Base, select Outline and hide right sidebar. Rename Base and its parent folder through explorer context menu and real contenteditable rename input. | Exact Base bytes preserved, old paths absent, selected Outline and hidden state survive both renames. Expand → Bases opens moved target with main Context One; switching main Context Two updates exact saved row. |
| `sidebar-dirty-rename-refusal` / retained move | Hold unapplied shared property-settings input in sidebar, attempt normal explorer rename; cancel rejected tree rename. Then explicitly labeled external filesystem rename. | Normal rename refuses with inline invalid state, original path remains, draft input retained. External move still retains input and exact registry. Cancel settings → normal Bases reopens remembered moved target with correct main context. |
| `sidebar-explicit-newer-selection` | Open a different Base normally and use the ordinary sidebar command, then switch main note. | New sidebar title/static row stays current; old context-bound sidebar never revives. This sequential case does not establish an in-flight teardown race. |
| `safety-restart-exact-*` | Signal-free quit/restart; reopen named host and read saved note/config/registry/group files. | Named view binds correctly, all captured durable bytes and recovery copy survive exactly. |

The three C2 additions append eight explicitly labeled inert fixture files to
`fixtureFiles()` without replacing the original inputs. These inputs are not
product-creation evidence. All rename/property mutations use the already-mounted
production controls. The DOM observer assigns weak node identities only; it
never mutates product state, DOM attributes, selection or source.

| C2 phase | Required result |
| --- | --- |
| `mounted-file-embed-rename-retains-sibling-draft-and-cell-selection` | Open two spelling variants of one named file embed; select the origin's score cell and retain an invalid number draft plus a nonempty input selection in its sibling. Rename through the origin's visible Views → Configure view input. Exact independent Base/host bytes change only the matching name/fragments; Other/aliases/comments survive. Both original session DOM nodes remain in their own embeds, origin logical cell selection and sibling input node/value/selection remain exact, and A's source stays unchanged. Cancel the invalid draft normally, close/reopen the host and resolve the new binding. |
| `nested-mounted-embed-rename-dirty-child-retry` | Create a real retained child-note conflict, then open the outer Markdown embed and rename from its nested Base. Base/clean reference save while dirty child external bytes and outer bytes stay exact. Before retry the old-fragment wrapper retains its original session and logical selection with the saved new binding; the old rendered table remains deferred while the failed toolbar command is retained. Save the exact original draft through global recovery UI, Retry save, and require only the child fragments to change. The same nested session/selection continues in the new-fragment wrapper, the late recovery copy remains untouched, and close/reopen resolves the new binding. |
| `fenced-mounted-rename-continued-binding-and-property-save` | Populate a score-cell selection, then rename the inline view through its mounted Views controls. Only the exact containing note's name field changes; unrelated ordinary wiki/Markdown note fragments stay byte-identical. Before navigation, edit A's score through that still-mounted logical inline view and require the independently constructed full saved source. No extra backing file appears. Close/reopen resolves the renamed fence. A clean fence may remount when its source span changes; its populated logical row/property selection must survive without requiring DOM identity. No preexisting dirty cell editor is created in this fence case. |
| C2 normal restart | After signal-free quit/restart, reopen mounted file, nested outer and fenced host, resolve every saved exact named binding, and require all eight durable fixture sources plus the exact nested recovery draft copy. |

The source-authoring checks are `node --check` for runner/campaign/contracts plus
`node --test tests/bases-electron-safety-integration/mounted-rename-contract.test.mjs`
and offline fixture YAML parsing. The narrow contract tests reject recreated
sessions, disconnected/reparented roots, wrong binding, lost input node/text/
selection and changed logical cell selection, including after a clean fence remount; they do not execute the product. Those checks establish syntax/fixture structure only.
Unavailable controls, failed preconditions and assertion mismatches fail the
campaign; there are no silent skips or conditional acceptance branches.

Source inspection at the authored baseline indicates a possible production gap:
Live Edit creates a new inline occurrence when fenced configuration text changes,
and its embed cache keys the full original source; a new table defaults to its
first property. The strict populated score-selection assertion is retained and
may expose that loss. It is not waived or marked passed by these offline checks.
C2 runtime acceptance is pending the scoped inline selection-restoration fix,
matching artifacts and an explicit native runtime grant.

## Boundaries still open

- The scoped post-prepare checkpoint-access failure below is the only I/O fault
  planned here. Arbitrary disk failure, power loss, lost reply and uncertain
  creation recovery remain separate gates. Actual phase results establish execution.
- No actual failed-live-save queued-newer-draft retry; stale configuration CAS is
  distinct. Do not infer retry correctness from that scenario.
- No claim that the ordinary note's caret position is unchanged; body undo/source
  preservation are asserted. A dedicated mapped-selection oracle remains needed.
- No pending durable I/O close/remount proof; unapplied draft close protection is
  tested explicitly.
- No artificially delayed sidebar controller or service is installed. An observable
  actual in-flight newest-selection race remains open; sequential selection is
  not a substitute.
- No native OS clipboard, IME, accessibility/screen-reader, light/scaling or matched
  Obsidian screenshot acceptance. Those remain independent required scenarios.
- No mobile, sync, crash/power-loss, large-vault/performance or main integration
  acceptance follows from this campaign.

## Safety001 execution correction

Actual frozen `a11e0491` safety001 stopped at its first body oracle (15 actions,
zero completed durable checks); all later phases remained unexecuted. Its
multiline CDP `Input.insertText` recipe expected a blank line that was absent
from saved source, but did not capture the native caret or pre-Base terminal DOM,
so that receipt cannot attribute the difference to insertion or property saving.
The source setup now uses real Cmd+ArrowDown and Enter plus single-line insertion,
records passive collapsed-caret/terminal-line receipts before the Base command,
and keeps an independently constructed exact whole-body oracle. This is an input
recipe correction, not normalization to observed saved bytes or a product pass.
No later execution is implied.


## C2 Hover and New inline publication supplement

Status: **authored; checkpoint-fault repair not yet executed** (2026-10-26).
The original scope from `2fe6e055` remains. These two bounded phases
preserve the prior eleven phases and append five named inert inputs (51 total
prelaunch files), plus one note created through normal New during execution.
Neither the launchers nor the literal template are product-creation evidence.
Matching publication-hold/private-continuation fixes, Hover toolbar portal
ownership, frozen artifacts and an explicit native grant are still required;
source checks below do not establish that those controls work in the app.

| Phase | Normal actions and strict result |
| --- | --- |
| `hover-inline-config-not-published-before-durable-original-retry` | Open the fixture Base, modifier-hover its real file-name link, enter the normal File preview, and click its body paragraph to open the shared live editor. Populate A.md/note.score selection and rename the nested fence through Views. The approved relay holds only the real inert preparation reply for the exact whole containing-note source. Deny access to the exact owned `.zorid/vault.lock` inode, release the unchanged reply, and require a correlated native `checkpoint_storage` / `commit_uncertain:true` response before any commit. Require a safe visible failure message, exact old physical source, actionable original Retry save with the requested name retained, unchanged original host/binding/session DOM and old rendered view, exact score selection, and the property grid's advertised `aria-disabled=true` admission state. Restore the exact original inode/mode in `finally`; then require unchanged physical AND logical source/revision before clicking the original Retry save once. Require the identical failed checkpoint CAS to succeed before that original prepared token commits, and require the independent exact new whole-note source, same host ownership and logical selection, with no new files or A mutation. Normal navigation/reopen and restart resolve the new view. |
| `new-popup-inline-config-not-published-before-durable-original-retry` | Use ordinary Base New with the literal full template; require exactly one created note and byte-exact initial copy. Click Edit note body, select its nested score cell and perform the same real post-prepare checkpoint-failure/original-retry protocol in the New popup. The source may publish only after acknowledgement; the exact original host retains its owned inline node and logical selection. Close normally and reopen the created note; the template remains byte-identical, no duplicate note appears and restart resolves the saved view. |

Weak DOM identities observe both the original surface and its nested binding;
they do not mutate the UI or invoke application APIs. Failed publication must
retain the actual binding/session nodes; after acknowledgement a clean inline
remount is permitted only with the same host ownership and logical selection.
The failed publication/source checks repeat after a short bounded interval.
The relay forwards the original native reply bytes and existing public protocol;
it never manufactures an error or changes a command. The failure is a genuine
owned-lock access denial after inert preparation, not public-file projection
failure or arbitrary device failure. Public parent-directory0555 was removed:
that can allow a valid logical commit with pending projection and cannot prove
this precommit-failure condition. No product guard was added for this fixture.
Lock cleanup keeps an original descriptor, rejects aliases/hardlinks and refuses
to chmod a replacement path. Normal bridge reads resume only after restoration.
The evidence records one rename UI submission and one original retry click.
That is an accepted-intent observation, not a count of native filesystem writes.
The retained error panel can legitimately obscure the property grid. This phase
asserts its advertised `aria-disabled` state and exact unchanged A bytes; it does
not claim a functional negative click/key probe through that panel or bypass
normal pointer hit testing to manufacture one.

Only exact Recovery and Safety campaign paths can select the shared relay. Its
provenance is exactly the generated owned wrapper plus the existing canonical
Recovery control/protocol/relay files; all existing PID, private-directory, source
hash and Node-executable guards remain. No other campaign gains relay admission.

Offline lock/protocol tests reject unowned/symlink/hardlink/replaced lock paths,
restore the exact inode on callback failure, and reject a mismatched prepared
source, missing/incorrect uncertain checkpoint failure, an early logical commit,
a different checkpoint retry, replacement intent, duplicate commit or relay fault.
They never launch a host or app. Existing publication contract tests reject early
publication, changed root/session on failure,
wrong containing-note binding, detached/transferred hosts, lost selection and an
unblocked advertised property-grid state. All previous contract checks and authored source oracles
remain. The normal default Reading Hover has a separate rendering path; these
new phases deliberately cover the active Hover body editor and New body editor.
Native execution remains pending, including the clean toolbar portal ownership
path before typing, rather than assuming a rapid input recipe will bypass it.

## Fresh scenario baselines after deliberately stale external fixtures

The score-7 source authored by the conditional-history phase is retained exactly,
including its unrelated property/body sentinels. That phase still must reject
the touched-property undo and preserve the complete physical source. Only after
all same-session body/history assertions and the temporary split close, the
partial-bulk phase performs a normal quit/relaunch. Before creating B's independent
CLI conflict, it requires unchanged physical A bytes, a bounded read-only normal
bridge observation equal to the authored full source, and a visible score-7 cell
with matching current controller/rendered/widget versions and settled state.
Neither physical readback alone nor a stale visible score is sufficient. All
original B conflict, successful-A/failed-B, partial undo, recovery-copy, repeated
bulk and undo oracles remain unchanged. No B recovery draft exists at this restart.

The settings phase retains its first stale Apply, visible conflict, exact external
registry bytes and exact local input. After Cancel it performs a separate normal
quit/relaunch, waits for the normal logical registry read to equal the authored
external source, then opens the ordinary Base/settings UI and requires the exact
external label before the existing accepted edit/sentinel oracle. This establishes
a fresh scenario baseline; it does **not** verify same-session registry/buffer
reload. That production behavior has separate source tests and runtime scope.

`freshness.mjs` polls only the existing read-only bridge, for at most a 45-second
readiness window (each bridge operation also retains the common CDP deadline).
Every observation checks physical equality before/after, records source hashes and
match outcomes, and fails immediately on physical divergence or vault-owner
mismatch. It never invokes a scanner, mutates/adopts a logical source, reloads a
private buffer, or retries an Apply. A timeout fails the scenario.

Run the bounded protocol/DOM tests with:

```sh
node --test --test-concurrency=1 tests/bases-electron-safety-integration/freshness.test.mjs
```

These source/protocol checks are not actual Electron acceptance. They do not
erase safety012's retained ordinary-property save/reconciliation failure, prove
its cause, or establish the separately implemented physical save guard.
