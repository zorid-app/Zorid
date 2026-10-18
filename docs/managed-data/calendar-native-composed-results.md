# Native Calendar composed verification

Owner: CalendarNativeJoinOwner, task `task_602b8d1f04ea`, dispatch
`ctx_7f887a555eed`; coordinator terminal `term_62fd2871-cfd3-4810-b01d-5fb39845fce2`.
This report is owned in the original `managed-calendar-native-join` worktree.
The assembly is read/test-only; no source, HEAD or documentation mutation there
is authorized for this worker.

## Frozen candidate and provenance

Assembly: `/Users/ctk/orca/workspaces/Zorid/managed-task-calendar-integration`.
Initial HEAD: `dfd1545b7e7b381e21ba5cd270cccbdded7e648a`; clean status observed.
Coordinator composition includes frozen Store `3882acec`, portable `e60718df`,
native production `a0ac46ab` / fixture correction `ae989104` / report `8ba38850`,
and binding `c4c` / `849` / report `37b` as dispatched.

Persistent evidence directory:
`/Users/ctk/orca/artifacts/zorid-calendar-native-20261018/task602b8d1f04ea`.
`source-initial.json` records the exact assembly HEAD/status and SHA-256 of
Cargo.lock, native Calendar code and fixtures, host library/stdio code, strict
codec and actual host integration harness. `run-check.py` captures each permitted
command, environment, PID, start/end UTC and exit code into adjacent JSON/logs.
No command has run at preparation time.

## Exact bounded sequence

Each Cargo command uses the existing shared official toolchain directory
`/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin`:
explicit `RUSTC`, `RUSTDOC`, and its `cargo`. Existing shared target is
`/Users/ctk/Projects/Zorid/target/stage4-verified`, `CARGO_INCREMENTAL=0`, jobs1,
offline/locked and test threads1. No warning suppression, installation, dependency
change, new target, full suite or graphical application is planned.

1. `cargo test --offline --locked -j1 -p zorid-native --test calendar -- --test-threads=1`
   (nine real native/SQLite fixtures). Notify coordinator immediately on terminal
   outcome to release scheduling for actual browser work.
2. `cargo test --offline --locked -j1 -p zorid-desktop-host --lib calendar_ -- --test-threads=1`
   selects `documents::clock_tests::calendar_command_is_read_only_and_never_accepts_authority_or_duplicate_fields`
   and `documents::clock_tests::closed_calendar_pin_lookup_never_manufactures_a_session_or_pin`.
   These live in the host library; `--bin` would not establish their execution.
3. Only after a separate explicit build grant:
   `cargo build --offline --locked -j1 -p zorid-desktop-host --bin zorid-desktop-host`.
   Copy matching executable into the persistent evidence directory, record source,
   binary SHA-256 and toolchain, then use that copy rather than old native `62c6`.
4. `ZORID_DESKTOP_HOST_BIN=<persistent matching executable> node --test --test-concurrency=1 tests/desktop-calendar-host.integration.cjs`
   against the same assembly. This proves admitted stdio/native composition,
   original Base selection, labels, WorkBlock membership and lifecycle fences;
   it does not prove rendered Electron UI, mobile or browser behavior.

Compiler execution remains held until the coordinator's explicit readiness after
the iOS20 compiler terminal checkpoint. Concrete failures must be retained. Any
native source fix belongs only in the original owned native worktree and must
freeze/review before coordinator integration/retry; binding/root fixes require
named scope first. No check result or acceptance is asserted by this preparation.

Scheduling correction `msg_818b9631ddf1`: iOS20 reservation explicitly released
without a build; corrected browser actual pass runs first with a bounded 180-second
limit. Native remains held until its cleanup terminal and a fresh explicit grant.
The five owned native source files and native fixture in the assembly byte-match
original reviewed `8ba38850`; `toolchain-sha256.json` records cargo/rustc/rustdoc
executable hashes without invoking a compiler.

## First permitted execution and retained failure

Grant `msg_f78ccecca7ca` readmitted only native Calendar and the two host library
checks after actual browser cleanup. Native Cargo PID `52892`, UTC
`2026-10-18T04:41:23.810214+00:00`–`04:41:46.793665+00:00`, exited **101** at exact
clean assembly `dfd1545b`: `E0282`, `tests/calendar.rs:454`, month fixture
`let mut watermark = None` requires an explicit `Option<Value>` before `w.clone()`.
**No native fixtures ran.** Native production library compiled, with warnings
retained verbatim (including unused Calendar import); no warning suppression.
Evidence: `native-calendar.log` / `native-calendar.json`.

