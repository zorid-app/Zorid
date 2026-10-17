# Native bounded import and larger Text verification

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
