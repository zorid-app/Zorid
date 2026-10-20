# Actual Base table component/core checks

This source-only runner builds nothing. Root must grant a serialized browser slot
and supply frozen clean source plus matching generated WASM. It mounts the real
production `Vault` and `createBaseSession` table against actual admitted
Worker/WASM/IndexedDB; it is not the normal workspace route or a native app test.

```sh
node scripts/indexing-search-baseline/base-components.mjs \
  --root /absolute/frozen/source --expected-head FULL_40_CHARACTER_HEAD \
  --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --wasm-dir /absolute/matching/generated \
  --out /private/tmp/zorid-s1-base-components-UNIQUE \
  --notes 512 --timeout-ms 1800000 --runtime-authorized
```

Output must be absent and outside source/harness/manual roots. Notes are bounded
128..768 (default512), each around1KiB. Timeout is per phase,10s..30min. The tool
owns only its newly created Chrome profile/database and loopback server. It records
HEAD/source/harness/helper/generated assets/Chrome hashes, actual browser engine,
phase JSON/screenshots, bounded component observations and release/cleanup results.
The same source/asset fence must hold on failure as on success.

1. **Real source seed:** D-off admitted source creation and exact readback of one
   alphabetically first Base plus the notes; verify absent derived snapshot, release
   the client and close owned Chrome. This establishes a deliberate first-build
   precondition; it does not measure normal end-user import.
2. **Actual partial and publication:** reopen the retained database with D-on,
   initialize the production Vault and mount its table immediately. No initialize,
   begin, pump, publish, fake preview DTO or delayed provider is injected. Require
   an actual rendered read-only partial table with positive pending-file count and
   prepared-subset counts/aggregate wording. Initial empty previews may show the
   subset-specific empty explanation but cannot satisfy the required nonempty
   table/pending witness. Every preview is checked; observer failures are sticky
   and fail the run even if later updates succeed. If core finishes before that witness,
   the run fails inconclusive. Require full actual publication and restored edit
   affordance; Enter/Escape opens/cancels one real table editor without changing data.
3. **Real update:** ordinary `Vault.modify` changes one note. Observe identical
   coherent mounted rows during updating, then the changed value on a different
   source generation. This verifies a real source/query refresh; it does not claim
   the index was still lagging at that exact DOM observation.
4. **Clock/zone:** the existing `BaseClockHost` seam supplies fixed Toronto time
   and executes only its actually scheduled callbacks at selected local midnight
   and one second later. The real Rust `now().format(...)` and
   `today().format(...)` answers must render exact independent strings on the
   unchanged source generation. No manual session refresh triggers these time
   checks. Injected clock delivery is explicitly labeled; the OS clock is untouched.
5. **Source and release:** read every actual source back; exactly one note may have
   a changed revision/body, every other ID/revision/hash remains exact. Close session,
   buffers, metadata and admitted client with acknowledged releases, and require
   no retained clock timers/listeners. Owned Chrome process-group/server cleanup
   is recorded separately; killing Chrome cannot substitute for client release.

Only a table is exercised end-to-end; existing source-matched jsdom cases cover
other view affordances. This does not prove full-workspace navigation, desktop,
foreground input, cancellation, sync, cache-hit rates or performance budgets.

Source checks (no Chrome/build):

```sh
node --check scripts/indexing-search-baseline/base-components.mjs
node --check scripts/indexing-search-baseline/base-components-fixture.mjs
```