Authorized original-worktree fixture fix `03df2996` changes only that annotation;
no production, expectations, budget or diagnostics changes. Formatter/diff checks
pass; source reviewer and coordinator received the frozen one-line successor.
Assembly remains untouched by this worker; retry requires reviewed coordinator
integration and explicit readmission. Already-granted host library check started
as Cargo PID `55407` at `04:42:00.772765+00:00` on unchanged assembly; result pending.

Host library check PID `55407` ended `2026-10-18T04:42:31.255154+00:00`, exit **0**:
the two named Calendar tests passed, 30 other tests filtered out. Evidence:
`host-calendar-unit.log` / `host-calendar-unit.json`. The immediate coordinator
message mistakenly said 10 filtered; the raw test log and this report record the
actual 30. This establishes scoped DTO/read-only/closed-pin unit behavior only;
no built stdio binary or actual composed host success is claimed yet.

Independent review `msg_759225f2107a` approved exact fixture fix
`03df2996329a375e9af20b12b9deb6bfac8edc43` for coordinator cherry-pick/focused retry:
production unchanged, no budget or expectation weakening. Coordinator owns that
assembly mutation and readmission; worker has not retried at this checkpoint.

## First runtime attempt: explicit bounded interruption

Grant `msg_ff975811872c` readmitted native nine only at clean assembly
`b01f52d1b5ff530f400c2329444aa582b1e2c21f`, sole reviewed fixture annotation delta.
Cargo PID `66805` started `04:44:27.164799+00:00`; test child `67340` compiled in
4.23 seconds, passed the first four named cases, then spent over three minutes in
the 1,001-file setup. Read-only observations of that child's disposable SQLite
fixture showed 95 entries at `04:46:06`, 115 at `04:47:04`, and 129 at stop; the
expected finished manifest is 1,004 entries. CPU was about 97%, RSS about 16 MiB.
This is measured fixture construction cost, not product performance evidence.

Coordinator `msg_24b430626c28` explicitly authorized a controlled stop and a
semantically equivalent fixture-only setup. Verified child `67340` had parent
`66805` and the exact approved test argv. Only the child received SIGTERM at
`2026-10-18T04:47:54.939393+00:00`; Cargo naturally returned 101 at
`04:47:54.968915+00:00`. Both PIDs were confirmed absent. This attempt is
**interrupted/incomplete**, not a full nine-test pass or behavioral failure.
The later four tests had not run. Evidence: `native-calendar-retry1.log/json`,
`native-calendar-retry1-interrupt.json`; no original logs were overwritten.
The exact disposable interrupted fixture was removed afterward, recorded in
`native-calendar-retry1-cleanup.json`; no applications or other processes were stopped.

Coordinator `msg_90d3598bcb68` granted only the native test file optimization;
browser3 takes the next heavy turn, so no compiler retry is permitted yet.
Frozen test-only `c649382e` batches the same 1,001 validated public Store Text
commands into the same enrolled SQLite after dropping NativeVault/session/lease,
then reopens NativeVault and runs normal recovery once. It asserts the 1,004-entry
manifest and every one of the 1,001 actual file bodies plus Base bytes before the
unchanged same-pin Types/Base/selection-before-cap assertions. Public opener
correction `d02e3df5` uses `Store::open_existing_no_follow`; neither commit changes
production or weakens cardinality, identity, context or budget assertions.
Independent composition review is required on that exact pair before integration.

## Optimized runtime attempt: seven pass, two fixture failures

Approved optimized fixture source was composed by the coordinator at clean
`737e66ac8fb005a45441de4ddbcd22f4097b1dc6`; explicit retry grant
`msg_8ebd3f4438e6`. Cargo PID `92146`, UTC `04:50:49.513683+00:00`–
`04:51:41.511394+00:00`, exit **101**; compile 4.04 seconds, tests 46.98 seconds.
`native-calendar-retry2.log/json` preserve **7 passed / 2 failed**. Passed:
all-time/deleted membership, bounds/replaced lease, continuation/change/close,
eight slots, expanded reply budget, original-ID/source labels, split-month windows.

