# Bases matched visual capture and review plan — 2026-10-22

Owner: `bases_ui_review`; isolated branch `codex/bases-visual-acceptance-prep`,
worktree `.worktrees/bases-visual-acceptance-prep`. Documentation base
`5686f6b32c06c503a41a7978dedfb42466a7368b`. Root remains sole integration owner.

This is a source/evidence preparation record. No app, screenshot capture, build,
runtime campaign or pixel comparison was executed for this record. The maintained
[goal](../plans/bases-implementation-goal.md), [execution checkpoint](../deferred-product-roadmap.md),
[reference ledger](bases-pass-reference-20261021.md) and
[acceptance matrix](bases-acceptance-audit-20261022.md) remain the source of scope.
Current-core native/UI campaigns have partial failures under investigation; this
plan does not turn their screenshots or client tests into visual acceptance.

## Available reference and capture mechanism

The 23 labels below are the exact keys in
`tests/bases-visual-reference/campaign.mjs:specs`, not all 51 historical captures.
All 51 catalog PNGs are 2048×1600 pixels; the catalog has 48 distinct PNG hashes.
All 23 required PNGs and same-name JSON snapshots are present. Their PNG bytes
were read and hashed independently against the retained catalog; all 23 match.
The 23 requested labels contain 22 distinct PNG hashes because the two New-title
focus images are byte-identical. This audit inspected metadata and retained JSON
state; it did not perform a visual judgement on the PNGs.

Private reference root `R = /private/tmp/zorid-obsidian-reference-20261021/`.
Every table label identifies exact paths `R/<label>.png` and `R/<label>.json`.
Full PNG hashes appear below. Catalog SHA-256:
`96f6f5c77acab1874ae390b34f3be544e71281e4d0f1a884e7f5e77ccf8600fd`.

