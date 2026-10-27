# Local desktop Bases closeout — 2026-10-26

The local desktop implementation is accepted within the scope below. Root owns
`codex/types-bases-model` / `.worktrees/types-bases-model` and sole main integration.
Main's integration parent is `e7d655e1`; integration uses a fast-forward so reviewed
commits and the tested source remain intact. No push or subsequent milestone is
authorized by this closeout.

Notes/frontmatter remain authoritative; `.base` files select ordinary files and
store saved views. There are no named Types. `Properties.yaml` stores property
definitions, including options and relation settings, rather than note values.
New copies the entire literal template. Table/Cards/List/Kanban, rich property
editing, relations/reverse relations/rollups, summaries, embeds and lifecycle
guards are implemented. Obsidian is the inspected starting reference; complete
pixel or language parity is not claimed.

## Final confirmed fixes

| Change | Implementation / review | Verification |
| --- | --- | --- |
| Computed reverse/rollup values no longer falsely require editable raw source | `0393e387`, focused source review approved | Three existing renderer checks; real whole-vault reverse/rollup counts and values |
| Retained dot paths, including trash, leave the live note/relation namespace; old caches rebuild at the same watermark | `899a9e0b` → `b9037d59`, independent source review approved | Two focused Rust tests; actual renamed/deleted target becomes unresolved without rewriting referring notes; raw trash stays readable |
| Successful New-item Retry preserves popup keyboard ownership without taking focus back from another control | `551b7587` → `be163101`, independent source review approved | Existing21popup tests pass; actual collision/corrected-title retry/Escape and exact saved body pass |

Existing scoped review of the composed feature and earlier fixes is retained in
the execution checkpoint. Later changes through `4c71a4a6` affect only the driver:
wait for the requested file and inline initial result, type only the visible body,
reuse the existing native drag recipe, and cover the existing30-second external
scan with a45-second wait. They add no product behavior or test matrix.

## Actual desktop workflow

The sustained original workflow was completed in retained stages, **not one
uninterrupted all-green run**. On the user's no-unnecessary-tests instruction,
already passed portions were not restarted. Continuations use exact saved
disposable fixtures, fresh core storage, and the original remaining assertions.
Their private source/fixtures and provenance are retained.

| Receipt | Observed scope and limits |
| --- | --- |
| `zorid-bases-heavy-20261026-005` |55checks/366actions before the demonstrated Retry focus defect. Base creation/view management, filters/search/grouping/summaries, all-result CSV, rich properties, real native color menus, range paste/clear/undo, reverse relations/rollups, target rename/trash, literal template/body editing and normal note reopen pass. Whole run fails at Retry/Escape. |
| `zorid-bases-heavy-continuation-20261026-001` |12checks/127actions; fixed Retry/close, safe New collisions/defaults, exact template preservation, decoded Cards pixels and List settings pass. Whole run fails at its old drag recipe. |
| `zorid-bases-heavy-continuation-20261026-003` |5checks/33 recorded driver actions; Kanban pointer/keyboard changes, shared split edit and active-note sidebar context pass. Real CUA drag attempts did not deliver an accepted drop; after cancelling that drag, the existing Chromium `beginDrag` driver delivers the captured `[[Book 001]]` payload to Reading. Passive events and exact saved status prove that move. Do not label it a successful CUA drag. Whole run stops at an inline menu clicked before query readiness. |
| `zorid-bases-heavy-continuation-20261026-004` |2checks/24actions; actual file/fenced embeds, exact inline view-name source mutation and rejection of a stale edit pass. Whole run times out waiting15seconds for external discovery, before the30-second scan; physical data is preserved. Read-only DB/source investigations establish no frontend stale-lease defect. |
| `zorid-bases-heavy-continuation-20261026-005` |**PASS**,8checks/18actions: periodic external discovery shows rating3, stale input cannot overwrite external bytes, exact note/Base/template-body bytes survive a real restart, and both normal quits exit0 without leaked native processes. |

