# Actual native acknowledgement interruption campaign

This test-only campaign uses the normal Electron application, its normal bridge,
and the exact matched `zorid-desktop-host` binary. A regular executable relay is
selected through the existing trusted host-executable setting. It forwards every
request and unselected reply byte unchanged. It never substitutes a result,
acknowledgement, row set, capability or native error.

The coordinator must freeze matching source/frontend/native artifacts and grant
the runtime slot. The common runner's reviewed relay/process-tree seam is required.
The campaign never builds or runs independently selected artifacts.

```sh
node tests/bases-electron-recovery-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-recovery-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

| Scenario | Interruption and independent oracle |
| --- | --- |
| Accepted A, newer B, close | Arm exact saved Base entry/path and exact A bytes. Observe its real prepared token and committed native receipt, hold only that successful reply, type B through the mounted summary editor and request tab close. The panel retains B while disk contains A. Release the same encoded reply; exactly one A and one B write finish. Close safely, quit normally and verify exact B after restart. |
| Lost New reply, restart | Arm the exact destination and complete template digest. Suppress the first genuine successful create reply, gracefully stop that real host before presenting EOF, and observe mounted New uncertainty/close refusal. Repeated New cannot create a second note through the fenced transport. A separately labeled forced app shutdown and restart recovers the durable requested checkpoint. The native replay must have the same command/body, operation ID, entry ID, revision and receipt sequence; only one file with exact template bytes exists. |

The relay consumes the fault before restart. A 15 second hold watchdog records
failure and releases the **same genuine frame**, below the production 30 second
transport timeout. Watchdog expiry, malformed framing or unowned/leaked processes
fail acceptance. Request/response hashes, native operation/receipt identities,
relay and native artifact hashes and exact process-tree cleanup are retained.

These scenarios do **not** establish arbitrary disk failure, power-loss safety or
successful same-mounted retry after native host death. `RustVaultService` fences
the failed transport until app restart. Holding an accepted write is distinct
from a failed-save retry. A newer draft blocked behind a native call is not
claimed crash-durable before its checkpoint can run.

Pure protocol checks require no application or native executable:

```sh
node --test tests/bases-electron-recovery-integration/protocol.test.mjs
```

Those checks verify framing, arming, native-success selection and the watchdog;
they are not actual native campaign results. Authoring or passing helper checks
does not complete either runtime acceptance gate.
