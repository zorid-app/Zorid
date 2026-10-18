# Stage 5 device enrollment: source inventory

Source checkpoint: main0e9c1174, audited 2026-10-18. Read-only source evidence,
not runtime acceptance or a frozen cryptographic design. Vite migration is
already delivered; user-prioritized Tasks/Bases/Calendar and native navigation
continue under their existing owners before this product enrollment work.

## Existing substrate and product gaps

| Area | Existing source | Missing product behavior |
| --- | --- | --- |
| Authorization | `crates/zorid-sync-server/src/lib.rs` has operator account/vault/membership/device provision and revoke methods; `rpc.rs:194` explicitly excludes public provisioning | Authenticated account/device setup, expiring one-use invitation redemption and management UI |
| Key access | `crates/zorid-crypto/src/lib.rs` has VaultKey; `src/recovery.rs` context-bound recovery bundles | Trusted-device transfer, normal recovery unlock and protected persistent credentials; recovery secret is not an invitation |
| Native transport | `crates/zorid-native-sync/src/lib.rs` implements bounded fixture sync; credentials module reads protected external JSON and requires loopback | Hosted configuration/HTTPS and normal long-lived credential service |
| Browser transport | Browser runtime/worker fixture configuration freezes key capability and checks scope/epoch | Normal configuration and persistent protected session/key custody |
| Enrollment | `crates/zorid-store/src/family_store.rs:425` and browser streaming sync require unbound empty storage or exact same-scope retry | Explicit existing-authority import/rebind |
| Bootstrap | Relay bounded log pages support a through watermark; clients atomically retain receive/cursor state | Durable setup phases/watermark, dependency completion, isolated staging and reconciliation before ordinary scanning |
| UI/CLI | Fixture enroll/status/once and ordinary local vault flows exist | Settings Sync/Add device, QR/code entry, progress/reconciliation summary and product join command |

The central constraint is verified directly in normal startup:
`crates/zorid-desktop-host/src/lib.rs:867` assigns local_<store>/vault_<store>
before reconciliation; `src/platform/browser-core-worker.ts:84` does equivalent
local enrollment. Thus even an empty-looking normal vault can already be bound.
Do not weaken scope-mismatch checks or wrap fixture enrollment in Settings and
claim joining is implemented.

## Next implementation boundary

1. Keep server authorization, key access and local reconciliation distinct.
   Bind results to explicit server origin, realm, vault and key epoch. Reuse
   established reviewed key-transfer primitives; this inventory selects no new
   crypto protocol and does not expose reusable keys in invitations.
2. Persist a JoinSession with destination identity, protected secret references,
   remote context, phase, fixed bootstrap watermark/cursor and reconciliation
   plan identity. Restart/cancel must preserve original local data.
3. Fetch/authenticate into a separate remote-scope store and staging directory.
   Existing receive may project there, never directly into a populated target.
   Snapshot completion, dependency readiness, materialization and upload success
   are separate states; scanning cannot infer remote deletes during bootstrap.
4. Treat an existing local authority as an explicit import source. Capture a
   recoverable snapshot, retain local-only files and both same-path differing
   versions, and reuse causal identity only when established. No mtime winner or
   silent scope replacement. Keep current rejection until this plan can commit.
5. Activate everyday sync after reconciliation publication. Retain existing
   exact-ciphertext retry, journal and atomic cursor invariants. Add QR/code UI
   over the proven service, rather than treating the UI as the service itself.

Acceptance must cover empty and populated targets, interruption/restart,
wrong/expired/replayed invitation, server/vault/key mismatch, missing dependencies,
offline tombstones, failed initial upload and revocation with actual clients.
Detailed service/API ownership is still to be assigned; no implementation or
runtime enrollment completion follows from this inventory.
