# Bases actual Electron campaign 016 — 2026-10-22

**Stopped on the first failure: 244 actions and 29 successful checks. Full
acceptance remains open.** The previous topics-picker stopping point is passed,
and the initial rich-property durable checks succeed. The next failure is the
native option-color SELECT's expected-value readback after keyboard input.
The final SELECT value and native-popup focus were not captured, so the cause
is not established as either product behavior or a platform input-recipe issue.

Executor: `bases_ui_review`. Actual interval:
`2026-10-22T10:45:45.335Z`–`2026-10-22T10:47:07.937Z`. Later definition-save,
layout, New, restart and safety steps were not executed. This record changes
neither product nor harness behavior.

## Exact source and artifact reuse

Runtime lane `.worktrees/bases-frontend-validation`, branch
`codex/bases-frontend-validation`, was frozen at
`884e65e723ba69759b534a2d1893a5bb8a8d7f2a`. Only reviewed test-helper change
`60c7fc46` was composed after 015. It requires generic enabled actionability
before pointer dispatch and adds passive receipts; the journey's semantic input
sequence and oracles are unchanged. Its 15 focused tests pass before execution.
Progress in 016 does not retroactively prove the admission state at 015's click.

Product `src` tree remains exactly `6a10f988983684f163b24a8af98edc164e888079`,
and Rust `crates` remains `5e010112661da69eb290d6a5edb72d4906e844a1`.
All 333 frontend distribution path/hash pairs, Electron and the preserved native
host match 015 exactly. The prior desktop build is reused; no npm/desktop/Rust
build was run for 016. The host path is
`/private/tmp/zorid-bases-preserved-native-5e010112/zorid-desktop-host`.
This is **interim verification against the old matching core**, not acceptance
of later Q3 semantics or final integration.

The retained successful [artifact-reuse prelaunch receipt](/private/tmp/zorid-bases-heavy-016-artifact-reuse-prelaunch-20261022.json)
records the exact source/artifact match, no owned test processes, and final
prelaunch free space 1,220,124,672 bytes. The runner's disk guard recorded
1,219,207,168 bytes, above the unchanged 1 GiB minimum.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-016`.

| Retained item | SHA-256 |
| --- | --- |
| Preserved native host | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| Reused `dist/assets/index-BbysNiLJ.js` | `a8492e11bb860b2abf3c150cc34e930f79468e9862dc3c9a3e19afd9da5459a1` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-016/result.json) | `0b26041d7e8b4105594b04b3cc694c54414bdab987ecfc9ae1e149ff920b880a` |
| Both provenance manifests, byte-identical | `9674afbcd97e30a3bc2559e47160638d15e4124b4ec7dd16bd9d75c59ea21648` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-016/failure.png) | `db6b29acf14b4a611d4671a4c9e3d0e231f81f4652971aab3f7d8ebb100fde16` |
| [Select diagnostic and passed-check list](/private/tmp/zorid-bases-heavy-20261022-016/native-select-diagnostic.json) | `257a679bb707948440228d5903d7ae6e660ce8e2ada3e481b7a143aac697a76b` |
| [Exact cleanup proof](/private/tmp/zorid-bases-heavy-20261022-016/owned-process-cleanup-proof.json) | `a4a2229ca46ce18eb93956a92c3dcc306c37f4e34667a9c7ae9befe8942e34a8` |

Before/after provenance verifies unchanged tracked source, distribution, native
host, Electron and harness fingerprints during the run. The fixture vault,
CSV, screenshots and independent saved-source checks remain retained.

## Durable checks reached

The first numeric save/body/unrelated-property check and checkbox save pass
again. The following additional checks pass through the production widgets:

- Multiselect stores the exact YAML list `['Design', 'Writing']`.
- Status stores `Reading`.
- Relation stores the exact escaped rooted filename `[[/Author%20Grace.md]]`.
- Native finished-date and appointment controls persist their changed values.
- Priority select persists the single value `High`.
- Plain list-chip addition stores `['alpha', 'beta']`.

These are the seven new durable checks after 015's 22-check frontier. The rich
property screenshot is retained as `03-rich-property-edits.png`. Preceding
creation, view/formula controls, summaries, CSV and resize/reset checks also
pass before this first failure. This is not a claim of all rich-property or
later definition/lifecycle coverage.

## Exact native SELECT failure

The journey opens topics property settings, adds a fourth option, and types
`Research` into its stored-value and label fields. It then requests color
`purple` through the visible native SELECT. The exact pointer receipt is:

```json
{
  "action": "pointer",
  "selector": "[role=\"dialog\"][aria-label=\"Property settings\"] .bases-property-option-row:nth-child(4) select[aria-label=\"Option color\"]",
  "index": 0,
  "count": 1,
  "modifiers": 0,
  "button": "left",
  "point": {
    "x": 764.7109375,
    "y": 306.8984375
  },
  "actionability": {
    "observedAt": 1792666001294,
    "nativeDisabled": false,
    "ariaDisabled": false,
    "inert": false,
    "allowDisabled": false,
    "requireEnabled": true,
    "disabledReasons": [],
    "target": {
      "tag": "SELECT",
      "role": null,
      "label": "Option color",
      "path": null,
      "property": null
    }
  },
  "at": 1792666001768
}
```

The actionability observation precedes the post-dispatch pointer action
timestamp; neither records native-popup focus or the resulting selected value.
All subsequent modifiers are zero. The recorded key sequence is:

| Key | Timestamp (raw action `at` ms) |
| --- | --- |
| Home | 1792666001770 |
| ArrowDown | 1792666001776 |
| ArrowDown | 1792666001776 |
| ArrowDown | 1792666001776 |
| ArrowDown | 1792666001777 |
| ArrowDown | 1792666001777 |
| ArrowDown | 1792666001777 |
| ArrowDown | 1792666001778 |
| ArrowDown | 1792666001778 |
| Enter | 1792666001778 |

The next helper readback waits for the SELECT value to equal `purple` and fails
with `Native select accepted keyboard input`, at journey line 248. The target
was observed native-enabled, not ARIA-disabled and not inert; the receipt does
not establish how macOS/Chromium handled those keys or which value remained.
No direct DOM value assignment, synthetic change event or fallback selection
was used. No next move/relabel/Apply action or durable option-color oracle is
reached. Source-level input diagnosis or a separate bounded native probe remains
required before accepting a remedy.

Failure DOM retains body `innerText`, `editors: []`, and one empty toolbar-alert
element. It does not record SELECT `.value`, selected index, option state,
focus after each key or AppKit popup state. The failure screenshot is retained;
it does not supply those missing programmatic observations. This partial run
does not establish a product color-setting defect.

## Visibility, cleanup and limits

Owned Electron PID `55022` was unhidden with real on-screen layer-0 window
`4866`, bounds `{x:144,y:72,width:1152,height:775}`. Renderer state was visible,
not hidden and focused. AppKit active remained false despite an accepted
activation request; OS foreground parity is not established.

Failure cleanup used `SIGKILL-cleanup` for `55022`, null exit code and signal
`SIGKILL`. Exact preserved-host child `55055` had `leaked: []`. The retained
proof at `2026-10-22T10:47:32Z` reports `exactOwned016Processes: []`.
Production host `47540` was not touched. This is failure cleanup, not successful
normal-quit/restart acceptance.

No product/source edits or extra builds occurred during the runtime slot.
No full journey, final integrated, Q3 core, browser/WASM, mobile, sync, matched
Obsidian visual, OS clipboard, normal-quit/restart, crash/power-loss or performance
acceptance follows from this partial run.
