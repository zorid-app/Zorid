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

### Concrete pre-fix reproduction (proof-only followup)

Followup owner: same worker, task `task_8e5723bfdbe1`. Frozen implementation
`9f2f29623aabba8d4850e8377c070de54c809553` remained unchanged. Copied the
standalone `zorid-records` crate and repository Cargo.lock to
`/tmp/zorid-schema-registration-baseline-9etwnx0n/zorid-records`, then replaced
only its `src/admission.rs` with:

```sh
git show 9b9f6479:crates/zorid-records/src/admission.rs
```

The baseline commit is `9b9f64793819ba4dc31ae64515d599d1fa7e2179` and its
admission blob is `957890df6b885e381a52469b55c075883c7c518d`. All other scratch
Rust files were byte-compared against the frozen checkout; the regression test
blob is `028619fd3796fb1d0116379f084b2661a596bbc1`. No helper was reimplemented.
Neither source nor Git state in the frozen branch was changed for this run.

Exact bounded offline command:

```sh
cargo test --offline --manifest-path /tmp/zorid-schema-registration-baseline-9etwnx0n/zorid-records/Cargo.toml --test schema_registration required_additions_fail_without_any_records_or_preexisting_fields -j1 -- --exact --nocapture
```

Observed exit **101**, with **0 passed, 1 failed, 9 filtered out**:

```text
thread 'required_additions_fail_without_any_records_or_preexisting_fields' (...) panicked at tests/schema_registration.rs:136:9:
assertion `left == right` failed
  left: Ok(true)
 right: Err(InvalidSchema)
test required_additions_fail_without_any_records_or_preexisting_fields ... FAILED
```

The test's first case adds a required String field with no default to a v1
registration with no fields, bumping to v2; it supplies no records. Schema
validity passes, but baseline registration incorrectly permits this required
addition. The assertion stops this baseline run at that first case; defaulted
required scalar and required Set are covered by the fixed passing regression,
not claimed as separately executed baseline cases. Full raw output is retained
at `/tmp/zorid-schema-registration-baseline-9etwnx0n/required-addition-baseline.log`.

### Fixed implementation

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
