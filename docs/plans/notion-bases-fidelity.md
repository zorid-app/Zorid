# Notion Bases fidelity follow-up

The user returned this session to the original Notion-style Bases request.
Branch `codex/notion-bases-fidelity` is isolated from main at de72ad3f. Frozen
runtime source: `ce97447069d3230af66f51e89f3b58f883544d11`.
Main/package/install ownership remains with the recovery/shared-core coordinator;
this branch does not clear protected-session or installation holds.

## Reference and implementation

Fresh live experiments on the disposable Notion interaction page measured settings
290px wide/28px rows, List30px rows, slash324px/32px rows, neutral Board titles,
cell Enter/Escape/arrow behavior, header keyboard entry and edge clamping.
Temporary insertion was undone and reference tabs closed. Existing static REA
provenance remains in docs/reference/notion-database-interactions-20261027.md.
Fresh public settings asset acquisition returned403; no fresh static result or
proprietary implementation copy is claimed.

Nineteen reviewed commits, ordered7f26b74f throughce974470, cover:

- Table Tab skips collapsed groups/summaries; headers are Tab-reachable.
- Stable group identities preserve collapse across result refresh/reordering.
- Typed safe HTML/plain clipboard with async platform transfer and focus guards.
- Truthful List page/custom settings, default reset,30px rows/virtual estimates.
- Neutral Board titles and compact290px settings with inherited filter summaries.
- Logical focus after property/option reorder.
- Anchored/clamped compact single-property editor with Bases accent.
- Direct supported Tasks/configured source routes, keyboard/IME/focus navigation.
- Dirty Escape retains setup; explicit Back cancels only unsubmitted configuration.
- Keyboard-accessible page-peek title and owned local hints.

Named UI extension changes Session only through three anchor-forwarding arguments;
save/lifecycle/recovery/pending/reload guards remain unchanged. No Workspace,
NoteBuffer, platform/index, property-widget, desktop bridge or Rust changes.
Existing ordinary-note Properties and embedded filename hiding are preserved.
Single-property Apply/Cancel/save semantics remain; no outside dismissal or body
portal. Full property-manager and universal Notion parity are not claimed.

## Frozen-source verification

Evidence: tmp/notion-fidelity-20261028 in this worktree.

- Combined focused selection408/408 PASS,0skip/cancel,20.56s:
  composed-focused003.log. Earlier270/358 selections overlap.
- Full TypeScript/native frontend build PASS: build-final.log. Existing chunk-size
  and ineffective-dynamic-import warnings remain. No Rust/mobile/WASM build.
- Six neighboring legacy toolbar-session failures reproduced at exact baseline;
  that selection is not reported green. Old Board height oracle also fails baseline.
- Actual browser preview: List30px, settings290/28/14, undecorated Board titles,
  trusted Tab through peek/header controls.
- Final Electron44.9.1 creation/property PASS, exactce974470: chooser290/font14,
  Tasks prefill, dirty Escape retention, Back cancellation,390×461 anchored editor
  within viewport/original owner, scroll retains draft, Cancel removes editor.
  frontend-ui-receipt.json; rea-frontend-ui002.json;
  REA ev_df9143ca524e0a39d2a3f152032a8867b0450954a5c2da1c1177e4ce8f433460.
- Final actual Electron clipboard PASS:10typed values spanning supported types,
  null/empty list, opaque IDs and precise datetime. electron-clipboard-receipt.json;
  rea-native-clipboard007.json;
  REA ev_e58d6c67bbaa3281d93967bc45e918782d6467be8c67de516cf9d7f42c3655ba.
  Known owned/empty clipboard baseline restored. Foreign nonempty clipboard aborts
  without replacement. Deprecated-paste candidate385e6dd2 was rejected, absent.
  Earlier failed harness attempts retained and not treated as acceptance.
- Final mains17717/23565 normal0/nullsignal and subsequently absent; owned preview
  server41406 stopped. No real/default app or vault was changed.

Exact native runtime44.9.1 SHA:
ab18c7c9505311f76d8a34bac53a0bffa0e742f4673b002ad3c88314025ab841.
Root dependency44.8 is not relabeled. Screenshots zorid-create-database-final.png
and zorid-property-editor-final.png show actual isolated frontend components.
Browser connection dropped during later preview work; remaining preview-tab closure
is unverified. Reference tabs had already been explicitly closed.

## Handoff and open gates

Integration owner must reconcile this ordered branch with current main, revalidate
composition (especially UI-only Session forwarding), package pinned runtime and
complete whole-app save/restart plus installed smoke. This session has made no main
mutation since lane release. Later documentation commits do not change tested source.

Standing installation at /Users/ctk/Applications/Zorid.app remains required but HELD
by protected real-session draft recovery and the sole owner's replacement protocol.
No protected app quit, bundle replacement or deletion is cleared by this branch.
These component/native clipboard checks are not whole-app storage acceptance.
Exact animation/every-interaction parity remains unproven. Separate Base post-edit
latency and external adoption/Search latency findings remain OPEN.

## User-requested main merge and Applications staging — 2026-10-29

The user explicitly requested merge without further cross-session coordination;
clean main fast-forwarded de72ad3f→58da213c. Tested runtime is byte-identical to the
reviewed branch. The user then explicitly requested Applications replacement.
Rebuilt native frontend using existing frozen44.9.1 dependency graph; PASS.
Standard packaging hit the existing pnpm collector lockfile issue; isolated staged
packaging succeeded without runtime/source changes.356 packed files verified.
Embedded native host remains a1c862be; no Rust compilation occurred.

Actual packaged app with separate disposable userData/vault, no host/dev overrides:
ordinary-note save plus restart and Base render PASS in both normal0/nullsignal
launches. Evidence under isolated worktree tmp/notion-fidelity-20261028:
install-build001.log, install-package003.log, install-verify001.log,
package-smoke001/receipt.json, applications-stage-receipt001.json.

Verified byte-identical new bundle staged at
/Users/ctk/Applications/.Zorid-next-58da213c.app (273 file/link inventory entries).
ASAR33474da8c2e7369b017dec4a11404f192e758df1c86f76d3aebffd7f6d1398ad.
Installation and previous-bundle deletion remain PENDING: exact protected real
PID71549 is still running, with no new proof of saved Home/Project Idea drafts.
No Quit, reload, freeze, draft apply or replacement was attempted. User was asked
only for the current durable-save status after all safe staging/checks completed.
