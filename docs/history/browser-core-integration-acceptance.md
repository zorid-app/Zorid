# Browser core foundation integration acceptance

Tested app candidate `8eb89de1f9ba3279cbd41f23968259dc612c451a`, 2026-10-16,
macOS arm64, Node26.10.0, Chrome155. Source reviewed independently in owner
worktrees: browser provider/types528848f+fac086f+07fc5fb, Vault129b638, and earlier
adapter/runtime/fixture selection/asset hooks. Current main was merged before
combined execution. Only an existing dependency symlink was untracked.

## Executed application checks

```
node --test --test-concurrency=1 tests/core-vault-durable.test.ts
node --test --test-concurrency=2 tests/*.test.*
node /Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc --noEmit
node /Users/ctk/Projects/Zorid/node_modules/webpack/bin/webpack.js --mode production
```

Combined session8828 exited0. Nine focused durable Vault checks passed; full
suite2005/2005 passed in63.311s. Typecheck passed with no diagnostics. Ordinary
webpack passed in5.973s with three performance warnings. Filesystem assertions
confirmed ordinary output contains neither lib/core artifacts nor fixture marker.
Logs: `/private/tmp/zorid-vault-durable-focused.log`,
`/private/tmp/zorid-web-integrated-tests.log`,
`/private/tmp/zorid-web-integrated-types.log`, and
`/private/tmp/zorid-web-ordinary-build.log`.

Explicit fixture build (session53137 exit0,1.667s,no warnings):

```
ZORID_CORE_FIXTURES=1 ZORID_CORE_BUILD_ID=8eb89de1f9ba3279cbd41f23968259dc612c451a ZORID_CORE_WASM_DIR=/Users/ctk/Projects/Zorid/.worktrees/core-sync-foundation/prototypes/core-wasm/pkg node /Users/ctk/Projects/Zorid/node_modules/webpack/bin/webpack.js --mode development --output-path /private/tmp/zorid-webfixture-8eb89de
```

Manifest build ID, emitted byte sizes and SHA256 hashes were verified against
freshly rebuilt87f9ef6 WASM artifacts. JS SHA256
`888c4dcb5005ae1d7b5c3f7b0ce934ecd067d8212e2273b93ee460068110437c`;
WASM SHA256 `b34f2999fce980450c91c2e4a7bb492bd3440cb5bc04aee35814eede51b08836`.
Fixture build log: `/private/tmp/zorid-web-fixture-build.log`.

## Actual browser observations

The host fixture passed all27 groups and the WASM fixture all6 groups in actual
Chrome. Exact source/artifact hashes, observed check names and scope are recorded
in `prototypes/core-browser/validation/chrome-checkpoints-2026-10-16.json`;
preceding build evidence is `checkpoint-build-2026-10-16.json`.

The actual application then ran from the separate fixture build over loopback
port8767. Synthetic vault UUID3269fae9-e04a-4823-ab47-dbe9102ae3fa was opened in
two tabs with distinct client UUIDs11b96fab-6f84-430a-a9ac-59e16991a4ad and
f832647e-03a7-4c46-ae6b-e23f6440a6d3. The visible vault label was Core fixture;
DOM fixture meta marker equaled tested build8eb89de. Server requests confirmed
production browser worker chunk and lib/core JS/WASM URLs loaded successfully.

Using the actual UI, created Untitled.md, typed and saved
`Core fixture local persistence check.`. Reloading the first tab preserved the
text; opening the note in the second independently initialized client displayed
the exact same text. This proves a bounded ordinary adapter save/read/reload path,
not the new durable consumer handshake or simultaneous competing edits.

Both owned app tabs1268037345/1268037348 closed; server68615 exited0. Earlier
host/WASM tabs also closed and server44909 exited0. Synthetic browser databases
remain; no ordinary browser vault or real user files were migrated.

## Integration and remaining gates

This reviewed foundation is approved for main with ordinary selection unchanged.
The optional durable capability remains unselected by the fixture constructor
until its editor consumer and client admission gates pass. No remote transport
was used in the application observation. Actual durable-save crash recovery,
concurrent dirty-tab arbitration, editor IME/undo behavior, desktop/CLI sharing,
binary/namespace sync and encrypted client restoration remain required.

Vault advanced/missing receipt observations preserve conflicts but do not yet
perform coherent stable-ID namespace cache reconciliation. Do not interpret the
passing focused tests as completion of that follow-up.
