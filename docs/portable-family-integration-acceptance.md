# Portable family and recovery integration

Candidate `a72e13c`, following verified namespace candidate `8ba5c55`, combines
reviewed recovery `7a54d70`/`89fe9f6`, transport codec `d6c525f`, text-v2
`6d9459e`/`dbf802d`, and the exact `zorid-file-sync` subtree from `20c0b0e`.
The file crate had not previously been on main; its original v1 graph tests and
v2 tests were included. No existing package version/source pins changed; the
lock adds the new workspace crate and dependencies already pinned elsewhere.

Serialized macOS arm64 verification (Homebrew Rust1.99):

```sh
CARGO_TARGET_DIR=/Users/ctk/orca/workspaces/Zorid/core-native-sync-integration/target cargo test --offline -p zorid-sync-protocol -p zorid-client-sync -p zorid-file-sync -p zorid-cli -p zorid-crypto -j1 -- --test-threads=1
```

Session60597 exited0: **108 tests passed**, including documentation tests.
Log: `/private/tmp/zorid-family-recovery-a72e13c.log`. This includes actual
loopback relay/independent CLI sync and known-note clean-client recovery on the
current native namespace schema. See `recovery-key-bundle.md` for earlier
no-default-features tests and exact recovery limitations. The external recovery
secret is separate from backend backup; original client storage is removed.

Text/file-v2 planners are portable components, not yet a wired native/browser
family store. Full namespace reconstruction from backup, binary large-file
streaming, actual Electron/browser encrypted convergence, production enrollment
and editor checkpoint integration remain incomplete. Tests do not establish a
security audit or native/mobile parity. No deployment or real vault migration.
