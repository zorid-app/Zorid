# Bases main reconciliation preparation — 2026-10-22

**The observed main checkout is clean and is the exact ancestor of the pinned
Bases candidate. A fast-forward is mechanically available; full product
acceptance is incomplete.** This is a read-only reconciliation report. No merge,
cherry-pick, main edit, test suite, build or app runtime was performed for it.
Root remains the sole main integration owner.

Owner: `bases_expressions`; isolated branch `codex/bases-main-reconciliation`,
worktree `.worktrees/bases-main-reconciliation`. The execution checkpoint was
read before analysis. This report pins source rather than following the moving
integration branch or treating an isolated passing test as main acceptance.

## Exact source boundary

| Witness | Observed value |
| --- | --- |
| Primary main checkout | `/Users/ctk/Projects/Zorid` |
| Main HEAD | `e7d655e1d807769840b9d87c9d63dc7a9b70c29d` |
| Pinned Bases candidate | `5686f6b32c06c503a41a7978dedfb42466a7368b` |
| Candidate checkout | `.worktrees/types-bases-model`, `codex/types-bases-model` |
| Merge base | Exact main HEAD above |
| `main...candidate` commits | 0 main-only, 425 candidate-only |
| Merge commits in that interval | 0 |
| Changed files | 383: 255 added, 128 modified, none deleted/renamed |
| Net diff | 55,699 insertions, 2,897 deletions |

`git status --short` and porcelain-v2 output for main were empty, including normal
untracked-file reporting. The candidate had only the known untracked
`node_modules` path; it is not part of the candidate tree or this integration
manifest. No main-side commit or dirty source conflict was found. This does not
prove that the shared changes have no behavioral regression, or grant permission
to include later unreviewed worker files.

The companion [per-file manifest](bases-main-reconciliation-source-20261022.json)
records every changed path and its exact base/candidate Git blob IDs, plus the
comparison boundaries. It is generated from Git metadata, not an evaluation
oracle. Any later candidate or main change requires a new boundary comparison;
these 425 commits and counts do not silently extend to it.

## Batch scope and seams that travel together

The interval begins with `5d00b064`, the authorized Bases implementation goal and
retirement of superseded designs, followed by the composed Rust/UI/host/test
work. All 425 commits are already on the coordinator's single linear branch;
there is no second main-side history to merge. Commit subjects and file scope
fit that coordinated pass. This is not a fresh independent review of every
commit or proof that every feature is accepted.

| Area | Files | Integration significance |
| --- | ---: | --- |
| Rust crates | 65 | 53 Bases files plus document fence extraction, index root resolver, native/desktop/WASM transport/query hooks and their tests. |
| `src` | 71 | 39 Bases files and 32 shared editor/workspace/platform/property/resource/creation files. |
| `desktop` | 5 | Admission/capability propagation, document request validation, editor-core method routing, original text-create receipt replay. |
| Tests | 184 | Authored unit, client and native campaign fixtures, oracles, process/clipboard/recovery/visual harnesses; presence is not successful execution. |
| Docs | 57 | Current goal/reference/status evidence and explicit historical routing for retired Types-first designs. |
| Repository root | 1 | `Cargo.lock` only. |

Shared seams require their complete reviewed chain; extracting just
`src/bases` or just the Rust crate is not a coherent integration:

- Query/proof transport: native, desktop JSON admission, TS DTOs, browser runtime
  and Worker forwarding carry saved/fenced source witnesses, optional property
  settings, summary previews, seeded evaluation, target suggestions and current
  relation values. Capability admission must pair with the matching host/WASM;
  an old installed host is not made compatible by moving a Git branch.
- Creation: Base/New/template creation uses captured operation/entry identities,
  exact original Rust commit receipts and bounded durable replay through Vault,
  browser file commands, desktop text-create/admission and platform bindings.
  Preserve CAS/idempotency/uncertain-result protections and original source.
- Shared editor lifecycle: `workspace.ts`, `editor.ts`, Markdown/callout/list
  renderers, live Bases, embed sessions, file Hover and New popovers coordinate
  retained buffers, source-mode recovery, own-save publication and binding leases.
  These overlap ordinary note behavior and require actual lifecycle evidence.
- Properties/resources/rename: ordinary note properties share the value settings
  and captured relation targets; source-preserving wiki rename now recognizes
  bounded frontmatter scalar spans. File/attachment opens retain row witnesses
  and subpaths. UI styles/icons/context-menu additions are shared surfaces.

Root build policy files are unchanged: `Cargo.toml`, `package.json`,
`pnpm-lock.yaml`, `vite.config.mjs` and the entire `scripts` tree have identical
Git objects at main and this candidate. No packaging/iOS/Android source changes
are in this diff. `crates/zorid-bases/Cargo.toml` adds pinned `url`,
`unicode-normalization`, `icu_collator` and `icu_locale_core` dependencies;
`Cargo.lock` includes the corresponding ICU feature/data closure. Rust dependency,
WASM size/portability and license/provenance checks therefore remain relevant.
The candidate includes Moment/ICU license notices and `UPSTREAM.md` provenance.

