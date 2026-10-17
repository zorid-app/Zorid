# Normal browser Stage4 UI fixture helper

Verification-only page. Source is isolated from product code. It uses the normal
`BrowserCoreRuntime`, `admitBrowserClient`, `defaultBrowserAdapter` and
`DEFAULT_BROWSER_DATABASE`, with a fresh random consumer UUID and
`initializeLocal:true`. It does not access app globals, edit IndexedDB records,
reset a vault, delete files or overwrite existing source. Atomic create commands
reject a collision. Each seed creates its own `Stage4 proof <uuid8>` folder.

The folder contains `Number.md` (numeric status2/blue), `String.md` (quoted
status'2'/red and `[[Number]]`), and `All.base`. Its named Table, Board, List and
Cards views filter this folder's Markdown files, group status using `[2, '2']`,
and show file.name, status, color, a fixed date formula, file.links and
this.file.name. Board uses the existing `kanban` view type. No JavaScript query
or formula engine participates in seeding. The page reads every committed source
back through the normal runtime and checks exact UTF-8 bytes plus SHA-256. The
visible report records exact source/build provenance, paths, identities and
revisions. The admitted consumer and runtime are released after each attempt.
Partial failures preserve created source and report its paths; no cleanup delete
runs. Seeding is not proof that normal UI rendering or mutations pass.

Coordinator build, only with the coordinator's existing generated Rust artifacts:

```sh
ZORID_STAGE4_FIXTURE_SOURCE=<helper-commit> \
ZORID_STAGE4_FIXTURE_OUTPUT=/Users/ctk/Projects/Zorid/dist/stage4-fixture \
ZORID_CORE_WASM_DIR=/absolute/generated/wasm \
ZORID_CORE_BUILD_ID=<wasm-source-commit> \
node /Users/ctk/Projects/Zorid/node_modules/webpack/bin/webpack.js --config prototypes/browser-stage4-ui-fixture/webpack.config.cjs
```

Run from the composed source checkout (provide its dependencies as usual). The
output defaults to that checkout's `dist/stage4-fixture`; override it as shown to
place this helper under the normal app's served dist tree. The maintained
`CoreWasmAssetsPlugin` copies only its allowlisted content-addressed generated
assets and checks production exports. This config never builds Rust and never
cleans the surrounding app output.

Serve the normal app's dist directory and navigate to `/stage4-fixture/` on
**exactly the same origin**, including port, as the normal browser app. Click
**Seed Base and search proof**, retain the visible JSON, and return to `/` (the
normal app). Open the reported All.base path through the file tree. Verify its
four views keep numeric2 and string'2' separate, date2026-10-18, the String row's
Number link, context file name, and case-sensitive literal search using the
reported unique needle. Record edits/moves through the actual UI independently.
A different host or port uses a different IndexedDB authority and proves nothing
about the normal app vault. No relay credentials or test-only storage hooks are
required.
