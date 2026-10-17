# Actual normal browser verification

Owner /root/default_lifecycle_review_sol. Source b66246c (through d1ac52c), isolated
browser-rust-default; root owns main integration and aggregate checks. This page
records normal-editor CUA observations, separately from the older smoke page.
No programmatic browser storage/state injection was used.

## Build

Initial build95472 failed before webpack because the selected Rust compiler had
no WASM target. Existing task-local Rust1.95 overlay plus explicit RUSTC corrected
selection; no toolchain was installed. Build87504 then passed Rust release in
1m04s and webpack production in72.236s with3 size/performance warnings.
Its first actual launch exposed invalid minified worker dynamic-import syntax.
The independently reviewed emission fix d1ac52c plus its tiny production parse
regression addressed that failure. Rebuild9631 exited0: current WASM cache hit,
webpack6.074s and the same3 performance warnings. Independently reviewed menu
fix666ac28 was integrated as b66246c; its7 scoped regressions, TypeScript check
and diff check passed. Final cache rebuild8135 exited0 in7.427s with the same3
performance warnings. No native build ran in parallel.

- Final main main.ed7359d6cc8d63cf8c36.js SHA256
  300b38d09c578b792c84d707b087d4a98053c01fe8bd76587bc3aef00eb7c682.
  Earlier concurrent-edit and duplicate-tab observations used main.fbfac58261358b050c6e.js
  SHA256 dbc0bf8cca24bce8b7697fda182a116969e20278e7f2671594496d838a93c21c.
- WASM content directory
  53a67c35dd4fb09d8e7287b60031c6e79d3259af77fe749a118890c3e04f55dd.
- Emitted generated JS SHA256
  967719a5559aafaf4a822e82f7d59619e73207b1559a58ef1bb7e4c2c9322b3d,
  matching the manifest.
- WASM2378971 bytes SHA256
  0d9efb8e2eda8e6cf741fd6f2e62791902c2879bc397cb41f88210218f7277cf.

## Observed normal editor behavior

Fresh static origin http://127.0.0.1:8791/ (server65716), no query parameters,
fixture selection, sync credentials or backend session. Chrome A tab1268037558;
independent B tab1268037561. Both opened simultaneously against the same logical
vault. B started with a separate empty workspace session while seeing A's files;
no duplicate consumer ownership rejection occurred. Worker client UUIDs are not
exposed by the UI, so this is behavioral ownership evidence, not a storage dump.

- New note creation, text save, clear Saving indicator and normal reload passed.
  Initial exact79-byte text: `Normal browser Rust local proof 2026-10-17.` then
  newline then `No relay credentials were supplied.` Visible text SHA256
  2a1ab7526cbda745fa14fcec37f9effd930114741ada6ec40c7434b9a6dc1522.
- Title rename to BrowserRustProof.md and folder creation/rename to BrowserFolder
  appeared in the authoritative file tree. Initial nested-note folder-menu
  attempts silently dismissed because harmless snapshot refreshes cloned the
  entry object captured by the row. The independently reviewed b66246c guards
  current path/token/type/revision and vault ownership instead. Final production
  CUA pass created BrowserFolder/Untitled.md via that menu, renamed it to
  BrowserFolder/NestedProof1017.md, saved exact33-byte `Nested browser durable note 1017.`,
  cleared Saving and reloaded to the exact same text. Move to trash then showed
  `Moved to vault trash.`, removed the original, and normal reload preserved its
  absence. The hidden trash object was not directly inspected.
- Editing immediately during an asynchronous title rename produced a retained
  draft rather than overwriting the renamed file. The exact21-byte `Shared
  baseline 1017.` survived reload and appeared with the Retained note draft
  recovery actions. Independent B then saved32-byte `Browser peer saved version
  1017.`. A's Save recovery copy created `Untitled (recovered draft 938bbce9).md`,
  A adopted the peer's original,
  and opening the copy showed the exact retained21-byte draft.
- For the explicit same-baseline concurrent-write pass, both actual editors
  visibly contained `Browser peer saved version 1017.`. Simultaneous CUA fills
  and Save actions yielded B's clean28-byte `Writer B retained race 1017.` and
  A's retained28-byte `Writer A retained race 1017.` with Save failed — draft
  retained. Neither draft was silently merged or discarded.
  A visible-text SHA25684b1dac069d0aa331542e37fcc39be0875e7ccca43c144e0578a217914b99dba;
  B visible-text SHA256efe52f0dcc776b6d2c2bc35a78ba7c68112f5ee476c43cf0ef6d41a4d3da1c59.
  A normal reload recovered the exact A draft with recovery actions. Save recovery
  copy created `BrowserConcurrentProof1017 (recovered draft c7fc715e).md` and the
  original adopted B's text. Opening and reloading that copy preserved exact A
  while B's original remained exact B.
- Actual editor append ` UndoProbe` followed by Meta+Z restored exact A. End,
  Shift+Left four times, Meta+C produced clipboard `017.`; collapsing selection
  and saving left the original A text unchanged. This is a bounded undo/selection
  check, not IME coverage.
- Actual Chrome Tab > Duplicate Tab of A created tab1268037564. It showed
  `Unable to open the workspace`, retained original recovery identity, and
  Technical details showed `Browser client slots are unavailable; retain the
  original recovery identity`. The UI does not expose the typed slot error code.
  Closing only the duplicate left A's recovery copy exact A and B's original
  exact B. No automatic fresh identity or silent ownership stealing occurred.

The first test note also acquired unexplained extra typing and an image outside
agent-entered actions. Those are preserved but excluded from controlled binary,
content-digest and edit evidence. The hashes above describe the exact controlled
visible text, not a direct read of IndexedDB bytes.

## Limits and handoff

Normal no-query local startup, simultaneous independent tabs, retained concurrent
edits, recovery copies surviving reload, duplicate-tab fencing, nested file
create/rename/save/reload and trash/reload were observed through the actual UI.
Source checks establish no broader runtime claims. Seamless stale-editor merging
is explicitly deferred by the user; this pass verifies retained alternatives.

Controlled binary import/digest, IME, forced process-crash interruption, physical
browser directory access, hosted enrollment and background sync are not
established by this pass. Existing older relay/offline evidence remains separate.
Root owns integration and semantic validation against current main.
