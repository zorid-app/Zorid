# Independent mobile slice source review

Reviewed 2026-10-17 by terminal `term_d8099777-52ff-4714-b421-8197fb0df6ad`
in isolated worktree `mobile-slice-review`, branch `tingkai-c/mobile-slice-review`.
Owner: `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`.
Candidate: `tingkai-c/native-mobile-recovery` at `b84a9096965904b7513d26e8798eb5b430a52cbb`.
Comparison: local `main` at `74b3f2f9e51b5ed6764e7b26f1be192e04f65931`.

Source inspection only: no builds, tests, simulator, application launch, signing,
or runtime parity claim. Read AGENTS.md, roadmap execution checkpoint, native
integration record and relevant findings. Only this report is owned/changed.
Owner retains validation and coordinator retains sole main integration.

## Findings

### P2 — Mobile release always violates host admission

`src/platform/mobile-native.ts:132` attaches the active lease to every request.
Both `release()` at lines 440–453 and admission cleanup at line 166 submit
`release_client` through that function. However,
`crates/zorid-desktop-host/src/lib.rs:363–371` explicitly rejects a
`ReleaseClient` carrying an envelope lease with `client_operation_unsupported`.
The release reference belongs in the command, with no envelope lease, as required
by the existing host protocol.

Therefore every ordinary admitted mobile release fails before removing its
kernel lease. `release()` also leaves `closing=true` after that rejection, so
ordinary operations subsequently fail `storage_closed`. A failure after initial
claim (for example authority validation) silently fails cleanup and retains the
slot in the still-open native host, obstructing a retry. Successful native switch
ACK closes the entire host directly and avoids this particular path.

The mock in `tests/mobile-native.test.ts:29–36` requires a lease on every method
except claim and returns success for release, so it encodes the opposite contract
and cannot detect this integration failure. Fix the adapter envelope and make the
focused mock/host boundary assert actual admission behavior; preserve release
retry semantics. No change to desktop admission policy is needed.

### P2 — Platform selection disables the existing Android startup path

`src/platform/index.ts:111–113` selects `openNativeMobileVault()` for every
Capacitor native platform. `src/platform/mobile-native.ts:54–55` rejects if
`NativeVault` is unavailable. This candidate registers that plugin only in
`ios/App/App/NativeMobile.swift`; the Android tree has no NativeVault registration
or implementation. Thus the existing Android app now fails startup with
`native_plugin_unavailable` instead of opening its prior MobileAdapter.

Gate this iOS-only slice by the supported platform and retain the existing
Android route until Android has an admitted binding. This does not require
implementing Android now or treating its cfg enablement as runtime support.

### P2 — Mobile transport discards the host's explicit uncertain outcome

`src/platform/mobile-native.ts:142–144` converts an error envelope into
`commitUncertain=true` only when its code is literally `outcome_unknown`, ignoring
`error.commit_uncertain`. The actual host emits `commit_uncertain:true` for
`checkpoint_storage` (`lib.rs:376–387`) and storage/filesystem/sync failures
(`lib.rs:169–171`). For example, a checkpoint CAS whose durable outcome is unknown
is exposed to mobile consumers as a certain failure. Desktop transport preserves
this exact field (`desktop/rust-vault-service.cjs:326–330`).

Validate the boolean and preserve it in the mobile error. Current namespace
terminal-code filtering does retain these storage failures, so this review does
not assert a demonstrated duplicate mutation or lost draft; the defect is the
incorrect exposed durability contract and misleading recovery classification.

## Known pending gates, not newly discovered findings

- Native must bind `claim_client` to the selected vault's persisted canonical
  client ID. Swift currently validates only JSON shape at
  `NativeMobile.swift:199,232–235`, while EmbeddedHost accepts any valid unleased
  claim. A caller can claim another slot and address that slot's checkpoints and
  intents using the resulting lease. This is the explicitly reported pending
  identity-boundary fix; UUID case normalization alone does not fix it.
- Adapter reconciliation/status and refresh consumption are assigned to another
  active worker. At this SHA the Swift shell exposes validated startup/refresh
  status, but the web context type/returned PlatformVault omit it. Do not mark
  incomplete inventory visible based only on the Swift methods.
- Compiler override scripts are assigned elsewhere. The reported 82 MiB simulator
  staticlib and owner-run host subprocess tests are outside this review's evidence.

## Source conclusions and remaining validation

The main-host comparison shows framing, execute/admission functions and stdio
loop retained through the library extraction; the executable now calls
`run_stdio()`. The embedded-only deny list blocks unleased trusted apply,
reconcile/recover/rescan and fixture mutations. Exact frame exhaustion is checked
before dispatch. C ABI request errors/panics take/drop the host, releasing its
leases; owned boxed-slice buffers match buffer_free and Swift copies response
bytes before freeing. Swift serializes open/request/refresh/free/close globally,
queued work retains its session, and close clears its pointer before deinit.
No additional concrete P1/P2 memory/lifetime defect was identified by inspection.

The private catalog constrains UUID roots, rejects symlink roots and invalid
persisted consumer identities, normalizes UUID case and persists identities
before core open. Safe-area sides/top, keyboard guide bottom and keyboard resize
configuration have one intended UIKit layout owner. Their actual behavior,
keyboard focus/selection, rotation, process death and durable catalog behavior
still require native execution.

Workspace lifecycle handling at `workspace.ts:211–236` quiesces editing, flushes
and saves the session before awaiting ACK; its finally restores prior inert and
closing values on rejected ACK or background completion. Native rejects an
inactive switch, cancels deadlines, and owns successful switch close/pop. This
addresses the earlier source-level ACK restoration concern; it does not establish
suspension timing or OS-expiry behavior in a running app.

Durable text writes retain plan/ref boundaries; namespace commands persist their
exact planned commands before execution and advance progress through checkpoint
CAS, replaying stored IDs rather than replanning on restart. None of that source
inspection establishes integrated recoverability until the admission/error
findings and known gates are reconciled and the owner validates the resulting SHA.
Desktop/browser selection precedes or bypasses the native-only branch, CLI source
is unchanged, and root manifests/locks are unchanged. No new desktop/browser/CLI
contract regression was identified in this scoped comparison; affected subprocess
validation remains owner-run. Stage4 fixture/doc differences in the direct main
comparison were outside this mobile boundary review.