Target: Obsidian 1.14.4 cached ASAR SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`;
app.js SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Original application code/assets, screenshots and full DOM HTML stay private.
This repository record contains identifiers, hashes and independently written
observations only. No reference binary/image/HTML is copied into source.

The existing visual wrapper owns a disposable three-note fixture and 23 capture
calls, same-name PNG/JSON output, `visual-comparison.json` and a side-by-side HTML
report. It verifies reference PNG hashes/pixel dimensions, exact Zorid viewport,
actual durable values and reference immutability after execution. It does not
automatically prove appearance, interaction parity or producer-to-artifact provenance.
At audit time no `/private/tmp/zorid-bases-visual*` output directory was present.
The maintained checkpoint still lists all 23 matched states as required. Therefore
every Zorid state below is **authored/unexecuted and visual review pending**; other
heavy/layout/property campaign screenshots do not substitute for this fixture.

## Exact 23 states

All rows share the capture/review status above. “Aligned candidate” is a source
assessment, not an actual paired observation. UI routes use normal visible
controls; every state must revalidate its live title/layout, popup, values, counts,
focus and geometry before capture. Requery nodes after accepted writes.

| # | Reference basename / exact PNG SHA-256 | Normal Zorid UI route | Required state and present alignment |
| --- | --- | --- | --- |
| 1 | `baseline`<br>`744266200d9ae1ad613ba232aa60f9f4ab9915fd48fbb7849e8bb52e1390a032` | Open Reference.base; settle the three-item Table. | Items Alpha/Beta/Gamma; cost 10/20/null; five displayed fields. **Aligned fixture candidate.** |
| 2 | `view-menu`<br>`c6df975d52e2ad07e0177448ee651f2c87ff6ad1661d3583eba3801789eea568` | Table → Views. | Initial Table/Cards/List/Board order, four view rows and Add view. **Aligned fixture candidate.** |
| 3 | `table-view-settings`<br>`c0d0388a3fbfc56760b352e29903a32b0ced88bdff25c46686ddd9b354f329a6` | Views → Configure Table. | Table remains active; Table/Short settings. **Aligned fixture candidate.** |
| 4 | `view-actions`<br>`93f0bd6550ef27b2e494645230446d22fbb23bb95ab35a80061b28571c4372ac` | Configure Table → View actions. | Historical capture contains Configure view but no visible Default/Duplicate/Delete in DOM snapshot. **BLOCKED: native-menu reference versus rendered actions popup. Preserve original; propose explicit view-actions-dom alternative.** |
| 5 | `results-menu`<br>`6ab74b4969002342a14bea7e146ca078b951fd94e39190c6d84ed756b09d262b` | Dismiss settings → Results. | Three results, unset limit; Show all, Copy, Export. **Core state candidate; reference extra Untitled Base in explorer is shell-only mismatch.** |
| 6 | `filter-menu`<br>`1814dc9df7bdb9e33b5d54ddcf29fabfaac2de9d0ed5b6873582ce63f2d303db` | Table → Filter. | All views collapsed with count 2; This view has transient file links-to row. **BLOCKED: campaign currently captures saved filters only, not the transient row. Reproduce with normal UI before capture.** |
| 7 | `properties-menu`<br>`307dbc7ef050a53a5f7386bd3f04f0cbfd9f192e2b6202fe9588af199b0274f4` | Dismiss Filter → Properties. | Five checked displayed properties; remaining fields/Add formula/Hide all. **Aligned feature-state candidate; explorer difference remains.** |
| 8 | `sort-menu`<br>`49ae8e05271d45c5df6e3d127167c7e31b753a5191cd7104749849769f2b1122` | Dismiss Properties → Sort. | No configured sort. **Aligned feature-state candidate; explorer difference remains.** |
| 9 | `group-menu`<br>`d397cf925d7e6894cc5541449e98bc7f2b11af131f7c391789d6bd70829b6cee` | Dismiss Sort → Group. | Table has no grouping. **Aligned feature-state candidate; explorer difference remains.** |
| 10 | `cost-header-menu`<br>`ab8082c419b74601308c838f64300a5d7945835ff7735da82e21de8603f33a45` | Dismiss Group → right-click cost header. | Visible Hide column/Summarize/Group/Sort/Edit/Property type menu. **Aligned feature-state candidate; native OS input menus are excluded.** |
| 11 | `summary-menu`<br>`4bf41bce0f210267e78d09194c8d14237244d4cb696081f02184a43e17f37e83` | Keep the same cost header menu open; capture again. | Same header-menu contents; this label does not represent the summary picker. **Duplicate semantic state is intentional; keep separately named historical reference.** |
| 12 | `summary-picker`<br>`3746288fccbb59e1506a2a444323060b345b808db290db89ea1a0f1fb4aa7fbd` | Header menu → Summarize…. | Numeric10/20/null previews; Sum 30, Average 10, Unique 3. **Aligned fixture candidate; require exact visible preview and popup before capture.** |
| 13 | `summary-sum-selected`<br>`849ef553e03ce9682f105cc928c907ceb0ede7fe89f95f775cf471d98cd41045` | Picker → Sum; await saved selection and visible Sum 30. | Three notes plus Table footer Sum 30. **Aligned fixture candidate; saved config alone is insufficient.** |
| 14 | `cards-view-settings`<br>`1269dbfaf3664ec75208e5fd93d0766fab131b6cee575225fdaf8a734a08c62e` | Views → Configure Cards while Table stays active. | Cards size 200, no image, Cover, aspect 1.00; Table Sum 30 behind popup. **Aligned feature-state candidate; reference later view ordering differs.** |
| 15 | `cards-layout`<br>`feea332c509eb6b6f540488738dc6eb6de2f37761c314b6e8ef6233aafadcd74` | Rename Cards to Gallery through name/blur; open Gallery. | Three cards with file/status/cost; Gamma cost empty. **Feature-state candidate; reference Gallery/default/order differs and is separately disclosed.** |
| 16 | `list-view-settings`<br>`6b0b115b20d26978749d450a024374a59f62e161dbdab22c26bdfc939918df12` | Gallery → Views → Configure List. | Gallery behind popup; Bullet, no indentation, separator comma-space. **Aligned feature-state candidate; verify unchecked indentation instead of relying on input.value=on.** |
| 17 | `list-layout`<br>`1214f032d0423a3f297d0e13be2269189201a01fa7ea0f62fdf60d353e17fdd0` | Dismiss configuration; Views → List. | Three bullet rows; comma-space separators; no trailing separator for null cost. **Aligned feature-state candidate.** |
| 18 | `kanban-view-settings`<br>`8ec0ed1c7b737fc67ffd4563472516f373cfe05b3ef89be1360f73af1baa1f4b` | List → Views → Configure Board. | List behind popup; width 280, no image, Cover, aspect 0.50. **Settings candidate; reference Board later has an extra empty Fj column.** |
| 19 | `kanban-layout`<br>`dc06341b4083ecec8a0fb125240d44574fd690dbe3efbf8aa5ebc787c2e65395` | Dismiss settings; Views → Board. | Three item cards plus empty Fj column, then Done/In progress/Planned. **BLOCKED: reference DOM has four columns including Fj (0); current campaign asserts exactly three columns.** |
| 20 | `kanban-group-menu`<br>`b86ac2c326753d60f2370c7ca7760d592ad234e229086d43e714e11f65c6d9b7` | Board → Group. | Visible status/A→Z controls; Board still includes Fj (0). **BLOCKED: current fixture groupOrder makes manual saved ordering; reference shows A→Z and an extra empty Fj column.** |
| 21 | `new-item-template-popover`<br>`acb9b5aa100fb88c47f97c536b470961e2c19d64dcd697a84e62f83638dd9302` | After normal quit, stage disclosed template root settings; relaunch Board → New. | Four item cards plus empty Fj; Untitled cost 7/status Planned; title popup. **Pending extension comparison; Board mismatch carries forward. Full literal Zorid body is required, not a defect.** |
| 22 | `new-title-focused`<br>`e760ff35754155720dadbb57f303202d91e6a9f276b25acbea3d4216d6ba3b6a` | After normal quit, stage disclosed Single/Solo fixture with prior Untitled; relaunch → New. | Solo table with five notes; new Untitled 1 title owns focus. **Separate fixture; full body retained in Zorid. Exact selection assertion is additional Zorid check.** |
| 23 | `new-title-focus-retained`<br>`e760ff35754155720dadbb57f303202d91e6a9f276b25acbea3d4216d6ba3b6a` | Leave New title untouched for the recorded reference interval; capture retained focus. | Same title focus after 1000 ms; PNG/JSON hashes equal preceding reference. **Separate temporal observation, not a second distinct image. Then normal Enter→body/Escape→close checks.** |

## Resolve state mismatches before requesting a capture run

1. **Actions menu:** `view-actions.json` contains only Configure view/layout/row-height;
   it does not contain the action entries the campaign opens. The reference ledger
   explains the initial native-menu limitation. Retain this original label/history.
   A separately identified comparison can use existing `R/view-actions-dom.png`
   and `.json`, whose DOM includes Default view, Duplicate view and Delete view.
   Its PNG hash is below. It also contains the unrelated Untitled Base explorer row.
   A future reviewed campaign change must record original and alternative paths/
   hashes explicitly, not silently overwrite or relabel a historical capture.

2. **Filter:** `filter-menu.json` records All views collapsed/count 2 and a transient
   This-view file links-to condition. Current campaign captures only the saved
   two-condition membership. The transient reference row must be built through
   ordinary Filter UI, with the matching selected tab/conjunction/property/operator/
   blank value. Do not seed saved config, disable autosave or inject DOM/controller
   state merely to reproduce an unsaved visual row. Source feasibility and normal
   dismissal/no unintended membership change need focused review before capture.

3. **Board:** reference `kanban-layout.json`, `kanban-group-menu.json` and the
   Board behind `new-item-template-popover.json` include an empty `Fj` column
   alongside Done/In progress/Planned. The Group popup shows status / A→Z. Current
   visual fixture instead seeds `groupOrder: [Done, In progress, Planned]`, and the
   campaign asserts exactly three columns. Calling this manual mode intentional
   would not match that reference. Capture a separately observed equivalent
   reference state or reproduce the original automatic grouping/empty-column state
   through ordinary UI. Preserve the three original notes and their exact values.
   Do not classify the extra empty column as shell chrome or claim strict matching
   with only three columns. This alignment affects multiple rows, not just row20.

These are state-preparation gaps, not demonstrated Zorid product defects. No
campaign/spec/fixture correction was made in this documentation branch. The
integration owner must assign and review that separate, narrow batch.

## Serialized run and review procedure

1. Finish and independently review the state-alignment corrections above. Keep
   the 23 required history labels and explicit alternative provenance. Reconcile
   current UI selectors, normal close/focus behavior and the inferred-property
   fixture against the accepted product before freezing a run. Do not weaken
   saved-value, row-count, title-focus or resource guards to obtain screenshots.
2. Freeze a clean full root HEAD, frontend source/tree, current Rust tree and
   matching native host. Build the renderer from that root after the resource/
   runtime owner grants its serialized slot; keep source and artifacts fixed
   throughout. The existing desktop 003/core 8074 receipts are prior boundaries,
   not permission to reuse an artifact after new product source is composed.
3. Confirm the unchanged 1 GiB disk guard, no other owned app/build, fresh output
   directory and authorized disposable vault. Use genuine shown-window mode
   because production query/admission observes document visibility. Preserve
   exact AppKit/window/renderer visibility, host/Electron hashes and pre/post
   source/artifact manifests. Never substitute old-core 176 diagnostic acceptance.
4. Execute one fail-fast visual campaign. Retain every reached state’s screenshot,
   JSON, input actions, durable readbacks and failures. Later states are unexecuted
   if an earlier one fails. Stage template/Single fixture changes only after the
   owned app has quit, as already disclosed by the campaign. Offline staging
   never counts as normal UI creation. Normal quit/restart and exact owned-process
   cleanup remain separate required checks; leave unrelated production apps alone.
5. Review the 23 pairs independently at native pixels and normal displayed scale.
   Compare the Base surface and each popup: spacing, font metrics, row heights,
   widths, borders, icons, alignment, selected/disabled/error states, menu order,
   overflow, viewport clamps, focus, selection and the executed interaction.
   Retain full screenshots; any crop/overlay is a separately identified derived
   review aid with source hashes, never replacement evidence.
6. Record one disposition per state: matched; deliberate Zorid choice with reason;
   accidental product difference with issue/owner; state/fixture mismatch; or
   not reached. Record reviewer, exact source/artifacts and screenshot hashes.
   Capture success alone remains “review pending”. Fix accidental differences
   and recapture the affected state plus its dependent interactions. Do not
   declare the full goal complete while functional/native/visual gates remain open.

Prepared command shape (not executed; placeholders require a new reviewed freeze):

```sh
node tests/bases-visual-reference/run.mjs \
  --root FROZEN_ROOT --expected-head FULL_FROZEN_HEAD \
  --native MATCHING_CURRENT_CORE_HOST \
  --electron /Users/ctk/Projects/Zorid/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-visual-20261022-UNIQUE \
  --reference /private/tmp/zorid-obsidian-reference-20261021 \
  --ready bases-native-and-frontend-frozen --show-window
