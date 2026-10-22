# Native SELECT diagnostic campaign

Source-authored, actual run pending. This is a bounded platform/input probe, not
full heavy-user, Q3, normal OS foreground, or native-menu acceptance.

The normal Electron runner supplies a fresh disposable vault, exact source and
artifact fingerprints, all admitted campaign-source fingerprints, a 1 GiB free
space gate, actual visible owned-window checks, first-failure diagnostics and
exact app/native cleanup. It never builds or selects artifacts implicitly.
Launch only after the coordinator grants a matching frozen association/slot:

```sh
node tests/bases-electron-native-select-integration/run.mjs \
  --root ABSOLUTE_FROZEN_ROOT --expected-head FULL_HEAD \
  --native ABSOLUTE_MATCHED_HOST --electron ABSOLUTE_ELECTRON \
  --out /private/tmp/NEW_NATIVE_SELECT_EVIDENCE \
  --ready bases-native-and-frontend-frozen
```

One book and a Base open the ordinary production property settings panel. The
fixture reproduces the same three topics/options and fourth Research row as
heavy016. The unchanged native-select recipe is click → Home → eight ArrowDown
→ Enter, followed by the original exact `purple` readback. Passive
`native-select-frame` actions record value/index/selected options, focus,
disabled/inert, document visibility/focus and `:open` when supported before/after
each input, and on final readback success/failure. These are DOM reads only;
there is no value assignment, event injection, semantic wait, retry or keyboard
recipe change. The added CDP round trips can affect timing, so a changed outcome
alone does not identify the failure mechanism.

DOM state and Chromium screenshots do not establish native macOS popup state or
OS keyboard forwarding. Preserve unknowns explicitly. A successful readback must
still pass the real Apply and independent durable registry oracle; Base and note
bytes remain exact. A failing readback stops before Apply and follows the normal
failure cleanup path. No partial run establishes the full heavy-user journey.

## Optional owned CUA takeover

Add `--cua-native-select-checkpoint` only for this minimal probe. It requires the
shown-window mode and is rejected for the default heavy journey or other
campaigns. The default CDP keyboard sequence remains unchanged when absent.

After the ordinary click has opened the enabled SELECT, the runner prints
`CUA_NATIVE_SELECT_READY` and writes `native-select-cua/ready.json` beneath the
fresh evidence directory. The receipt binds a fresh nonce to the owned Electron
PID, executable, command/profile, freshly observed window IDs and passive SELECT
state. It rejects another main process at the same executable and requires one
currently visible owned native window; the fresh observation does not activate
the app. It waits
at most five minutes. The coordinator verifies that exact live app/window in CUA
and uses native `Home`, eight `ArrowDown`, then `Enter`. No CGEvent/osascript
input bridge, JavaScript value assignment, or synthetic DOM input is used.

After completing native input, the coordinator writes only the advertised
`{"token":"EXACT_READY_NONCE","action":"continue"}` object to the receipt's
private `continueFile`. This signals control flow; it supplies no selected value
or product data. Unknown fields, stale nonces, symlinks, changed ready metadata,
an exited owned process, or timeout fail the run. The normal runner records the
post-input DOM frame and still requires exact `purple`, real Apply, durable
registry and unchanged-note/Base oracles. Continuing cannot satisfy those checks.
If native CUA is unavailable, let the bounded probe fail; there is no automatic
fallback to another input channel. This mode alone does not establish the full
heavy journey, hardware keyboard parity, or a product fix.
