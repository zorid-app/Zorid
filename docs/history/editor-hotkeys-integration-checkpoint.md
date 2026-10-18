# Scoped editor hotkeys integration checkpoint

This batch adds 13 configurable editor actions to the already integrated workspace
hotkeys: eight formatting actions and five folding actions. The commands reuse
existing formatting/folding implementations. Existing default editor keymaps stay
in place; this does not complete configurable bindings for every editor command.

The source chain is catalog `d8829b6`, consumer `affe8fb`, IME/AltGraph correction
`6727122`, independent tests `6888202`, table rectangle ownership `2ea2b34`, macOS
Option-key normalization `0a7f24b`, final repeat guard `4352109`, Workspace/Canvas
threading `1add8d8`, and acceptance regression `91d0191`. Integration retains both
complete test additions where catalog and Option changes appended to the same
files. Production changes merged without manual rewriting.

Workspace, ordinary notes, Canvas text and linked-note editors share the same
preference source. Parent and table-child editors retain their actual views,
history and selection while compartments reconfigure. Changes during composition
wait until composition ends; IME/AltGraph input is not cancelled. Repeated
configured shortcuts do not repeatedly toggle formatting, including macOS
Option-letter events whose displayed text differs from the virtual letter.
Previously recorded incorrect symbol bindings require re-recording; no automatic
migration guesses at their intended letters.

Rectangle formatting retains rendered table and nested-editor ownership. Undo
restores the rectangle separately from earlier child typing. Workspace modal,
menu, autocomplete and editor-search ownership remain in effect. Readonly and
stale/unavailable targets cannot mutate document text. Shared subscriptions and
queued updates retire with their owning editors.

## Validation boundaries

The independent combined review inspected the full production aggregate and ran
36 tests plus an original Workspace/Canvas/table probe. It verified rebinding in
nested editors, preserved rectangle selection, separate Canvas JSON and linked
Markdown persistence, and parent undo. The integration's initial focused run
passed 43 tests. Source credential/private-path scanning cleared all nine feature
commits.

No native app, packaging pass, browser automation or mobile test was run by this
integration lane. Real IME behavior, keyboard layouts, OS-owned interception and
native Settings presentation still require device verification. Additional editor
command families and other product work remain separate.

## Completed aggregate gate

The full repository suite passed **1,822/1,822 tests**, no failures or skips,
with concurrency two in 82.170 seconds. It started on `06912c6`; parent merge
`051e66f` had an identical tree. Main's documentation-only `8812e64` was merged
afterward as `724b6f0`. TypeScript and production webpack passed on that source;
the build took 6.145 seconds and emitted three bundle/performance warnings.
Parent documentation and this evidence ledger are the only changes after the
full-suite snapshot. Canvas resizing and the next Bases Table interaction slice
are excluded and remain separate integration work.
