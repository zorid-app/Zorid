# Nullable multi-select schema-update proposal

Status: proposed only. No Rust repository source was edited, no build or Rust test was run.

## Observed defect

The native page Tags option creation is rejected with destructive-confirmation error. In `crates/zorid-store/src/databases.rs:1237`, every same-type MultiSelect schema update turns a null/missing member value into an empty array through `as_array().cloned().unwrap_or_default()`. This runs for every previous field and every member, including updates that merely append an option to a different field. `cleared != value` then sets destructive and rejects an ordinary unconfirmed update. A frontend confirm flag would authorize a real null-to-array rewrite across hidden members; it is not a safe preservation fix.

## Proposed bounded remedy

Apply adjacent `nullable-multiselect-option.patch` to the same-type MultiSelect branch only. Filter removed option IDs when the current value is an array. Clone non-array values unchanged, including null. Existing preserved-value branch, datatype conversions, property removal, actual option removal, expected schema revision, operation idempotency, projection and confirmation gates remain untouched. No frontend confirm-destructive bypass or default initialization change.

Proof: before the patch, null becomes []; after, null stays null. Existing [] stays []. Existing [red, green] still filters only IDs missing from replacement options. Therefore real removal continues to make `cleared != value`, sets destructive and requires explicit confirmation. A missing map key retains the existing later default/null insertion behavior. Unpreserved invalid non-array data is preserved rather than silently normalized; valid storage already admits arrays or null for this type.

## Required regression tests before acceptance

Add focused tests to `crates/zorid-store/tests/databases.rs` using existing request/input/get helpers:

1. `additive_options_preserve_nullable_multiselect_shapes`: create Tags MultiSelect with Red and Choice Select with Blue; create three members with Tags null, [], and [redId]. In separate cases append Green to Tags or Choice with confirmDestructive false. Assert success, exact old field/option IDs/defaults, null/[]/[redId] unchanged, unrelated fields and exact member body bytes unchanged. The unchanged source must reject the append when the null member exists.
2. `multiselect_option_removal_still_requires_confirmation`: same schema with Red+Green and members null, [], [redId,greenId]. Remove Red with confirmDestructive false; assert rejection and no changed schema/values/body. Repeat with explicit true using an appropriate operation ID; assert selected values become [greenId], null stays null and [] stays []; IDs/defaults/unrelated content retained.
3. `unrelated_schema_rename_preserves_null_multiselect`: rename only the collection (no fields/options/default changes) with a null Tags member and confirmDestructive false. Assert success and null preserved. Keep the existing incompatible preserved-scalar regression green.

Validation after approval: serialized narrow store tests with jobs 1, scoped existing database semantics tests, then source-matched native host/CLI rebuild. Rerun actual native Tags Create Red then Green and grid Select creation, verify stored native IDs, null and array shape preservation, exact bodies, normal restart. Repackage and verify the new source-matched host before installation. Existing frontend/unit success does not establish this core fix.
