# Supported web workspace 002 — 2026-10-22

The fresh `002-retry` run passed all five authored phases through the normal
web application: create/rename, keyboard editing and durable save, document
reload, rich Search, and opening the matching result. This is a supported-host
workspace smoke test with matching Rust/WASM assets. It does not establish
complete Bases UI, expression-oracle, production-bundle, or mobile acceptance.

## Frozen source and artifact identity

| Item | Observed identity |
| --- | --- |
| Application source | `099d94edbbfbee7e79160872d1a62bb55e7601a5` |
| `crates` tree | `958b19aca4666414e956fbb2f406558af5a18366` |
| WASM build fingerprint | `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b` |
| wasm-bindgen | `0.2.129` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37` |
| Chrome executable SHA-256 | `2346fb044448ef1e7aef6593a19c0d258b194694e37c214f0bbd39e68e5ea881` |
| Private harness SHA-256 | `433e806b189e271808001324eb78443d38ea3915a3139039cb70507e06218d34` |

The retained matching build is
`/private/tmp/zorid-bases-final-wasm-958b19ac/receipt.json`. Its build-end
application commit is `e58c4429296d267b6957de505c677e1c6220eb43`; its Rust tree,
fingerprint and generated JS/WASM hashes match the run. These application commits
are distinct; their matching Rust/artifact identities establish the asset link.

The harness loaded the actual root [Vite configuration](../../vite.config.mjs),
asserted fixture mode was disabled, and reused the verified warm generated
assets. It exercised normal [platform selection](../../src/platform/index.ts),
[default browser vault](../../src/platform/browser-default.ts), and
[Worker runtime](../../src/platform/browser-core-runtime.ts), using the normal
IndexedDB database `zorid-core-vault:default-v1`. No fixture adapter or injected
editor/controller mutation was used. The report's module asset path is
`lib/core/f280f0c87632a7989f2f843ed668170ff9f3cbc6a17fcfb73f00e5e8d2c7cf92/zorid_wasm.js`;
that asset-path token is separate from the build fingerprint above.

## Actual retry observations

Run directory: `/private/tmp/zorid-bases-web-ui-actual-20261022-002-retry`.
The report records `2026-10-22T11:57:44.643Z` through
`2026-10-22T11:57:58.775Z`, headless Chrome `156.0.8078.47`, disposable profile
`chrome-profile`, owned PID `38277`, and origin `http://127.0.0.1:51839`.
The short elapsed time is descriptive and is not a performance result.

| Completed phase | Retained oracle |
| --- | --- |
| `normal-create-and-title-rename` | `Untitled.md` became `Functional browser note.md`, retaining entry ID `9349fe2b-0f77-40ad-927d-9352f749d946`. |
| `normal-keyboard-edit-and-durable-save` | CDP keyboard insertion after normal title-Enter focus transfer; independent read-only IndexedDB inspection found the exact 51-byte source below and revision `52680560-9301-4a41-a21b-e4b64eab9eb0`. |
| `normal-pagehide-reopen-exact-source` | Page reload committed a different document time origin; source, entry ID and revision remained exactly equal. No internal release API was injected. |
| `normal-rich-search` | Query `ZoridFunctionalUiMarker7c42` returned `1 match in 1 file`, the exact entry/path, badge `1`, and the marked matching snippet. |
| `normal-result-open-exact-editor` | Opening that result produced the exact title and editor text in a connected editor. The final editor was not focused; this phase does not prove focus restoration. |

The durable text was `Ordinary browser note.\nZoridFunctionalUiMarker7c42\n`
(literal newlines, including the trailing newline). The storage oracle opened
the existing database read-only and rejected accidental database creation.
Passive input observations recorded trusted browser input and the same connected,
focused CodeMirror instance before/after body insertion; the harness did not
force body focus or dispatch editor state changes directly.

The target inventory contained a Worker, with an empty reported URL. Source
selection and the module-path receipt identify the intended Worker/WASM route;
the empty target URL does not independently identify its loaded module. There
were zero `Runtime.exceptionThrown` events. Two favicon 404 log entries and
Chrome allocator/display-link stderr diagnostics remain recorded; this is not
an assertion of an empty error log.

## Retained evidence and independent verification

The following SHA-256 values were recomputed from retained files without
rerunning the application or a build:

| File, relative to the retry directory | SHA-256 |
| --- | --- |
| `report.json` | `256df1ee94d1a8a9635fc99db877c9b218694c127e341b919468e6af9e487758` |
| `post-run-integrity.json` | `ce40282e2d4049ebf355b8dadee68c5c449b62f2ca891c53a7f77f955e45daa8` |
| `saved-note.png` | `6779b9da46f0f56f305d067df2e802e66347e9563106c7257ffe48a67d03a145` |
| `rich-search.png` | `7998f5a77bec4e79271b7cc8b06d9cc634d8ed03f82a46a64c3489b1b71e40b3` |
| `reopened-note.png` | `7998f5a77bec4e79271b7cc8b06d9cc634d8ed03f82a46a64c3489b1b71e40b3` |

The last two screenshots are byte-identical: both show the search result and
already-open matching note. Distinct phase completion comes from the DOM/source
oracles, rather than an inference from two different screenshots. The images
were inspected as supporting captures, without a reference-parity judgment.

All **794** report source hashes were independently compared against frozen
`099d94ed` Git blobs. The two preserved generated assets, Chrome executable and
harness hashes were recomputed. Read-only hashing of the **433** WASM build
input files reproduced fingerprint `36809d02…`. The report's pre/post proof was
unchanged, and the integrity receipt agrees on the phases, exact source and
cleanup. Read-only verification details are retained at
`/private/tmp/zorid-web-002-doc-independent-verification.json`.

The integrity receipt records runner terminal exit `0` and normal Vite closure.
The report records normal `Browser.close`, child exit `0`, and null signal for
owned Chrome PID `38277`; no termination fallback was needed. A later cache
retirement receipt,
`/private/tmp/zorid-bases-web002-retry-cache-retirement-20261022-001.json`
(SHA-256 `36e828d811e80c2b01b7aa77a69f9c96fa7756fed36bce41b05254b2720bacd0`),
records that PID absent and no exact-profile argv matches. It retired **700**
reproducible cache files while preserving the same **271** protected non-cache
files and manifest digest before/after. Thus the profile/IndexedDB evidence is
retained, but the entire original cache tree is not immutable.

## Separate initial attempt and scope limits

`/private/tmp/zorid-bases-web-ui-actual-20261022-002/report.json`
(SHA-256 `9ad952a13d8fed0683942ff981da313a345d9889e98921c937a72117489e421b`)
preserves the initial `listen EPERM: operation not permitted 127.0.0.1` failure.
It completed **zero phases**, before Chrome launch, and has no Chrome PID or
cleanup entry. This environment failure remains separate from the fresh retry.

The passing retry covers one small ordinary note and Search on development
transforms. It does not run the 19-group Bases expression campaign or Bases
widget interactions, hosted login/sync, production-bundle loading, cross-browser
behavior, stress/cancellation races, native OS focus/IME, attachments, Electron,
mobile, or matched Obsidian visual acceptance. Those gates remain separate.