The 1,001-file fixture failed at Store open before authoring: SQLite CannotOpen
1550 on macOS's `/var/folders` alias. The existing no-follow opener correctly
rejects that alias; native Paths canonicalizes its root first. Receipt-only fixture
failed `Payload::from_intent` with Codec before authenticated receive: its JSON
Value serializer sorted object keys while `State::decode` requires canonical typed
intent field order. Neither failure reached the intended Calendar assertion.

Fixture-only `748c0df3` canonicalizes the physical root while retaining no-follow,
and serializes a typed `{format, scope, operations}` intent matching the working
Store fixture. It leaves IDs, operations, future schema version, authenticated
receive, 1,001 cardinality and all Calendar assertions unchanged. Source review,
coordinator integration and explicit retry remain required; no binary build yet.

## Corrected targeted receipt result and remaining cap setup

Coordinator `msg_0cb8db71cd3a` readmitted only the two changed cases at clean
`ad0209e7e38e75d5a5d8b4cc3f707f7b3706e367`; no repetition of unchanged seven.
Cap Cargo `9451` / child `9682` again measured impractical per-file Store authoring:
129 entries after 2m43s. Under explicit `msg_c6b582c3a49a`, verified parent/argv,
SIGTERM only child at `04:57:47.340913+00:00`; Cargo naturally returned 101 at
`04:57:47.369179+00:00`, both PIDs absent, fixture removed. Evidence:
`calendar-cap-retry3.log/json`, `calendar-cap-retry3-interrupt.json`,
`calendar-cap-retry3-cleanup.json`. This remains interrupted/incomplete.

Receipt-only Cargo `20782` ran the exact filtered case at the same source,
`04:57:47.545262+00:00`–`04:57:48.781018+00:00`, exit **0**, 1 passed / 8 filtered,
0.70-second test time. Both authenticated waiting and future-schema receipt
fixtures reached real native task/window DTO assertions and passed with zero
accepted SQLite records. Evidence: `calendar-receipt-retry3.log/json`.
Native coverage is **seven earlier passes plus one corrected pass**, not a single
nine-pass run. The large-cap case remains open. Coordinator delegated read-only
public-batch setup investigation to a separate worker; this worker is not adding
a production API or duplicating that audit.

## Matching binaries and first actual stdio gate

Explicit build/gate grant `msg_c26e52c4d9d9`: clean assembly
`4bb0f368ff70236b409dce7011e5758544816dc2`, incorporating independently reviewed
receipt helper/harness `288b8a59`. Source hashes in `source-build.json` include
helper `b36b94ca691640afa6e30cd1b1085d8298d85ffbf0d5c1758ae19180187ab0c2` and
harness `b91c06f24b673c28d51663cb89efba998a2e2d1defffc797cdee419fb017c15a`.

- Host build Cargo `26084`: `04:58:46.876452`–`04:58:53.387139` UTC, exit **0**.
  Persistent `zorid-desktop-host-4bb0f368`, 48,500,976 bytes, SHA-256
  `2e6d51c5ebaf7367af15bb216bdc6fb3a441dd08f21ac316492e00ad05aebff0`.
- Fixture `--no-run --message-format=json` Cargo `28245`:
  `04:59:20.842250`–`04:59:23.826081` UTC, exit **0**. Selected the exact Cargo
  compiler-artifact executable (no wildcard/timestamp guess), copied as
  `calendar-receipt-fixture-4bb0f368`, 14,961,520 bytes, SHA-256
  `b813552c0998a7fb7c4fd9d3738ffe46f4fbe7f81088213668450259af9a929f`.

Build receipts/logs: `host-build.*`, `receipt-helper-build.*`, `host-binary.json`,
`fixture-binary.json`; original/copy hashes verified equal. Both executables are
in the persistent evidence directory, never old `62c6`.

Actual gate command uses both executable environment paths and
`node --require <evidence>/trace-calendar.cjs --test --test-concurrency=1 tests/desktop-calendar-host.integration.cjs`.
The artifact-only passive observer forwards identical documentCommand arguments,
results and errors, logging settled Calendar DTOs after normal decoding; no product
or assembly source mutation. This adds logging cost, so no performance claim.
Observer source and exact command are preserved with the evidence.

