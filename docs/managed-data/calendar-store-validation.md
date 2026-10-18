# Calendar Store validation receipt

Coordinator-owned actual validation, 2026-10-18 04:35 UTC. Exact source
`3882acec3c28aef4c9175d63a81ed9649c96890f` in isolated
`managed-calendar-store-evidence`; no source edits during or after this pass.
The original source author's report correctly records its earlier unrun status;
this separate receipt records the later coordinator check.

Command used existing official stable cargo/rustc/rustdoc under
`/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin`,
`CARGO_BUILD_JOBS=1`, `CARGO_INCREMENTAL=0`,
`CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified`:

```sh
cargo test --offline --locked -p zorid-store --test calendar_evidence -- --test-threads=1
```

Unified exec session4263 returned **exit0**. Real SQLite tests: **5 passed,
0 failed,0 ignored,0 filtered**; build16.29s, tests0.25s. The log contains10
Store warnings; no broad warning cleanup or additional suite was run.

Decisive cases include receipt-only waiting/incompatible records before accepted
state under a stable fence, mixed accepted/unresolved records, continuation
row/byte limits and sticky unknown, settlement/explicit refresh, and wrong
scope/auth/registration/reopen fences. This proves the scoped Store evidence
API, not a native join, UI, browser/mobile or remote completeness claim.

Persistent raw log:
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/calendar-store-3882acec.log`

SHA256: `da520036576e624d309603f0905bc4989d0fb965bd0c3e8338c6c24f61f61dfc`.

Independent Calendar reviewer ctx_3227884a4148 was assigned exact log/source
review. No compiler remains; the bounded turn was explicitly returned to native
lead for the next paired iOS20 build. Root alone integrates confirmed changes.
