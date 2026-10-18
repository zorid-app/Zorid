# First shared-core milestone acceptance

Verified 2026-10-17 against integrated source main `4d3c12d` (source merge
`293df57`, reviewed combined candidate `3a082b0`). The shared-core coordinator
owns main integration; an independent acceptance worker reviewed the original
goal and roadmap requirement by requirement. The final changes are evidence
records, not another runtime implementation batch.

| Requirement | Observed evidence |
| --- | --- |
| Portable Rust core and browser feasibility | Real Rust/WASM release69772 and43 wrapper tests90716; combined browser97 checks19973. Actual normal browser uses its worker/WASM core and IndexedDB7. [Browser evidence](browser-relay-verification.md), [earlier actual WASM/CRDT boundary](wasm-family-browser-verification.md). |
| Independent web, Electron and standalone CLI | Normal browser/default Electron create/save/reopen without backend credentials; standalone CLI embeds its own core. CLI subprocess checks work with desktop closed; exact independent reads also match while the desktop host is live. [Native evidence](native-progress-verification.md), [CLI contract](core-cli.md). |
| Offline encrypted cross-client convergence | Actual Electron verification UI → private IPC → Rust host → RPC2, fresh normalized-v7 browser and independent CLI each append during a confirmed stopped relay. Restart of the same DB/epoch converges to exact85 bytes/hash; Electron/CLI pending counts0 and browser snapshot complete. [Final observations](../verification/shared-core-final-2026-10-17.json). |
| Desktop/CLI concurrent safety and crash/restart | Verified owned app/host SIGKILL after54-byte durable draft, before24-byte file baseline changed. Independent CLI commits53 competing bytes. Normal reopen retains draft; recovery copy preserves54 bytes separately, original remains53, final checkpoint clean. [Native evidence](native-progress-verification.md). |
| Browser-tab safety | Actual normal production browser competing tabs preserve the losing editor draft through reload; recovery copy retains it separately from the winner. Ownership/duplicate fencing and tab release also verified. [Normal browser](browser-normal-verification.md), [current browser evidence](browser-relay-verification.md). |
| Text, binary, unknown extensions and folders | Actual browser17,825,809-byte Blob import/upload and independent CLI streamed/disk receipt are byte-exact. Host86481 and standalone CLI61291 independently pass >16MiB process checks. Folder and unknown-file operations are part of the native/CLI fixtures. [Native](native-progress-verification.md), [browser](browser-relay-verification.md). |
| Move/delete/external edits | Real independent CLI2MiB binary transfer/move/delete54910 passes; native17MiB compound19553 passes. Actual compound external folder move/text edit/child deletion preserves identities, exact bytes and quiet restart. Partial inventories cannot authorize deletion. [External reconciliation](external-reconciliation-verification.md), [native progress](native-progress-verification.md). |
| Duplicate/reordered updates | Portable acceptance60597/108 and file-sync68041/116 pass, including reverse delivery/restart, duplicate and pending-dependency fixtures. Actual retained-browser echo replay64+52 completes under independently reviewed3a082b0 without changing entry/revision. [Roadmap](../deferred-product-roadmap.md), [browser](browser-relay-verification.md). |
| Account/vault isolation and E2EE | Actual CLI/browser account-B and mixed-scope denial/reload checks pass. Backend65524 and current RPC51477/16 cover authorization, current permission/revocation checks before duplicate ACK, opaque ciphertext and vault separation. [Browser isolation evidence](browser-relay-verification.md), [relay contract](sync-relay.md). This is not an independent production security audit. |
| Protocol compatibility | CLI compatibility54282 passes7 checks: required Hello/page/ACK incompatibility preserves cursor/pending ciphertext, future payload rejected, legacy-v1 explicitly rejected. RPC adapters require transport2; encrypted envelope1 and Text/Files2 remain separate versions. [Roadmap](../deferred-product-roadmap.md), [protocol](sync-protocol.md). |
| Basic encrypted backup/restore | Current CLI61291 encrypted restore passes in2.43s. The real clean-client fixture reconstructs namespace/text/multi-chunk binary after original client state removal, verifies restart, new server epoch and rejected restored credentials. Earlier pinned-WAL account/permission backup checks also pass. [Native evidence](native-progress-verification.md), [roadmap](../deferred-product-roadmap.md). |
| Actual editor undo/selection/composition | Native typing, undo, redo, selection replacement and real OS Zhuyin composition/commit pass. Composed你好 survives undo/redo and normal reopen; independent CLI/disk agree on34-byte final probe/hash. Owned sessions50032/64810 exit0; process inspection confirms no owned recovery app/host remains. [Final observations](../verification/shared-core-final-2026-10-17.json). |
| Review, integration and resource discipline | Implementations used isolated worktrees, named seam owners and independent review; only the coordinator integrated main. Heavy checks were serialized with bounded concurrency on the8GB machine. Main frozen offline install/typecheck/desktop build7075 passes; runnable artifact hashes/source are in ignored target/debug/zorid-build-provenance.json. No service deployment or real-vault migration ran. |

The current final JSON retains nonsecret crash and input observations. Its RPC
section explicitly reconstructs already observed tool outputs: the original
temporary RPC fixture databases/reports subsequently disappeared and are not
preserved by that JSON. Earlier verification documents are chronological records;
their old pending statements do not override the current checkpoint and table.

This acceptance closes roadmap waves1–3 for the first shared-core goal. It does
not establish normal-editor sync controls, production account/device enrollment,
automatic background sync, full history/off-host backup administration, release
security, mobile or P2P. Local operation is available without the backend.

Next is wave4: [shared document semantics](../shared-document-semantics-plan.md).
Start with shared behavior fixtures/contracts and portable Markdown metadata,
then rebuildable revision-aware indexes/search/backlinks and Base evaluation;
migrate consumers incrementally. Device-joining UX remains a required adjacent
follow-up with its staged reconciliation/security design still to settle.
Native mobile, full history/backups/admin and release gates remain later required
work. P2P and parallel indexing remain recorded in
[future improvements](../future-improvements.md); seamless stale-editor automatic
merging stays after all six stages as requested.
