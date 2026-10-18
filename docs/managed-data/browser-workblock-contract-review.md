# Independent browser WorkBlock implementation contract review

Verdict: **approve corrected frozen contract**. No remaining concrete contract blocker found within the assigned current-v1 browser WorkBlock scope. This is design acceptance only; root must grant named source ownership before implementation, and actual runtime evidence remains outstanding.

## Exact freeze and scope

Reviewer task `task_0f5096e17251`, dispatch `ctx_27213f795b83`, terminal `term_2dcfabfe-0653-40e0-9c9e-b04127cd9e56`.

| Artifact | Final SHA-256 |
| --- | --- |
| /tmp/zorid-browser-workblock-map.md | d88111f7ef2a8748e4e0effd5955408db3725783e39ed53dae11685e62a21dc6 |
| /tmp/zorid-browser-workblock-contract.md | adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082 |
| Contract's 17-file existing-source witness | b47ad86362879f885a36bff96d0a4d4e0e1813db0bfb51cce73d8f295ff99494 |

Independently recomputed all three hashes at final review. The source witness uses sorted relative UTF-8 path + NUL + exact bytes + NUL, with the contract's exact path list under managed-desktop-integration. This authenticates the source referenced by the contract; it is not a broad new audit of all 17 files. Targeted inspection covered native command/reply DTOs, create/remove replay and window accounting, Store snapshot/journal structures, browser apply/snapshot/changes, normal Worker open/release/queue, managed host, runtime and admission seams, plus the execution checkpoint. No unchanged migration/lineage audit was reopened.

Initial author receipt: task `task_94941a785e7c` / dispatch `ctx_33eef202d916`, message `msg_44cc10f52bdc`, initial freeze 136612e2672726d9d64bf64a8bc6ab04aaebafce9941ce9488fdf10423a5e4d8. Corrected receipt: task `task_024636031e12` / dispatch `ctx_625ce9935826`, message `msg_f0baa991796c`, final freeze above. The final hash supersedes the initial freeze.

## Resolved concrete finding

Initial section 4 promised envelope checking and response size bounds without expressly binding output to the original immutable request. That could permit a shape-valid receipt for another operation or a read for another target to resolve success, unlike the existing desktop decoder's explicit request association. Reported directly to author in `msg_194a3288db40` and coordinator in `msg_7a2bdc92768e`.

The corrected section 4 now requires original mutation operation identity, original read record/generation, opaque 32-byte revision and canonical sequence validity, requested window counts/bytes/progress/cursor consistency, and changes monotonicity/next binding to the original after/limit. Malformed or mismatched mutation replies remain commitUncertain=true and cannot retire the original pending fingerprint. Section 6 adds focused acceptance cases for those checks. This closes the finding without requiring JS to duplicate range/intersection/reference domain semantics.

## Accepted contract boundaries

- Shared records helpers retain strict native DTO meaning, canonical decimal time and opaque revisions, all conflict candidates, fixed scope and exact v1 domain validation. Create uses the original empty-state witness with operation equal to generation. Semantic replay canonical-decodes the retained request and preserves original remove tags, rather than removing later re-additions. Native adoption remains a separately owned optional compatibility batch; no native journal/lease/session rewrite is smuggled into browser work.
- Private WASM delegates to existing RecordsPlan and shared admission. Browser semantic apply authorizes the current handle, checks exact committed local replay before accepted-state/restore/source/quota preparation, then performs state, bindings, change, result/journal, common immutable source/outbox and counters in one existing strict IDB transaction. Acknowledgement follows transaction completion and a fresh active check. Receive retains the common authenticated cursor/source protocol; no parallel outbox or public collection/schema authority is proposed.
- Authorized watermark is the collection's maximum managed-change sequence, not snapshot.changesAfter/global control. One-row listing uses the existing compound primary key, bounded receipt metadata under the existing 4096-receipt quota, and Rust-produced native ManagedSnapshot bytes for accounting. IDB tuple order is expressly private and deterministic, without claiming native JSON-key ordering equivalence or portable cursor bytes. No new schema/index/version change is assumed; a demonstrated missing invariant must return as a concrete scoped proposal.
- Window sessions bind query, budgets, last consumed key, watermark and private lifetime, retain at most eight opaque cursors, enforce 31 days/64 scanned rows/1 MiB, count filtered/deleted rows, and leave a byte-excluded row unconsumed. Fresh pre/post authoritative fences reject collection changes, while foreign/reopened/evicted tokens expire. No long-held IDB transaction or fabricated snapshot consistency is claimed.
- Fixed compiled registration and service attachment use the same maintained private handle. Initialization runs directly on the already-held local tail and precedes advertised readiness; maintenance is not recursively awaited on that tail. Normal semantic RPCs join the existing queue and retain session/config guards. Default browser exposes the admitted service only when ready; legacy unsupported capability remains absent, with no memory fallback.
- Admission wraps all service methods with existing owner/pending guards. Stop/drain precedes handle/window/storage/lease disposal, while synchronous release fences prevent new admission. Late postcommit owner loss, malformed mutation response, timeout and worker loss remain uncertain with exact retained identity; proven precommit rejection can be definite. No upload or peer-convergence claim follows from local receipt success.
- S/W/D/H/P/N/V batches name nonoverlapping seams and dependencies without granting edits. Current v1 WorkBlocks only: migration/lineage and public publisher/API design remain separate, Tasks/Calendar UI and mobile are excluded, and spaced repetition is removed entirely.

## Evidence still required

Focused helper/codec/admission checks do not establish browser behavior. Acceptance separately requires actual generated WASM and strict IDB through the normal product Worker/admitted service/fixed registry, then two independently persisted normal Workers performing encrypted offline convergence/restart through the common sync path. Retained transaction, source/artifact hashes, exact receipt/replay and no-echo/cursor/outbox witnesses are required. HTTP1 cannot establish gRPC/protobuf behavior. Later rendered browser Calendar UI/accessibility proof remains separately owned; native, desktop or synthetic registry evidence cannot substitute for it.

Only this review report was written. No source/index/build/install/app/network operations or tests were performed, and the prior migration review report/verdict was left intact. Root may use this contract acceptance to choose named assignments; it is not source implementation permission or runtime completion.
