# Calendar original-window recovery host integration

2026-10-18 05:01 UTC. Root isolated calendar-recovery-integration, base main
a9eb9f5c. Originals e3e29142/28049671 become isolated67ea6c8e/31bcad2f.
All desktop files and the new recovery test exactly match e3e29142. Prior main
had zero differences from its desktop source base, so no semantic conflict or
source adaptation was needed. Source reviewed independently by Calendar reviewer
in calendar-join-implementation-review.md at originala36c0e9d, scoped verdict
msg_a2334305bedf. Remaining composed UI gates in that report stay open.

Root ran the bounded32 affected Node tests once in this current-main composition:

```sh
node --test --test-concurrency=1 tests/calendar-recovery-host.test.cjs tests/desktop-main.test.cjs tests/client-slots.test.cjs tests/window-broker.test.cjs
```

Observed terminal session37628 exit0,32/32 pass, no skips/failures,1.56s.
Persistent raw log: `/Users/ctk/orca/artifacts/zorid-native-20261018/calendar-recovery-integration-tests.log`.
SHA256: 1ce8a20987d7d30e47f2bca85d48e5dfa0ba4a621a31af89336cf8124abcd9bf.
The three changed CJS files also pass node --check; scoped diff-check is clean.
No compiler, application, Rust, native window or full suite ran in this pass.

The authenticated host reclaims an existing original same-vault slot/client,
including main-to-primary mapping, checks actual durable store/admission across
awaits and refuses live or retiring owners. Missing slots do not allocate new
identities. It does not copy, rewrite or resume a Calendar journal. Existing
close/retirement fences remain authoritative after failures.

This is a host foundation. No Workspace recovery caller or Calendar activation
is added in this batch. Controlled host tests do not establish actual renderer
journal persistence, user-visible recovery or integrated Electron acceptance.
The composed proof owner must still show the real original storage key and
unchanged journal reopening, then separate explicit inspection/resume.
