# Kanban configuration action integration

The existing Kanban column control now receives a real session mutation callback.
`requestGroupOrder` validates the numeric rendered version, Kanban view type and
normalized grouping property before changing `groupOrder`. `undefined` removes
manual order, while `[]` deliberately hides every column. Optional ASC/DESC
changes preserve the complete existing `groupBy` mapping, including unknown
fields; this route never changes Markdown note properties.

Session configuration capability is separate from card movement. Writable
formula/file groupings can configure column order even when their cards cannot
move. Readonly sessions expose neither configuration controls nor move callbacks.
Accepted configuration updates use the same tracked shared-buffer queue as other
session actions, so flush/close waits for persistence and retains failed drafts.

A retry of a failed absolute view patch may encounter the exact desired YAML
already in the shared dirty base buffer. `BaseController.updateView` now computes
that desired source from the captured committed source and detached patch. It
accepts only the original committed source or that exact desired source; all other
unsaved configuration still rejects. It retains the original snapshot and file
lifetime guards, then uses the existing NoteBuffer compare-and-write path. There
is no separate disk write, arbitrary dirty merge or configuration-replay shortcut.

Focused fixtures use actual Vault, MemoryAdapter and NoteBuffer, including the DOM
session's Edit columns control. They verify unchanged note bytes, unknown field
preservation, explicit hidden-all versus automatic order, formula grouping
configuration without card moves, readonly controls, caller-value detachment,
stale-view rejection and failed-save retry behavior. Native popover geometry,
keyboard behavior and mobile interaction remain separate verification work.

Validation for the assembled column helper/action/session checkpoint: **81 focused
serial tests** pass, including six independent adapter/CAS probes, plus TypeScript
and whitespace checks. Independent review verified that a previously failed exact
draft cannot overwrite unseen external disk changes or a disposed/recreated source.
The helper dependency includes its separate stale-menu/drag and failed-manual-restore
review corrections. No full repository build or native verification was run here.
