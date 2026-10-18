# Native bounded import and larger Text verification

## Store11 streaming/default desktop follow-up — 2026-10-17

Combined candidate3a082b0 is integrated on main293df57. Single-job tests used
command-only test opt-level1. Desktop host86481 passed the real subprocess
17MiB protobuf publication/pin/read test in34.66s. Standalone CLI61291 passed
its16MiB+17 stdin/file/raw/base64/original-retry process test in71.10s, then the
basic current-RPC encrypted backup/restore check in2.43s. Native17MiB staged
restart/lost-open-ACK and compound external reconciliation checks also pass;
the compound fixture resumes its existing soft budget rather than extending it.

Actual normal Electron renderer at source66bbc8c (same native source as the
merged candidate) loaded the isolated candidate's exact `dist/index.html` with
all fixture-selection environment variables removed. Its default Rust host
opened a fresh disposable profile/vault without backend credentials. The normal
editor saved79 physical bytes, SHA256
`30e5bde5d550835f8218a2a2507a36cf30b0b6d605c1f73337749b2a1b9e23c5`.
Independent CLI read identical bytes while the host stayed open. A separately
created external Markdown file appeared in the normal file tree and opened with
its exact expected text. Graceful quit/reopen retained both files and the edited
note. Both owned Electron sessions49442/6394 exited0 and are closed.
Nonsecret result: `/private/tmp/zorid-streaming-desktop-result-1017.json`.

Main's frozen offline dependency install and typecheck/renderer build7075 pass.
Verified matching native binaries and that rebuilt renderer are published to
main's ignored runnable artifacts; previous hashed assets were retained for any
existing window. `target/debug/zorid-build-provenance.json` records source293df57,
candidate3a082b0, exact hashes and test profile. CLI SHA256:
`fb82383afe584a1c544ef5f0d0cf1246b55d3531ed8fb6c76f05ba8ef7646e79`;
desktop host SHA256:
`cc5dbbdfcdf67d80ae12d4260fe2d812a570dc7866e445ab47ed7fc075889ccc`.

Main4d3c12d subsequently passed actual Electron-owned RPC2 upload/receive via
its explicit verification UI/private IPC/native host, with fresh normalized-v7
browser and independent CLI. The relay was actually stopped; three independent
offline appends survived failed sync. Restarting the same DB/server epoch
converged all three to85 exact bytes, SHA256
`b3ae03939d06bfa6c8decbc24473d4d90b5ee0aaa614eb9fe53fcca263105496`.
Electron/CLI pending counts were0 at cursor5; browser completed. This does not
expose sync controls in the normal editor or establish production enrollment.
Original /private/tmp fixtures subsequently vanished. The report
`tmp/shared-core-final-1017/rpc-convergence-observed.json` reconstructs prior
tool observations, rather than preserving the original databases/reports.

The current normal default Electron then opened ignored-repo fixture
`tmp/shared-core-final-1017/recovery-vault` with all fixture-selection environment
variables unset. A watcher observed the exact54-byte unsaved draft durably
checkpointed while the physical baseline remained24 bytes. SIGKILL terminated
only verified owned app6746 and host6780. Independent CLI committed53 competing
bytes; the checkpoint draft remained unchanged. Normal reopen displayed the
retained54-byte draft. Save recovery copy produced a distinct54-byte note while
the original retained the CLI's53 bytes; independent physical/checkpoint reads
confirmed both versions and a clean checkpoint. Draft SHA256:
`4dda66ab5ffb187ffcf2b1507d7279486ba4403d7edcfb59f650ad472db551a7`;
CLI original SHA256:
`4f76ca1aa11ce9b44dd1a34e6cebf8dc0de6305698b031ab98eeac02da3d275a`.
Current report: `tmp/shared-core-final-1017/crash-observation.json`; profile:
`tmp/shared-core-final-1017/recovery-profile`. Actual native undo/redo/selection
also passed in this session. Actual OS Zhuyin composition passed: `s,u,3`
produced `你`, `c,l` displayed the intermediate `ㄏㄠ`, and `3,Return` committed
`你好`. Undo removed the composed text and redo restored it. Independent CLI
and physical reads agree on the final34-byte fixture, SHA256
`e755f0bc06d50318ce1cba507eace4eef36990c736a4a3c3e364e3342b4f4695`.
The fixture also contains earlier input probes; this is a bounded composition
smoke check, not broad language/input-method coverage. Normal main app reopen
displayed the committed text exactly. Owned sessions50032/64810 exited0 and are
closed. Nonsecret observations are committed in
`docs/verification/shared-core-final-2026-10-17.json`.
No native-mobile or production-enrollment claim follows.

