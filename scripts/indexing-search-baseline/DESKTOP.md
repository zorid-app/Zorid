# Actual macOS Electron editor baseline

This harness prepares the Electron slice of the
[agreed baseline](../../docs/plans/indexing-search-baseline.md). It builds nothing
and requires a coordinator-frozen source checkout, matching desktop frontend and
native host plus an explicit runtime slot. It owns only a newly generated fixture
and profile, never an existing vault or the user's manual playground.

```sh
node scripts/indexing-search-baseline/desktop.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matching/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --build-mode debug \
  --out /private/tmp/zorid-s1-desktop-smoke-UNIQUE \
  --notes 100 --timeout-ms 300000 \
  --ready desktop-baseline-artifacts-frozen --runtime-authorized
```

The destination must be absent. Canonical paths are resolved through ancestor
symlinks before creating output; source/harness/manual roots and aliases are
excluded. Artifact paths cannot point into the manual playground. The normal
Electron launcher uses a fresh profile, the deterministic workload's vault and a
separate `ZORID_LOCAL_DATA_DIR`. Fixture runtime flags and development URLs are
removed. The exact spawned PID/executable/profile is revalidated before AppKit
hide or quit requests. Only that app and its exact native children are cleaned.

The app is hidden before any interaction. CDP drives ordinary Search controls,
opens an actual result and sends keyboard text to the real CodeMirror editor.
Screenshots capture the rendered surface. This does not measure foreground OS
focus/typing, IME or physical traffic-light input. No main-process inspector,
method wrapper, injected save service, direct bridge mutation, index pump or
private database write is used. Diagnostic listeners observe DOM input/state;
read-only requests use the already admitted, root-scoped bridge.

## Sequence and correctness witnesses

1. **Automatic import/setup:** generate the shared versioned fixture. Start the
   normal app and wait for its automatic native import/recovery to finish. Match
   every manifest path to a committed physical ID/revision/size, hash every file
   through the actual native bridge and compare fixture filesystem hashes.
   Record actual presentation facts separately from synthetic manifest times.
   Require the index still uninitialized, then quit normally. Setup/source
   readback time is outside index measurements and can warm OS caches.
2. **Derived-cold process:** restart that profile and existing committed authority
   while the index is still uninitialized. Enter a unique literal in the ordinary
   Search box for note 42, or the last note if the fixture is smaller. The normal
   UI drives catch-up and queries. Read-only index status observes publication;
   require complete/current coverage and exactly the expected entry/path/snippet
   rendered with `data-state=ready`. Retain raw status/version/watermark samples,
   available UI progress observations and cache file sizes.
3. **Normal editor save:** click that actual search result. Check its original
   committed revision/content and wait for its loaded, focused editable body; the
   title alone is not an editor-readiness witness. Then replace its text by keyboard with the exact
   original source plus one marker line. All original YAML/properties/body stay
   intact. Require a visible pending-save witness and unchanged disk initially.
   Observe the clean save indicator, exact filesystem and committed bridge bytes,
   changed revision and settled durable note checkpoint with no pending operation
   or conflict. No other manifest source may change.
4. **Saved edit → index → visible result:** type the marker in the ordinary Search
   box. Observe the source-current index and exact visible unique result separately.
   Keep original input, verified-save, current-index and visible-result timing
   witnesses. No read-only observer calls initialize or pump the index.
5. **Warm restart:** switch back to Files and quit normally, then restart the same
   vault/profile/app-local data. Require the same current snapshot and exact saved
   note revision/bytes before searching. The ordinary marker search must render
   the exact same entry/snippet and retain that snapshot. Quit normally again.

Every normal quit requires actual exit 0 with no signal and native-host drain.
A SIGTERM/SIGKILL fallback is cleanup only and cannot satisfy those checks.
Failures preserve their screenshot, DOM, raw runtime output and available facts.
No completed phase, cleanup attempt or original failure is converted into a pass.

## Timing and evidence scope

`report.json` retains source/generator/harness/helper/dist/native/Electron hashes,
actual renderer Chromium and Electron user-agent versions, caller-supplied native
build mode, machine facts, raw status samples, snapshots, available UI progress,
cache database/WAL file sizes, every measured interval and process outcomes.
The native executable hash is measured before/after; correspondence to the frozen
source/build mode is the coordinator's supplied build provenance, not inferred
from a filename. Frozen inputs must remain equal after execution.

Milestones are observed bounds, not exact backend event timestamps:

- Input dispatch and CDP acknowledgment are recorded separately. DOM listeners
  retain actual input/state observations without wrapping product handlers.
- Input → clean save is the visible indicator observation. Input → verified
  durable save additionally includes exact disk/bridge revision/content and the
  settled checkpoint readback. It includes observation and transport cost.
- Verified save → current index and → visible result are measured separately,
  along with editor input → those endpoints. Read-only status and DOM polling
  run at 100 ms intervals, adding queue/observation overhead. If freshness occurred
  before observation, the harness reports the observed upper bound.
- Warm startup is spawn → normal workspace ready, followed by status/query work;
  it is not a breakdown of Electron/native startup, SQL validation and parsing.

Database/WAL file lengths are not cache-entry counts. The public status/UI lacks
parse-call/reuse, queue wait, CPU, peak-memory and cancellation counters; absent
metrics remain null. A retained matching snapshot does not certify zero source
reads or zero validation work. A debug native smoke establishes correctness, not
production latency budgets; representative performance comparisons require a
matched release host/CLI and recorded frontend build conditions.

The initial 100-note pass is one correctness smoke, not the five-run 10k campaign,
100k stress, full editor parity or S1.0 completion. Product Search limits remain
in force: a query becoming incomplete, unavailable or lagged cannot pass as full
coverage. Only unique-result presentation is measured here; complete literal
membership/range/page oracles belong to the shared CLI/browser baseline tools.
No source/cache deletion manufactures cold state, and no real-vault data is used.

For larger fixtures, the current UI may offer Continue indexing after its bounded
catch-up budget. This harness does not force further pumps or silently click that
action. Incomplete/continuation/timeout evidence must be classified as the observed
UI budget boundary, not proof that the Rust engine cannot index the fixture. A
later separately measured ordinary continuation flow is needed before extending
this unique-result UI smoke into a 10k presentation campaign.
