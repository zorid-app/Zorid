# Captured text creation receipt proof

These explicit integration targets exercise ordinary admitted creation commands
through the normal desktop/browser adapters and `Vault.createOperation`. They do
not compile Rust or establish Bases UI, mobile, or complete platform parity.

Coordinate the native/browser runtime slot, then run against existing artifacts:

```sh
ZORID_DESKTOP_HOST_BIN=/absolute/path/zorid-desktop-host \
ZORID_CREATE_RECEIPT_EVIDENCE=/private/tmp/native-create-receipts.json \
node --test tests/text-create-receipts/native.integration.ts

node tests/text-create-receipts/browser.run.mjs --runtime-authorized \
  --wasm-dir /absolute/path/existing-generated-wasm \
  --out /private/tmp/browser-create-receipts
```

The native target uses one owned backend and disposable vault. The browser target
uses one owned headless Chrome profile, loopback server, unchanged product worker,
actual Rust/WASM, and disposable IndexedDB. Both record relevant source/artifact
hashes and cleanup. Loss injection occurs only after the real consumer returns a
committed receipt; storage semantics are never replaced by a fake provider.

Scenarios cover exact command replay without another content mutation, original
receipt identity versus a same-path replacement, an advanced original revision
after failed publication, and persisted browser receipt recovery after a new
worker admission. The lightweight neighboring `*.test.*` files separately cover
malformed receipt rejection and retain the legacy safe-unavailable behavior.
