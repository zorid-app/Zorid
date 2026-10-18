# Passive mobile document editor host

New source task, root grant msg_ed12be2af3d5. Completed editor guards are unchanged.
Owner: term_0f955add-4708-4af3-91a3-10719e9ba77e.
Successor: /Users/ctk/orca/workspaces/Zorid/mobile-document-editor-host.
Branch: mobile-document-editor-host.
Base: current main 21cdb4bf4f2181b111eaba2f807c1105c143af05, includes 4dfaca23.
Source: 7a5caae14483117f6504f482781107b23652a9e2.
Only NEW src/ui/mobile-document-editor-host.ts and tests/mobile-document-editor-host.test.ts.

API proposal receipt msg_7b9c785c061c; paired acknowledgement msg_28bdf1ba6d54;
TS371 exact clarification ACK msg_ad502355faeb; root scope ACK msg_a91893bbe769.
These receipts preceded source implementation. Top-level isCurrent is mandatory
and composes with optional editorOptions.isCurrent. Workspace supplies snapshots,
rendering options, callbacks, canonical admission/save and title/property hook.
The host starts inactive through existing createEditor. It owns only its wrapper,
editor and scoped hook cleanup; disposal retires callbacks immediately and retries
only failed cleanup resources. Same-entry synchronize uses external setValue.
No NoteBuffer/load/recovery/read/write/client claim, independent parser, window,
route, native or platform implementation was added.

Actual verification:
node --test --test-concurrency=1 tests/mobile-document-editor-host.test.ts
Session 97482 observed exit_code 0, 7 passed / 0 failed.
Actual two CodeMirror instances, one writer, no passive focus/authoring, canceled
freeze identity/history/cursor/inner+outer scroll retention, external undo mapping,
retired/stale callbacks, late file transfer and scoped cleanup cases pass.

node --max-old-space-size=768 node_modules/typescript/bin/tsc --noEmit
Session 48435 observed exit_code 0, empty tsc.log.
No build, full test suite, heavy/native/Rust/Xcode/simulator/app job was run.
Source checks do not establish integrated Workspace/router or WK/phone/IME/visual
acceptance. Root remains sole main integrator; source review pending at freeze.

Reviewer: existing term_a0c7b316-8546-4777-95a2-fe08cb519356.
Exact new-module review requested msg_f5f6f7c51b1e, terminal prompt accepted with
turn_started. No broad completed-guard audit requested. Source frozen pending verdict.

Final independent SOURCE APPROVAL: msg_6ad6b04517e8, reviewer a0c7b,
exact source 7a5caae14483117f6504f482781107b23652a9e2 against base21cdb4bf.
No blockers found within agreed thin-host ownership. Reviewer inspected source
and logs, ran no checks and made no edits. Consumer responsibilities and native
runtime gates remain separate. Ready for sole root integration/consumer validation.