All source/artifact freezes verify. Earlier unsuccessful attempts, including the
private continuation002 checkpoint-path mistake, remain failures rather than
being relabeled. Counts above overlap and must not be summed as unique coverage.
Owned test apps are closed.

## Matching artifacts and retained evidence

- Rust tree: `5c76a11d04e659046100067e33707cf72f204ea4`.
- Native host SHA256: `a566246c559080694a5db0add6a50126fac60c24e68dd7f7680bff5e6bec3707`.
- CLI SHA256: `f98bd1de9b9393450b5db63520e138c086520c90aabcc8fcbf46892e426edc5c`.
- Native/CLI release build62263 exits0. Desktop016 build74901 exits0, including
  TypeScript,333files; frontend product source is `be163101`.
- Matching WASM build80799 exits0; fingerprint
  `f0d5b64970fcc8070a47be3e0abda2cd0b0095283074441dc629b654d2c650c8`.
  This is a build result, not a new browser runtime acceptance claim.

Final reports, screenshots, private continuation sources/fixtures, provenance and
build receipts are preserved under the main workspace's ignored
`tmp/bases-desktop-closeout-20261026-final/`, indexed by `manifest.json`.
Original run reports remain under `/private/tmp/zorid-bases-*`. After the user
requested local installation and cleanup, duplicate binaries and disposable test
profiles/vaults were removed. The verified native binary remains inside the
installed `~/Applications/Zorid.app`. Earlier immutable evidence parts001–010 and
original helper archives moved to `tmp/worktree-cleanup-backup-20261026/bases-validation-and-harnesses/`.
Earlier S1 evidence moved to that backup's `s1-evidence/` directory. The feature
worktrees are retired; all branch references remain. Recovered vendor implementation
is not included in project source.

## Retained limits

Earlier CLI125commands/17checks, browser/WASM162typed values/16diagnostics,
property native65checks, real clipboard24checks and Recovery002's three failure/
retry protocols remain bounded evidence at their recorded source versions. They
were not all rerun after every change. Latest matching WASM compiles, but the
schema2 namespace change has no new browser runtime campaign.

The65-case filter campaign, broader safety/config/layout/sidebar matrices,
supplemental production-web Worker identity and full23-state visual-reference
capture remain incomplete. Current Obsidian typed reference passes13phases;
visual reference captured14/23. No complete native/reference parity, physical IME,
mobile/other-OS acceptance or performance budget follows. These retained coverage
limits do not reopen blanket testing after the user's explicit scope reduction.
Tasks, calendars, sync and mobile remain later work.


## Local app installation and requested cleanup

Built the native renderer from main `6f7237ed`, reused the independently hashed
native host with an identical Rust tree, and packaged an unsigned arm64 app using
the normal package preflight. The copied bundle passes355-file verification before
atomic installation at `/Users/ctk/Applications/Zorid.app`. It is a local,
unnotarized build. No additional UI campaign was run.

User subsequently requested all worktrees and unnecessary build/cache data be
cleaned.105 extra worktrees were removed, leaving only main. Four uncommitted test
files from three worktrees were preserved byte-for-byte with patches and original
HEADs under `tmp/worktree-cleanup-backup-20261026/`; feature branches remain. Prior
source backups, research, evidence and helper archives were relocated there before
removal. Project target/staging/release/dist caches, old duplicate native binaries,
disposable playgrounds and owned test profiles/vaults were removed. Source,
dependencies, toolchains, normal user vaults and application data were retained.

The cleanup backup includes `inventory.json`, `preserved-changes.json`,
`removed-worktrees.json`, `removed-cache-and-data.json`, `installed-app.json`,
package inputs and build/verification logs. Free space increased from about2GiB
to9.1GiB during this pass. Historical provenance paths refer to their original
locations; the backup inventory records their relocation.
