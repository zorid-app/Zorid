# Supplemental actual Electron Bases configuration campaign

Source-only campaign authored in `codex/bases-config-e2e`, initially based on
`992ac56a`. **No app, build, native clipboard operation or runtime acceptance has
been performed by this authoring batch.** The launcher owns exact source/artifact
provenance, disposable vault/profile creation, process isolation and cleanup.

The first actual run stopped at the initial twelve-row assertion while only 718
export files and no record files had entered the durable namespace. The emitted
fixtures independently parse correctly. Initial readiness now retains the first
Base rowcount/status and screenshot, then observes the normal read-only
`window.zorid.list(vault)` inventory until every one of the 1,023 fixture file paths
is present. It samples every second, reports progress every ten seconds and fails
after 180 seconds. It does not trigger rescanning, importing, indexing or queries.
The Base remains open throughout, so the unchanged twelve-row assertion still
requires normal admission notifications to refresh the visible result. Physical
scan completion and internally complete partial metadata generations are not
substitutes for fixture admission. This precondition has no performance claim.

Run only after the coordinator integrates this campaign, the optional campaign
launcher seam, the shared private clipboard guard and the standalone Base source
editor, builds matching artifacts, freezes the checkout and grants the serialized
runtime slot. The campaign never builds or silently skips unavailable controls.

```sh
node tests/bases-electron-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-config-UNIQUE \
  --ready bases-native-and-frontend-frozen \
  --campaign-module /absolute/harness/tests/bases-electron-config-integration/campaign.mjs
```

| Required workflow | Positive UI action | Independent assertion |
| --- | --- | --- |
| Nested All views / This view filters | Real visual property/condition and AND/OR/NOT controls | Exact saved group tree and five known record paths |
| Multiple sort criteria and priority | Real dropdowns and Alt+ArrowUp | Both exact saved orders and different independently calculated tie-break order |
| Property label, visibility and order | Configure property, Hide all, checkbox selection, actual Tab and Alt+ArrowDown | Root label, explicit saved order and visible table columns |
| Manual groups | Manual, show/hide one/all, automatic reset | Exact saved visibility list, displayed column/card membership and extension preservation |
| Live drag preview and cancellation | Native Chromium dragstart, pointer preview, Escape | Actual preview exists then disappears, no configuration or note mutation |
| Invalid formula and cycle recovery | CodeMirror edits through pointer/keys | Visible syntax diagnosis, authored cycle retained, runtime cycle cell, corrected numeric value |
| Invalid standalone `.base` | Production recovery Edit source, normal CodeMirror and Mod+S, Return to Base | Invalid YAML itself saves without losing source editor; repaired bytes render twelve records |
| Unknown renderer and fields | Configure view → Table | Unknown root/view fields and author comment survive; normal rows recover |
| Invalid fenced Base | Edit Base source and normal Markdown editor | Exact repaired Markdown and rendered inline record count |
| 1,005-row supported exports | Results → Copy and Export CSV | Private real OS TSV readback and actual isolated CSV download match every row/field/order |
| Normal process restart | Normal quit then fresh launch | Persisted nested filters and sort reproduce exact known rows |

All positive mutations use hit-tested production pointer input and keyboard
input. DOM evaluation locates or observes controls only. Prelaunch fixture writes
are explicitly fixture setup, not user-creation coverage. Malformed standalone
and fenced files are labeled negative fixtures, with repair performed through
ordinary editing UI. Note bytes are checked exactly after configuration and
preview actions. No application controller, query evaluator or mutation service
is called by the campaign.

The clipboard guard captures all original pasteboard items/types in private
memory/subprocess pipes, acknowledges only exact fixture output before exposing
plain text, and restores the original bytes in `finally`, including failure.
Prior clipboard contents never appear in arguments, artifacts or logs. Root must
serialize this campaign with the separate clipboard campaign. A native restore
failure fails acceptance. CSV uses a Chromium test download directory; native
Save-dialog behavior is outside this proof.

The 1,005 rows are a bounded functional completeness fixture, with no latency,
memory, large-vault or performance acceptance claim. Markdown/paths serializers
remain covered by their existing focused tests. They have no normal product
UI/CLI entrypoint and this campaign does not invent one or claim UI acceptance.
Runtime input is CDP against the real Electron renderer; it does not establish
OS foreground keyboard parity, mobile parity or arbitrary crash/power-loss
recovery. Every unexecuted scenario remains unverified until retained runtime
evidence reports it passed.

Offline authoring checks:

```sh
node --test tests/bases-electron-config-integration/oracles.test.mjs
node --test tests/bases-electron-config-integration/admission.test.mjs
node --check tests/bases-electron-config-integration/campaign.mjs
node --check tests/bases-electron-config-integration/controls.mjs
```