Verified 2026-10-17 by the shared-core coordinator. Source candidate
`core-default-integration` at `f4e6ec2`; reviewed scanner batch integrated on main
through `77bb43f`. The candidate also includes the bounded Text diff fix now on
main as `4a48a79`. These checks use disposable vaults, not real user data.

## Build and focused checks

- Native progress fixtures: handle `47817`, 6/6 passed. Independent reopen,
  stable identities, partial coverage, deferred moves and corrupt resumed proofs.
- Existing external reconciliation scope after retention fix `d44e57f`: handle
  `16545`, 51/51 passed. The preceding 50/51 result found a missing retained
  observation behind pending namespace work; the fix retains bytes without
  authorizing that conflicting import or changing physical bindings.
- Adapted host incomplete-discovery fixtures: handle `38267`, 2/2 passed. The
  fixtures use a blocked symlink instead of relying on the repaired directory cap.
- Matching CLI and desktop host build: handle `56614`, exit 0.
- Desktop renderer: `pnpm run build:desktop` initially rejected the older isolated
  workspace's missing `packages` field before compiling. Direct installed
  TypeScript (`67589`, exit 0) and webpack desktop production (`65160`, exit 0,
  6.597 seconds) then built the same source without dependency changes.

## Independent CLI processes

Fixture: `/private/tmp/zorid-progress-cli-1017-2cjx02sd`.
Exact command/results: `report.json` in that directory. Reproduction driver:
`/private/tmp/zorid-progress-cli-proof-1017.py`.

The standalone executable initialized and fixture-enrolled an empty vault with
no Electron, daemon or server connection. A protected synthetic credentials file
was outside the vault; the loopback endpoint was not contacted. After enrollment,
the driver created 270 directories, three representative custom-extension notes,
and a larger Text note. It removed one previously committed note physically.

Twenty-two separate `rescan --max-entries 32 --max-duration-ms 5000` processes
resumed scan `70caa60d-a1c8-4a31-84f1-e29520623a48`. Every observed imported path
kept its identity. Every partial scan retained the missing note's committed bytes
and authorized no namespace changes. Only the complete inventory deleted it.
The final inventory had 275 entries. A subsequent independent full bounded scan
was complete with no imports or namespace changes.

An explicit enrolled Text write replaced a seed with 41,800 UTF-8 bytes / 36,300
Unicode scalars, including emoji and combining characters. Independent raw reads
and physical bytes matched exactly:
`544b47b719c6aa46b9c640201e3b7757654009295885cfd37f8e8364c539b3a9`.
The entire driver passed in 56.430 seconds of command execution. This establishes
progress beyond 256 directories and removal of the artificial 8,192-scalar diff
rejection within the existing 256 KiB Text limit; it does not raise that limit.

## Rebuilt Electron UI

Fresh fixture: `/private/tmp/zorid-progress-ui-1017-zw7500h3`. Its launch script
sets only the isolated user-data directory and loads the candidate desktop entry.
No Rust opt-in, credentials or development URL was supplied. The selected vault
initially contained 270 folders and `LargeNative.md` (41,800 bytes).

Actual process `21921` used the candidate's rebuilt renderer and default-discovered
Rust host (`--initialize-local`). The UI displayed the persistent incomplete import
status while folders arrived. Clicking Retry showed the Checking state and
continued importing. Eventually its file outline reported 271 items, the warning
cleared, and the quick switcher opened `LargeNative` in the normal editor, showing
36,300 characters. No CLI rescan was used to complete this UI fixture.

An initial automation paste inserted unrelated clipboard contents rather than the
requested marker. It was undone and saved; that attempt is not counted as the
requested-input proof. Direct typing then inserted `NativeUIDurable1017`, and
ordinary Save completed with no error or pending Saving status. The editor showed
36,319 characters. An independent CLI read and physical file both matched the
entire expected original plus marker: 41,819 bytes, SHA256
`6064def02fe4d6b4386190bb62aa49d8a43ab55834aa0d9bf1fd2a145b6be4a1`.
Stable file ID: `87b4a99d-c964-4253-8a62-e2183d6c90a3`.

Normal application Quit completed with `21921` exit 0. The agent's test app is
closed. This pass establishes native import/open/save for the larger note; it
does not claim a large-file streaming path, new encrypted relay roundtrip,
mobile behavior or seamless stale-editor merging.
