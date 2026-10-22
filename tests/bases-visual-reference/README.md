# Matched Bases visual reference campaign

This separate campaign reuses the heavy-user runner's production Electron/native
launch, frozen artifact hashes, disposable vault, CDP input, durable readback and
owned-process cleanup. The default72-book heavy journey remains unchanged.

Run only with the integration owner's matching build freeze and runtime grant:

```sh
node tests/bases-visual-reference/run.mjs \
  --root /absolute/frozen/integration --expected-head FULL_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-visual-UNIQUE \
  --reference /private/tmp/zorid-obsidian-reference-20261021 \
  --ready bases-native-and-frontend-frozen
```

Captures use1024×800 CSS pixels, DPR2 and dark appearance. The fixture starts with
only Reference.base and Items/Alpha/Beta/Gamma, ordinary scalar properties and no
Properties.yaml. Costs are10/20/null, favorites true/false/false, due dates
2026-10-22/23/null, statuses Planned/In progress/Done. Current mutated reference
vault content and its extra Untitled Base are never copied.

The baseline reproduces the initial Table/Cards/List/Board view configuration.
Later states are reached through UI: select Sum30, rename Cards→Gallery, choose
layouts and open their settings. The retained before-template-base.txt describes
a later default/order/summary state and is recorded as evidence, not mistaken for
the initial baseline. Toolbar, header menu, summary picker, four layouts, layout
settings and New title/focus/keyboard states each retain screenshot+DOM metrics.

Offline fixture stages occur only after the owned app has quit: first add the
known template/new-item root settings, then recreate the separate Single/Solo
focus reference state. Each stage records its exact source and is labelled fixture
preparation. Positive UI interactions never mutate production controllers/stores.
Zorid's full literal template body is an agreed extension; Obsidian's template
popover copies only properties. This difference remains explicitly visible.

The HTML comparison report pairs retained Obsidian PNGs and Zorid captures. It
records exact artifact hashes, viewport, focus, geometry, text and known state
differences. Matching dimensions/data alone do not establish pixel or interaction
parity. Shell chrome, reference extra-sidebar entries, view-menu ordering and the
separate Single fixture are recorded; visual review must assess the paired states.
No source code from the recovered Obsidian artifacts is copied into this project.

This campaign never builds or starts Obsidian. It requires the retained reference
capture files and verifies their hashes before/after the run. No unavailable
control is silently skipped, and captures from the unrelated1280-wide Library
heavy journey are not used as parity evidence.
