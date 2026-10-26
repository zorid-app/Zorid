# Normal supported-web Workspace smoke

This checked-in replacement for the lost private web003 harness is **authored,
not runtime-accepted**. It recreates that record's five independently checked
normal note workflows. It does not run the Bases fixture page or seed a vault.

After the coordinator freezes a matching already-built WASM cache and grants the
serialized browser/server runtime slot:

```sh
node tests/bases-web-integration/run.mjs \
  --root /absolute/frozen/checkout --expected-head FULL_40_CHARACTER_HEAD \
  --wasm-dir /absolute/frozen/checkout/target/browser-wasm/generated \
  --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --out /private/tmp/NEW_NORMAL_WEB_EVIDENCE \
  --timeout-ms 120000 --runtime-authorized
```

The harness refuses stale/missing generated WASM before normal Vite configuration
is imported. It uses the normal `vite.config.mjs`, with fixture environment
variables disabled, and requires that config's ordinary content-addressed module
path. The normal cache loader must find the exact current warm cache; this runner
does not invoke Cargo, a build script, a fixture registry or another provider.
Compiler/bindgen commands are disabled in this dedicated process so a cache race
fails instead of implicitly rebuilding through normal configuration.
`--wasm-dir` must be the selected checkout's normal generated directory. Run this
harness from that checkout, with committed sources and a fresh output directory
outside source/build roots. No package installation is performed.

| Phase | Positive input and independent oracle |
| --- | --- |
| Create and rename | Hit-tested normal New note creates `Untitled.md`. Keyboard title edit plus Enter renames it to `Functional browser note.md` with the same entry identity. Enter must naturally transfer focus to the connected editable body. |
| Edit and save | Input inserts exactly `Ordinary browser note.\nZoridFunctionalUiMarker7c42\n` (51 UTF-8 bytes), with no forced body focus. Settled normal save-state and a read-only IndexedDB transaction must agree with the whole independently authored byte string. |
| Reload | Normal `Page.reload` produces a newer `performance.timeOrigin`, reopens the same note and retains its exact entry, saved revision and complete source. There is no private release/restore call. |
| Search | Normal sidebar Search enters the literal marker. Rich search must show exactly one match in one file, the same entry/path, and the exact highlighted marker with no stale/incomplete/loading message. |
| Open result | Normal search-result pointer input opens the exact title/source; read-only persisted entry/revision/bytes still match. |

IndexedDB inspection enumerates the existing normal database first, refuses
creation/upgrade/version changes, and uses only `readonly` transactions over
metadata/content. It never changes database contents, source, settings, clocks,
session storage, application controllers or adapter state. DOM evaluation reads
visible controls, focus, text and results; all positive changes use ordinary
pointer/keyboard input. The expected source/search results are handwritten.

Provenance requires all four executing harness files and their shared input/
cleanup helpers to be tracked in the frozen Git checkout; untracked executable
source in the selected closure is rejected. It covers all Rust WASM build inputs,
generated metadata/assets and Chrome before/after the run. Normal main.ts,
Worker and content-addressed asset requests are recorded. Separately labelled
driver GETs verify those ordinary server routes' bytes; they are not counted as
browser fetches. Exceptions/console errors and incomplete phases fail. The
whole workflow has a bounded deadline; resource cleanup has its own bounds.
Late startup resources are tracked and their close outcomes are awaited/recorded;
unresolved or failed cleanup cannot pass. Final acceptance checks exceptions
again after browser exit and final provenance, including errors arriving during
the asset-verification tail.

Only the fresh owned headless Chrome child/profile and loopback Vite server are
created. `Browser.close` must yield a normal exit; fallback signals cannot satisfy
acceptance. All cleanup branches run and failures remain failures. The profile
and normal browser database stay inside the evidence directory for inspection;
no unrelated browser, process, vault, profile or clipboard is changed. Reports,
screenshots, passive focus observations, CDP diagnostics and Chrome stderr are
retained there. This covers a development-server note workflow, not production
bundling, full Bases UI, physical input/IME, other browsers, mobile, sync, visual
equivalence or performance.

Bounded offline source/oracle checks (no app, server, browser or WASM execution):

```sh
node --check tests/bases-web-integration/run.mjs
node --test --test-concurrency=1 tests/bases-web-integration/oracles.test.mjs
```

Historical web003 acceptance remains at
[`docs/history/bases-web-ui-actual-003-20261022.md`](../../docs/history/bases-web-ui-actual-003-20261022.md).
New source review or passing offline checks do not establish a new runtime pass.