```

## Deliberate differences and complementary campaigns

Latest user AGENTS steering prioritizes the best Zorid UX. Obsidian remains the
starting point and evidence source; visual review must preserve required richer
properties/relations and safety instead of forcing every difference into parity.

- **Full template:** all frontmatter/body/placeholders copy literally. Obsidian’s
  retained New capture omits the body. Compare title, placement, width, focus,
  selection and normal dismissal, while identifying changed body/content/height
  rather than treating copied text as an appearance defect. Template source
  and complete created note bytes must remain exact.
- **Rich select/multiselect/status, relations/reverse relations/rollups:** additions
  lack matched reference widget screenshots in these23 states. Ordinary property
  campaign P1–P7/C1 covers saved-source, readonly and reference propagation paths;
  its current native partial failures and unexecuted remainder stay explicit.
  Review these additions separately for consistent appearance and useful UX.
- **Integrity policies:** last-view guard, correct rectangular mapping, conditional
  touched-property undo and stable resolved-target linksTo are documented in the
  reference ledger. Do not reproduce reference crashes or weaken stale/identity/
  failure guards for matching. Actual acceptance for each remains independent.
- **Shell/fixture differences:** unrelated extra Untitled Base explorer entries,
  Gallery default/view order and native shell chrome must be visible in the
  comparison notes. Assess whether they alter the feature under review; do not
  hide material popup/layout differences by broad cropping or a blanket waiver.

Primary heavy-user screenshots use a different 72-book fixture/viewport and are
functional evidence only. Config exercises filters/sorts/formula repairs/exports;
layouts covers card/column drag previews, cancellation, file drag, hover and
navigation; safety C2 and recovery cover guarded source/session failure paths;
native clipboard covers actual pasteboard/IME separately. Their normal UI routes
are useful for subsequent focused captures but cannot replace this 23-state run.
The visual set does not cover light appearance, scaling, screen-reader review,
mobile/touch, every rich/error state, or full performance/large-vault behavior.

## Alternative reference identity

`R/view-actions-dom.png`:
`86575f15d6ce3782d8e6d20a936f0d38275dd774270e5749242dcfc2a94e3288`
Same-name JSON SHA-256:
`a6a32bdec68706d525ecce9c91b08c386fe5c22dba2e7828cd6e1dd6fdd7fe4e`.
The alternative is retained and available, but the original23-label campaign
does not presently select it. Adoption requires a separately reviewed change.