`src/tasks`, `src/calendar`, WorkBlock code, and the retained Rust
`types.rs`/`tasks.rs`/`calendar.rs` implementations have no changed paths here.
Generic Bases drop named-Type requirements while those deferred consumers and
user files remain intact. Their shared transport/Workspace neighbors changed;
unchanged leaf files do not establish task/calendar runtime regression freedom.
The [retirement inventory](bases-type-retirement-inventory-20261022.md) describes
that deliberate boundary, not authorization for data migration or deletion.

## Concurrent work excluded from this snapshot

Read-only worktree status found these dirty files outside main and the pinned
candidate. They must not be swept into integration or treated as accepted:

| Worktree / observed HEAD | Unconfirmed local delta | Disposition |
| --- | --- | --- |
| `bases-rich-cell-focus` / `0d660bb1` | Modified `src/bases/table-view.ts`; new `tests/bases-table-widget-focus.test.ts` | Controller-owned confirmed sibling cell-focus bug fix in progress; source review and applicable rerun required before a successor candidate includes it. |
| `bases-e2e-actionability` / `7cde1237` | Modified native run/UI/select README; new optional native-select checkpoint helper/tests | E2E-owned native input diagnostic route, not a product fix or accepted default-run replacement. |
| `bases-session` / `70e37b27` | Untracked `src/bases/toolbar-formula-editor.ts` | Older local file; ownership/current relevance is unconfirmed. Do not copy, remove, commit or infer it belongs to the final batch. |

The checkpoint also records the ordinary-note Properties readback investigation
with `bases_embeds`; it is not a confirmed cause/fix in this snapshot. The
native SELECT input-route failure remains an investigation, not grounds to
weaken purple-value/save oracles. Status observations can become stale as their
owners finish; reconciliation must use their explicit reviewed commits later.

## Verification reuse and remaining gates

The tested Rust closure is
`8074eabf01c55cf4e53f01c02a5a384197875a24`. Its 361 tests/20 nonempty targets,
matching native/CLI and WASM builds, [CLI007](bases-cli-actual-007-20261022.md)
125 commands/146 typed expectations and [browser010](bases-browser-actual-010-20261022.md)
19 groups/146 typed expectations remain scoped evidence. Normal supported-web
[003](bases-web-ui-actual-003-20261022.md) passed five actual note UI phases on
`fe75db9f`, before the later Hover source. None claims full current native UI,
visual parity, mobile, sync, stress or primary-main acceptance.

The latest frontend build003 is recorded against the reviewed Hover composition
`0d660bb1`; later commits through this pinned candidate are evidence/docs only.
The checkpoint records 141+3 scoped Node checks for that composition and the
previous 89 C2/33 configuration checks. These do not erase actual failures:

- Current native SELECT probe003 still fails strict purple readback.
- Hidden safety002 fails before durable checks; visible safety003 reaches four
  durable checks then exposes the confirmed sibling cell-focus defect.
- Visible properties001 reaches ten durable checks, then opens Properties.yaml
  rather than the expected Alpha note; cause remains under investigation.
- Complete fresh heavy journey, safety, properties/C1, configuration, 14-phase
  layouts/C2/C3, actual clipboard/IME/recovery and matched visual states remain
  required by the maintained implementation goal. Native cleanup failures and
  partial runs retain their exact historical limits.

Before final integration, the coordinator should resolve/record these actual
findings, compose only independently reviewed coherent successors, and freeze
an exact final source/artifact closure. Use affected focused Node tests plus
TypeScript/build checks for source changes; existing repo commands are
`pnpm check`, `pnpm build:desktop` and `node --test --test-concurrency=1` with the
applicable test paths. This report ran none of them. Serialize heavy/native
work and use the normal apps/guards rather than replacing failed interactions.

Do not repeat the full Rust suite merely because the branch name moves. If the
final Rust/Cargo objects equal the verified closure, preserve and rebind its
existing receipt; changed Rust or shared transport semantics require the affected
checks and matching products again. Likewise, verify exact frontend/oracle
sources and host/WASM pairing before reusing client evidence. A Git fast-forward
alone verifies neither a packaged installation nor currently running production
app behavior.

## Sole-owner integration sequence

1. Recheck main's exact HEAD and clean status under the acknowledged sole-owner
   lock, re-read the latest checkpoint, and pin the final reviewed candidate.
   Stop for reconciliation if main gained commits or unowned edits.
2. Compare that final candidate with this manifest; inventory any successors and
   excluded worker work explicitly. Complete its relevant review/validation and
   retain accurate pending-scope labels.
3. If main is still its ancestor and the source closure is accepted for
   integration, the coordinator can fast-forward main to that exact candidate.
   Preserve linear evidence history; no 425-commit replay or conflict resolution
   is necessary for this observed boundary. This report performs no integration.
4. Verify main now has the intended exact tree/source objects and preserved
   source/product receipts; run only checks justified by any actual changed
   closure. Record the main integration separately from native/mobile/visual
   acceptance and update tracking without relabeling failed historical runs.

No primary checkout, other worktree source, user vault, installed app, build output
or process was modified during this preparation. Only this isolated report and
its Git-source manifest were authored.
