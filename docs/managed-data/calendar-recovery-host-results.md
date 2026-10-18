# Calendar recovery host results

Owner: `CalendarRecoveryHostOwner`, terminal `term_1971e20d-92e6-4ead-a57b-4c12707bd302`, dispatch `ctx_246625d6ba54`.
Worktree/branch: `managed-calendar-recovery-host`. Source grant: root `msg71417235e5fa` as relayed in the dispatch.
Source and tests frozen at `e3e291422c1ad696b3128d0a0e723b71ca60ecbe`; root alone integrates main.

## Scope and behavior

Only `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/client-slots.cjs`, the new `tests/calendar-recovery-host.test.cjs`, and this report changed. No Workspace, editor, core, database, dependency, journal, or generic framework changes.

The exact optional bridge API is `reopenCalendarRecovery({originalWindowId:string, expectedVaultId:string}): Promise<{id:string}>`. Workspace owner `term_cfb3a85a-3ce0-4ebc-bbd9-9af0ec1937be` owns its optional interface/UI. `expectedVaultId` means the admitted durable checkpoint `scope.vaultId`, which desktop admission verifies against the host `local_store_id`; it is not a renderer-supplied filesystem path.

The IPC wrapper authenticates the live allowed main frame. The handler pins the caller's broker record, canonical vault service/root, generation, persisted registry settlement, admitted local store, admission ID and client ID, and checks them across lookup, canonicalization, claim, selection and load waits. Pending close/selection or changed caller admission rejects recovery. It also rejects any broker record with the requested identity, including a destroyed-but-still-registered record, and relies on the existing claimed slot fence after broker removal until native retirement and durable release finish.

Trusted main-only `listExisting()` enumerates persisted slot snapshots. Recovery selects the existing same-canonical-vault row. Its serial `claim` requires `existingOnly:true` and the exact observed client ID/vault path, so a stale snapshot cannot claim a changed slot. Missing primary is rejected instead of allocating a primary identity. Broker ID `main` maps to registry slot `primary` and passes `primary:true` to the existing window constructor; secondaries retain their original slot/window IDs. The registry continues to operate under the application's existing Electron single-instance lock.

The window uses the original slot/client identity and `initialState:'restore'`. Recovery errors do not fall through to an empty/new primary scope. Constructor or pre-registration failure releases only the acquired slot with restore eligibility retained. After registration, the existing closed-window path removes the broker record, drains native ownership and only then releases the slot; failed or pending retirement remains fenced. Neither this route nor the preload reads, copies, rewrites, moves, acknowledges or resumes a Calendar journal. Renderer inspection and explicit resume remain separate actions.

## Bounded validation

Commands run successfully against the frozen source:

```sh
node --check desktop/main.cjs
node --check desktop/client-slots.cjs
node --check desktop/preload.cjs
node --test --test-concurrency=1 tests/calendar-recovery-host.test.cjs tests/desktop-main.test.cjs tests/client-slots.test.cjs tests/window-broker.test.cjs
git diff --check
```

Result: **32/32 Node tests passed**, including 16 new focused tests. New cases cover authenticated frames, wrong local store/canonical vault, missing slots, primary alias rejection, missing-primary no-allocation, stale slot snapshots, live/retiring owners, concurrent recovery, exact primary/secondary client identities, caller generation/admission/page/closure changes, a change after the actual claim, a change during renderer load, constructor/open/load failures, retained retirement fences, and exact preload forwarding.

The tests execute the actual main handler, `WindowBroker` and filesystem-backed registry. Electron windows and editor-core admission/retirement are controlled test seams. The unchanged-byte checks use a retained fixture file and establish that this host route does not touch it; they do **not** establish real Calendar journal persistence, Rust admission, renderer behavior or native Electron acceptance.

## Dependencies and remaining gates

Independent reviewer `term_b64f6f01-b577-46c5-88fe-da33d69d953f` received the exact source/test freeze. Review acceptance was not available when this report was written. The Workspace owner received the API, and composed proof owner `term_21f2c133-0287-4822-8245-684c6762e270` received the freeze and remaining proof requirements.

No app, browser, simulator, Rust compiler, bundle build or install ran for this slice. Later composed normal Electron proof must show the actual original window storage scope and unchanged actual Calendar journal reopening, then separate explicit inspection/resume behavior. Source/unit success does not claim integrated, native, browser or mobile parity. Main integration remains root-owned after independent review and affected composition validation.
