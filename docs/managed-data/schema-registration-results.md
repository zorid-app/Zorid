# Narrow schema registration guard results

Owner: dispatched guard worker `term_40bdb33e-d699-4321-a575-0c3eb2269244`,
task `task_c3f9a9b2fa21`, 2026-10-17 (verification UTC 2026-10-18).
Worktree: `/Users/ctk/orca/workspaces/Zorid/managed-schema-registration-guard`.
Branch: `tingkai-c/managed-schema-registration-guard`, based on canonical main
`9b9f6479`. Dependency: reviewed proposal `26962033` in the isolated
`managed-schema-evolution-contract` worktree, narrow followup A only.
Coordinator retains sole main integration; H owns worker host files separately.

## Change

`registration_change` now uses existing `Schema::validate` and private
`Id::validate` on both inputs before comparing even exact repetitions. It rejects
realm/vault/owner/collection identity changes with `Scope`. Valid exact repetitions
still return `false`; valid higher-version optional additions and version-only
bumps return `true`. Existing policy and complete Field declarations remain
immutable, removal/same-version divergence/downgrade remain rejected, and all
new required fields (including valid defaulted scalars and Set declarations) fail
even without records or old fields.

No public helper, schema/wire shape, migration callbacks, lineage or receipt
version widening was introduced. `received_gate` remains exact version equality.

## Verification

Final command (offline, serialized `-j1`, exit 0):

```sh
cargo test --offline -p zorid-records --test schema_registration --test admission -j1
```

- New `schema_registration` target: 10 passed, 0 failed.
- Existing `admission` target: 6 passed, 0 failed.
- `git diff --check`: passed.
- Only the new test file was run through rustfmt; existing source style preserved.

Tests exercise all identity components and policy conversions, existing field
removal/kind/required/nullability/default changes, downgrade and same-version
fork, required additions from empty schemas, supported optional types/defaults,
invalid old/next/repeated declarations and serde-decoded invalid IDs. History
fixtures prove original snapshot/operations remain unchanged on reopen with an
optional default; only new authored Create materializes that default; explicit
null/unset and patch/reopen do not reapply it. Set remove tags, tombstones and
generation identity survive unchanged. Another fixture demonstrates that a valid
optional declaration can conflict with a previously unknown typed history field:
host accepted-state revalidation must still reject that candidate. Old-version
received intent remains incompatible after a higher registration.

Initial focused run: existing admission 6 passed, new target 8 passed/1 failed.
Failure was a test assumption that intrinsic empty Set had a projection entry;
current projection omits untouched/empty membership. Corrected the assertion to
check the absent entry, added retained set-removal/tombstone coverage, then ran
the final 16 passing checks above. No runtime production change was made for it.

## Adapter call-path inspection and limits

Native `Store::managed_register` in `crates/zorid-store/src/managed_records.rs`
validates new schema/scope, preserves byte-identical repeat revision, calls
`admission::registration_change` for replacements, and restores every accepted
state before its transaction updates registration/revision. Collection-key lookup
already binds realm/vault/owner/collection. WASM `validateRecordsRegistration` in
`crates/zorid-wasm/src/records.rs` parses and validates registrations then delegates
old/next replacement checking to the same helper; `validateRecordsAccepted`
restores accepted history separately. No unowned adapter edits were needed.

This is portable focused evidence and source inspection only. Native SQLite,
actual generated WASM/IDB, normal worker, desktop/CLI/mobile runtime, registration
rollback/handle fencing and cross-client behavior were not executed in this task.
Mixed-version receipt admission and migration lineage remain unsupported and
unapproved. No full suite, full workspace build or native/mobile build was run.
