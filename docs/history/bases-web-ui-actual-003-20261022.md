# Normal supported-web UI smoke003 — 2026-10-22

**All five normal note UI phases passed** on the current date-v8 core and WASM.
The real application created and renamed a note, accepted keyboard edits, saved
exact source, reopened after reload, found the saved marker and opened the search
result. This is normal supported-web note UI evidence, not full Bases UI,
production-build, desktop/mobile, sync, stress or visual reference acceptance.

## Exact execution and source

```sh
node /private/tmp/zorid-web-functional-ui-smoke.mjs \
  --root /Users/ctk/Projects/Zorid/.worktrees/types-bases-model \
  --expected-head fe75db9f4704d08a6113aa1e01408e8375643089 \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --out /private/tmp/zorid-bases-web-ui-actual-20261022-003 \
  --timeout-ms 120000 --runtime-authorized
```

The existing private harness hash was verified before launch:
`433e806b189e271808001324eb78443d38ea3915a3139039cb70507e06218d34`.
It was not edited for this run. Session 71664 exited 0. The coordinator granted
the sole runtime slot and froze the checkout through final proof. The normal
`vite.config.mjs` selected the normal browser adapter/storage with fixture mode
disabled, reusing the exact warm generated WASM. No Cargo/build or test fixture
seeder was run. The source entry was the normal `main.ts` Workspace path.

| Witness | Exact value |
| --- | --- |
| Frozen checkout | `fe75db9f4704d08a6113aa1e01408e8375643089` |
| Rust crates tree | `8074eabf01c55cf4e53f01c02a5a384197875a24` |
| WASM input fingerprint | `6041e8e6354b0a60e7482af8910470d3df24fd33ed47c651a68b6c286abe10ee` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `8f9d8d6337ba0c8a8042eb568d9deaa0ea23e4c90b694d5aa4312ff4f2f03d05` |
| Actual core module | `lib/core/54b71970aa7bdce99aca36f0ece268f8349e9284c751c2e81b1f7900f03f7e19/zorid_wasm.js` |
| Raw report SHA-256 | `973bb7a286af0f5115091b8ebb23583f05c9bef291aad6d677563e58aa8bc00e` |

The run used headless Chrome `156.0.8078.47`, began
`2026-10-22T13:08:58.084Z`, finished `2026-10-22T13:09:10.566Z`, and recorded
12475 ms elapsed. This small workload is not a latency or throughput acceptance
measurement. The 120-second whole-run deadline remained enabled.

## Observed behavior and independent oracles

1. Normal New note created `Untitled.md`; editing the normal title and pressing
   Enter renamed it to `Functional browser note.md`, retaining entry identity
   `b2290212-adec-44d3-87e9-6fbcf3b17a00`. The normal title-Enter transfer focused
   the current connected CodeMirror editor before body input.
2. Keyboard input entered exactly the 51-byte UTF-8 source below. The normal
   save-state control cleared and an independent read-only IndexedDB source
   check observed revision `60b96eca-e8ca-4ed1-99f9-e01a8522feaf` and exact bytes.
3. Reload committed a new document (`performance.timeOrigin` changed), mounted
   normal controls and reopened the identical entry, revision and source.
4. Normal rich search for `ZoridFunctionalUiMarker7c42` reported exactly one
   match in one file, with the expected entry/path, snippet and highlighted marker.
5. Opening the normal search result showed the exact title and editor text.

```text
Ordinary browser note.
ZoridFunctionalUiMarker7c42
```

The source has a trailing newline. Input went through CDP keyboard insertion
after the ordinary title focus transfer, with passive input/focus/editor identity
observations. The harness did not force body focus, dispatch editor/controller
mutations or write source through storage internals. IndexedDB inspection was
read-only and refused unexpected database creation. It did not inject an internal
release call for reload. No renderer exception was observed.

## Integrity, cleanup and retained evidence

Raw evidence and screenshots are retained at
`/private/tmp/zorid-bases-web-ui-actual-20261022-003/`: `report.json`,
`saved-note.png`, `rich-search.png`, `reopened-note.png` and
`post-run-integrity.json`. Screenshot existence is supporting evidence, not a
visual-equivalence judgment.

The runner's pre/post proof remained equal. Independent post-run verification
rehashed all 794 source entries, all 433 WASM build inputs, both generated assets,
the Chrome executable and the exact private harness. The frozen HEAD and tracked
source remained unchanged. The saved/reopened source objects were equal. The
private harness retained its original 120-second guard and all five assertions.

Owned Chrome PID 41886 closed through normal `Browser.close`, exit 0 and null
signal, with no termination fallback. An independent read-only process check
confirmed that exact PID absent. Owned Vite origin `http://127.0.0.1:60873` closed;
an independent port probe returned `ECONNREFUSED`. The first sandboxed process
probe could not launch `ps`; the same bounded check succeeded with escalation.
That verification environment limitation did not alter the app or raw run result.

The private `chrome-profile` and its normal IndexedDB data are deliberately
retained under the output directory as evidence; they were not deleted. No test
browser or server remains. The source freeze and runtime slot were released after
independent proof. No unrelated user application, profile or vault was changed.

This run exercises one note and one rename. It does not cover complete Bases
widgets, HTML sanitization, native focus/IME, attachment paste, cancellation races,
other browsers, production bundling/login, mobile, sync, crash recovery or stress.
[Browser010](bases-browser-actual-010-20261022.md) separately covers all 19 Bases
semantic groups and 146 typed expectations through the admitted Worker/WASM path.
