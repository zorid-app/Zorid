# Native sidebar Base context pinning

Source-only until a coordinator grants a serialized actual runtime pass with
matching frontend/native artifacts. This runner never builds or selects products.

```sh
node tests/bases-electron-sidebar-pin-integration/run.mjs \
  --root ROOT --expected-head FULL_40_CHARACTER_HEAD \
  --native MATCHED_HOST --electron ELECTRON_EXECUTABLE \
  --out FRESH_EXTERNAL_DIRECTORY \
  --ready bases-native-and-frontend-frozen --show-window
```

Seven public-control phases cover ordinary current-note following, pin freeze,
immediate unpin catch-up, refusal with an invalid numeric property draft, explicit
null context for a blank main tab, identity-preserving ordinary note rename, and
frozen renamed-context restoration across normal quit/relaunch while another
main note remains active. The final unpin needs no additional note-open action.
The shared runner records exact source/artifact freeze and closes only its owned
Electron app. Fixture notes remain byte-for-byte unchanged; only the explicitly
renamed context path moves. Read-only normal bridge `stat` proves its stable
entry ID, while ordinary logical reads agree with the physical fixture bytes.

The first Pin opens a clean sidebar View options portal through the normal Views
controls, then uses at most 48 actual Shift+Tab keys to reach the exact public
Pin button and sends one Enter. Every step records public focus and unchanged
panel/name/control state. No pointer, focus setter or fallback dismisses that
portal; the Pin operation must remove it before the frozen rows are accepted.
An unreachable keyboard route or an early/dirty/missing portal fails. This
native case does not establish the separate dirty view-name portal behavior;
that remains module-tested until a corresponding native scenario is run.

The retained numeric draft is exactly `88 invalid`. An ordinary outside pointer
can save a valid `88` through the widget's blur handler, so a valid value cannot
prove draft refusal or unchanged source. The invalid draft must survive pointer
Pin, preserve the saved `22`, and cancel through ordinary Escape.

Inputs use actual public controls and renderer mouse/key dispatch. DOM frames
and a bounded passive observer record current versions, pin state, row values,
focus-related title state and lifecycle messages. The specific Pin-refusal and
exact numeric-validation messages are accepted only in the retained-draft phase;
numeric validation alone cannot satisfy the Pin-refusal oracle. The synthetic
offline test DOM and authored oracles establish source validity, not actual
renderer/native acceptance.

Immediate unpin catch-up and frozen-context restoration are deliberate Zorid UX
improvements. Reference pin findings are static and do not establish corresponding
runtime behavior or exact menu placement. Generic main-pane pinning, arbitrary
crashes, mobile and external same-path source replacement remain outside this
campaign. The separate strict 32-row sidebar-race campaign still owns actual
accepted-write overlap; this campaign neither modifies nor substitutes for it.

Run the bounded author checks with:

```sh
node --test --test-concurrency=1 tests/bases-electron-sidebar-pin-integration/protocol.test.mjs
```
