# Native select probe003 and desktop builds002/003 — 2026-10-22

The actual visible Electron probe **failed after 45 recorded actions**, with one
completed window-visibility check. The native `Option color` select remained at
Default after the authored click/Home/eight Down/Enter recipe. The cause remains
unclassified between product behavior, automation and native input routing.
Fresh desktop builds002 and003 passed; build success does not establish native
interaction or reference parity.

## Probe source and retained evidence

Output: `/private/tmp/zorid-bases-native-select-current-20261022-003`.
The report records `2026-10-22T13:21:56.821Z` through
`2026-10-22T13:22:33.567Z`, frozen source
`ba37415b6eb9d84fe9b1db8dc24fa160b7866ea4`, Rust tree
`8074eabf01c55cf4e53f01c02a5a384197875a24`, and the build002 frontend.
The normal production property-settings panel was reached through
[the probe campaign](../../tests/bases-electron-native-select-integration/campaign.mjs),
using the ordinary [UI driver](../../tests/bases-electron-integration/ui.mjs).
The disposable vault contained one authored book, its Base and Properties.yaml.

| Retained item | SHA-256 |
| --- | --- |
| `result.json` | `2329e94fc10f865467ede43f03a0f25805224dcc6d1c1dce47072fb9c9ee6537` |
| `provenance-before.json` and `provenance-after.json`, identical | `69258d836a26e201ba2f9a174fdeef3d8835b3a458bb0870f2a1c2942a2fe051` |
| `native-select-before-input.png` | `4ecbd2d374f86856ed41cf907632041c9a10a41a33dff9d9eb09871c7fa9b1a3` |
| `failure.png` | `6067cd3e2664bbd9b68a26fdc8ba18bb8b8e15208a7885b4c94017b2c99ebf15` |
| Adjacent `/private/tmp/zorid-bases-native-select-current-20261022-003.log` | `c4d6776ee4a7d3a146a5dd7314198a3190e030c651603b99b680470d2a68e2fc` |

The preserved native host was
`/private/tmp/zorid-bases-final-native-8074eabf/zorid-desktop-host`, SHA-256
`6e04fb5fc5a44d7d49dad41c7f1852347a0dd763f141dac3992797f4d4f25359`.
Electron 44.8.0's executable SHA-256 was
`12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7`.
The probe campaign source SHA-256 was
`a1bc7163198986128d8212697a876ed302a9095da8f1cf36ba61c0e291b8d484`;
the UI driver source was
`8d34c65c0ccd27534767bbef3ba0305bad79b8233562d00a5cafb76a1859af4d`.
These source/artifact identities are retained in the provenance manifests.

## Exact failed interaction

The campaign opened `Library.base`, then Properties → Configure property topics
→ Property type. It added a fourth multiselect option and entered `Research` as
its stored value and label. The failure occurred selecting `purple` in that
row's native `SELECT[aria-label="Option color"]`.

The driver inspected the real option list, found enabled purple at index8, then
used CDP mouse input, Home, eight ArrowDown keys and Enter. It retained passive
frames before/after each key and required exact value readback. There was no
direct select-value assignment, synthetic change event, alternate recipe or
retry that could turn this failure into a pass.

Across all **23 native-select frames**, the selector matched one connected,
enabled, non-inert SELECT. Its value stayed empty and selectedIndex stayed0
(Default). After click through immediately after Enter, `document.activeElement`
was the select, `document.hasFocus()` was true and DOM `:open` was true. At the
failed readback about20 seconds later, activeElement was still the select,
but `document.hasFocus()` was false and `:open` was false. This establishes a
renderer-focus difference at readback, not when or why focus changed or where
the keys were routed.

The one completed check records a visible renderer and an onscreen window owned
by PID56476, with initial renderer focus. Native activation returned true but
the combined native unhide/activation acceptance was false. The report retains
those separate fields; it does not prove OS foreground or physical-keyboard
parity. DOM `:open` and Chromium screenshots cannot establish a macOS-owned
menu's state. Passive CDP frames themselves add round trips and may affect timing.

The failure message is `Native select accepted keyboard input`, from the exact
readback assertion. The post-readback screenshot, Apply, durable purple-definition
assertion, unchanged-note/Base assertions and normal-quit step were **unexecuted**.
The retained screenshots were inspected as diagnostic evidence, not as matched
reference or visual acceptance.

## Cleanup and source proof

The runner's failure cleanup records owned Electron PID56476 terminated by
**SIGKILL**, exitCode null, signal `SIGKILL`; the identified native child was
PID56606. Its final owned-process result is `leaked: []`. Normal graceful quit
did not pass. This is the retained runner ownership proof, not a new independent
historical process-list capture or a claim about unrelated applications.

The before/after provenance objects are exactly equal and the report marks
`provenanceVerified: true`. This documentation task independently matched all
**822** recorded tracked source hashes against frozen `ba37415b` Git blobs,
recomputed the host/Electron and evidence hashes, and confirmed the build002
receipt's **333** dist hashes equal the probe manifest. No app or test was rerun.

## Separate successful desktop builds

Both logs run `tsc --noEmit && vite build --mode native`, transform2361 modules
and end in successful Vite completion. They retain dynamic-import/chunk-size
warnings. These are frontend typecheck/native-bundle builds, not a rerun of Rust
compilation, the complete native workflow or reference comparisons.

| Build | Source association and retained proof |
| --- | --- |
| 002 | The passing receipt records build start `ac0f07461119447bd758121f7ec7aab1865161ea` plus the exact immutable group-alias fix later committed as `36b170d7`; receipt source `ba37415b6eb9d84fe9b1db8dc24fa160b7866ea4`, with subsequent changes identified as commit/docs bookkeeping. `/private/tmp/zorid-bases-date-c2-desktop-build-002-receipt.json` SHA-256 `96f75b5bf01597d6ffea82af1efe4d3e4f8b9c22692f7941f0fa10d13abcc048`; log SHA-256 `5c3815ad3d2310000faf90328b532f672ad4a997703db64fac6ffd3d9ce412ef`. This is the frontend used by the failed probe. |
| 003 | A later rebuild at `0d660bb1e15fcf989d37dab3cf52dbe2b65e4013`, same Rust8074 tree, records session22473 terminal exit0. `/private/tmp/zorid-bases-date-c2-desktop-build-003-receipt.json` SHA-256 `333613bc5bbf321f56f22b9a17dd11e1f381a1331160700566371613534e20fe`; log SHA-256 `49d3f03f07948a3a27f6a485b76bd1bb6b4e00c3a8b8c42cd7fda968567987f9`. Its333 dist hashes were independently recomputed from the current frozen files. This rebuild does not rerun or supersede probe003's failure. |

Each build log is adjacent to its receipt under `/private/tmp/`, named
`zorid-bases-date-c2-desktop-build-002.log` and `…-003.log` respectively. Both
receipt/log hash associations were independently checked. The frozen builds,
failed native-select interaction and other campaigns keep their own exact
acceptance boundaries. This history task changed only this record, with no
product/source edits, build or app launch.
