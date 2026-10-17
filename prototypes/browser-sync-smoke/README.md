# Actual browser runtime + relay smoke

Source-only until built and run. This tiny page uses BrowserCoreRuntime and its
actual dedicated worker, admission, IndexedDB, Rust/WASM and HTTP sync. It does
not seed state or call storage internals. The existing direct-IDB fixture is separate.

Build fresh WASM from this exact candidate first. Then, with repository dependencies
available, run from the candidate root:

```sh
ZORID_CORE_WASM_DIR="$PWD/prototypes/core-wasm/pkg" ZORID_CORE_BUILD_ID="$(git rev-parse HEAD)" node node_modules/webpack/bin/webpack.js --config prototypes/browser-sync-smoke/webpack.config.cjs
python3 -m http.server 8767 --bind 127.0.0.1 --directory prototypes/browser-sync-smoke/dist
```

Launch the disposable relay example with exact origin `http://127.0.0.1:8767`.
Open that origin, select its private `account-a-web.json` locally, and click
Import and connect. Never serve the fixture credentials directory over HTTP.
Create a note and sync. Open independent peer (new IndexedDB and client ID),
import the same disposable vault credentials, sync and read the note. A peer may
use another account-A device credential. Make offline edits independently, sync
both repeatedly, and compare read content. Binary read shows SHA-256 and size.
An account-B credential imports a separate vault and must not reveal account-A
content. The URI retains database/client identity across reload, with no secrets;
credentials must be explicitly reimported. For the same database in a second tab,
change only its client query parameter; duplicate client IDs correctly fail admission.

Controls expose explicit actions rather than automatic background sync. The
settled-intent button acknowledges outcomes recovered by worker startup; it does
not authorize prepared-only commands. Saves prepare the full family command,
commit and acknowledge its exact receipt. This is not the editor NoteBuffer
checkpoint acceptance workflow. For text-vs-binary mode, use a fresh path when
changing kind. File uploads are bounded to 512 KiB for this smoke. Fixture databases
are retained for reload evidence and are not automatically deleted.
