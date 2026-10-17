# Shared-core integration acceptance

## Batch 1 — 2026-10-16

Tested candidate: `3ac9e06927edacdf2148aea99f289d88246f227f`, reconciled
with main `c3ec15f`. The editor team prepared the ordered core batch, and the
shared-core coordinator accepted main ownership, fixed the reviewed late external
write recovery-status issue, and ran the final combined gate.

```
cargo test --offline -p zorid-core -p zorid-crdt -p zorid-store -p zorid-native -p zorid-cli -j1 -- --test-threads=1
```

Fresh target directory in the isolated Orca candidate; session 61703 exited 0.
76 tests passed: core26, CRDT4, native19, store17, CLI10 (nine real subprocess
checks and one redaction unit). Counts include the native/store subprocess harness
entries. Build completed in33.71s. No browser/Electron process was involved.

The change adds portable mutation contracts, a native SQLite vault authority,
recoverable regular-file projection/import, pinned text CRDT fixtures, and an
independently runnable CLI. Source reviews covered the portable planner, storage,
projection and CLI; the editor team's additional review found incomplete recovery
status for late writes to retained displaced inodes. Fix `d3f8719`, integrated as
`3ac9e06`, has native reopen and repeated real CLI regressions and independent review.

Existing editor, platform selection, desktop bridge and root JavaScript dependency
manifests are unchanged. This batch does not switch either app to Rust storage,
provide functioning sync, or migrate user vaults. Folder scanning/publication,
remote ingestion, backup restoration and real app integration are subsequent
batches. Native mode/metadata preservation and aggregate retained-history memory
remain explicit limits; this is not a hostile same-user filesystem sandbox.

Main integration may fast-forward only this tested candidate and this evidence
commit while main remains `c3ec15f`. No push or release is part of this acceptance.