Node `31246`, `04:59:59.230174`–`05:00:02.094201` UTC, exited **1**: genuine
receipt-only waiting **pass**, genuine incompatible-schema **pass**, positive
composition **fail**. Positive fixture's Create used `generation: block-gen` with
`operation: create-block`; domain Create requires operation identity equal to
generation, producing explicit `invalid_workblock` before positive join assertions.
This is an identified harness fixture issue, not an established production bug.
No retry or unowned fix was made; named binding source follow-up requested.

Raw `actual-calendar-dtos.jsonl` contains 14 actual native-read frames: two absent
task memberships, four unknown task memberships (both withoutBlocks values for
both receipt kinds), and two terminal window results with incomplete membership.
`actual-host.log/json`, `actual-host-summary.json` and `actual-host-cleanup.json`
preserve assertions, observed PIDs and cleanup. Test/helper/host processes
`31248`, `31261`, `31350`, `31380`, `31393`, `31395` all confirmed absent; all three
observed disposable vault paths removed. No GUI application was launched.

## Corrected positive stdio result and bounded foundation

Reviewed binding fixture `61473d75` changes only Create operation to `block-gen`.
Explicit retry grant `msg_d26e16bf35b0` permitted the failed positive case only;
coordinator assembly clean HEAD `72982397597a1e80f217d3286534d9cf48559745`.
Before execution, all Rust/lock/helper file hashes were verified identical to
`4bb0f368` build provenance, and corrected harness hash verified
`3f426daf04f460e976be40362994bb56646bd9ddee3689a114029446245f4dca`.
No rebuild, repeated receipt tests or assembly edits occurred.

Filtered actual positive command (with the same passive DTO observer) ran Node
`44040`, UTC `05:03:07.097593+00:00`–`05:03:08.741549+00:00`, exit **0**,
**1 passed**, 1.29-second case time. Native host `44056` and Node worker `44054`
were observed, then confirmed absent; disposable vault removed. After execution,
assembly HEAD remained the same and clean. Evidence:
`source-positive-retry1.json`, `actual-host-positive-retry1.log/json`,
`actual-host-positive-retry1-dtos.jsonl`, `actual-host-positive-retry1-summary.json`,
`actual-host-positive-retry1-cleanup.json`, `source-after-positive.json`.
Raw positive DTO frames contain four absent memberships, one present witness, two
returned block pages, and saved Base selectedFiles=1 / selectedTasks=1 with the
actual definition revision. Links, consumed/replaced cursor, closed pin and retired
client assertions pass. Runtime versions are in `toolchain-versions.json`; both
persistent binary hashes were reverified after execution.

| Evidence | Observed result | Limit |
| --- | --- | --- |
| Native Calendar fixtures | Seven passes at `737e66ac` plus corrected receipt-only pass at `ad0209e7`, production unchanged | Eight distinct cases; **not 9/9**; native 1,001-file case interrupted/incomplete |
| Scoped host library | Two Calendar tests pass at `dfd1545b` | Unit DTO/read-only/pin lookup behavior |
| Actual admitted stdio | Waiting/future receipt cases pass at `4bb0f368`; corrected positive case passes at `72982397` with identical Rust binary | **Two plus one across recorded runs**, not one clean three-pass campaign |
| Binaries | Matched host `2e6d51c5…`, fixture `b813552c…`, build receipts exit0 and persistent copies verified | No GUI or mobile runtime proof |
| Cleanup | Every observed owned test/helper/host process absent, disposable vaults removed, assembly untouched by worker | Persistent proof binaries/logs intentionally retained |

The genuine >1,000-note native counterexample is retained without weakening,
but its per-file validated Text setup is impractical in this bounded turn. The
independent source audit in `calendar-large-fixture-setup.md` found no existing
safe faster public batch Text installer; no new production API, raw SQL authority
or fake generation was introduced. Portable large-selection execution and native's
exact delegation/small real stdio composition may support a separately reviewed
bounded foundation decision; they **do not complete the native 1,001-file runtime
gate**. Independent reviewer/coordinator own that acceptance decision.

These results establish the observed SQLite/native/admitted stdio slice only.
Rendered Electron Calendar/Base UI, mobile/browser Calendar delivery, remote
completeness and full Tasks/Calendar product completion are not asserted. The
matched native binary and evidence were handed to the UI owner; final GUI launch
authorization remains with the coordinator.
