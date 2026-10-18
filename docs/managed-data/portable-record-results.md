# Portable record library validation

Date: 2026-10-17 America/Toronto. Exact tested candidate:
`1842c15e99129531baf189af2f15ad3e1bba77a1`, clean isolated
`tingkai-c/managed-data-foundation`.

**33/33 passed**: 24 source-owner traces plus 9 independently authored
adversarial tests. No source or lock changes/retries were needed during validation.

```sh
RUSTC=/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc \
RUSTDOC=/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustdoc \
CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified \
/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test \
  --offline --locked -j1 -p zorid-records --tests -- --test-threads=1
```

Exclusive root grant `msg_68f3021742d8`; session17018 exited0.
Log: `/private/tmp/zorid-records-1842c15e-tests.log`. Compile9.95s;
adversarial1.27s, traces1.43s. These are fixture timings, not measured product
performance budgets. Slot returned explicitly in `msg_0676fb3dce42`; native team
retains next simulator-build priority. No broader suite was run.

Independent contract review and independent actual source review both completed.
Root `msg_a8f809191242` approves the exact portable library slice; this does not
approve production persistence, wire framing or full product acceptance.

Observed behavior includes per-field concurrent candidates and retained losers,
causal resolution without history loss, null/unset distinction, atomic objects,
causal add-tag authorization and observed-remove/add-wins sets, generation
isolation, pending activation and snapshots, rollback for malformed/cyclic/
equivocating/incompatible batches, additive unknown-field preservation, exact
replay and stale schema/policy/history plans, canonical decoder ambiguity
rejection, history/byte/field/parent/tag limits and compact ordinal ancestry.
The 256-operation chain regression crosses bitset words with reverse lexical IDs,
pending tail, deep tag removal and concurrent field conflicts.

The ancestry matrix uses at most 2 MiB of raw words under current limits, plus
explicit ordinal/edge/pending/projection bookkeeping. README describes work
bounds. This is not a general untrusted-input allocation sandbox: direct
programmatic union can clone input operations before the aggregate snapshot
cap; callers must apply a batch memory budget. Wire receive bounds bytes before
decoding. Root explicitly retained this limitation in its scoped approval.

Still required before full Phase1 acceptance: approved single representation and
adapter contracts; durable native/browser record+projection+change+authored-intent
commit; exact ciphertext sealing/retry; authenticated incoming state/receipt plus
shared cursor transaction; local/cache exclusion; subscriptions/catch-up;
quarantine/liveness for invalid pending descendants; capacity recovery; actual
cross-client encrypted delivery and crash/restart. Native/desktop UI, Google,
secrets/jobs/migrations, spaced repetition and public plugin delivery remain
later explicit stages. This library result completes none of those gates.
