# Native clipboard and input ownership campaign

Status: **authored; no app or native clipboard execution has been performed**.
This supplements the composed heavy journey; it does not reinterpret synthetic
ClipboardEvent coverage as system clipboard evidence.

Run through the coordinator's frozen frontend/native artifact and serialized
runtime slot. The wrapper never builds:

```sh
node tests/bases-electron-clipboard-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-native-clipboard-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

The optional campaign-module runner seam must be integrated first. Fixture files
are entirely campaign-owned, including Properties.yaml; no real vault is used.
The normal production renderer receives hit-tested pointer input and trusted
Chromium editing commands through Input.dispatchKeyEvent. The campaign never
constructs a ClipboardEvent, calls a product controller, or installs clipboard
contents through an OS write helper. AppKit writes are used only to restore the
clipboard captured before the campaign.

| Requirement | Authored route and oracle | Actual evidence needed |
| --- | --- | --- |
| Table copy | Copy editing command; independent pbpaste exact TSV assertion | Real macOS clipboard change and expected bytes |
| Custom MIME | Read-only trusted paste listener; generated obsidian/bases-cells typed values | Browser paste types/data and durable numeric values; no fallback if absent |
| Offset/mixed/clipped paste | Native paste command into ordinary cells; independent note frontmatter checks | Correct distinct source columns, offset placement, read-only skipping, clipping |
| List append | Native plain text copied from a real metadata input | Preserved raw wiki alias plus appended scalar |
| Row/column/range selection | Actual keyboard selection and OS copy | Exact TSV for row, column, current group and rectangle |
| Resize/automatic width | Actual pointer movement; real separator double-click | Durable width delta and removal of custom width |
| Row height | View setting through normal UI | Durable setting and rendered fourfold height |
| Input undo/Escape | Browser native undo command within the focused input | Local draft changes; durable note and Bases history remain intact |
| Composition | Input.imeSetComposition and trusted keyboard events | Trusted Chromium composition events and no premature durable write |

Custom format persistence is conditional on actual Chromium/Electron/macOS
behavior. macOS may hold web custom formats inside an org.chromium.web-custom-data
representation. The campaign requires delivered generated MIME data and records
its known fixture contents; it does not label an advertised OS format alone as a
successful round trip. pbpaste independently verifies plain text only.

Clipboard preservation snapshots every materialized pasteboard item's type/data
bytes privately in memory and restores/verifies those bytes in finally. Prior
contents never enter argv, evidence, screenshots, action logs, error messages or
files. Unavailable promised representations, malformed snapshots and a 64 MiB
preservation limit stop before clipboard mutation. Only an acknowledged fixture
clipboard may be returned by readPlainText. A restoration failure fails the run;
there is no claim of survival through forced process termination or machine loss.
Both this campaign and the configuration/export campaign reuse clipboard.mjs and
must run serially under the root coordinator's runtime grant.

Offline helper tests inject a fake pasteboard transport and touch no native app or
clipboard:

```sh
node --test tests/bases-electron-clipboard-integration/clipboard.test.mjs
```

Passing syntax, fixture parsing or those preservation tests establishes harness
readiness only. IME protocol coverage establishes Chromium composition ownership;
it does not establish a physical keyboard, Cocoa input-source or mobile IME pass.
