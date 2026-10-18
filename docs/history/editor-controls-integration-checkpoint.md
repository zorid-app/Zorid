# Image, table and workspace hotkey integration checkpoint

Production checkpoint `66a87b0` combines reviewed image resizing (`0c7b31c`),
configurable workspace hotkeys (`4cd658b`), and the table context-menu ownership
repair (`9505c93`) on canonical main `db75507`. Merge `954fdc2` subsequently
includes main `1d37065`, whose delta is documentation only. Shared-core work and
new Canvas product requests remain separate; no dependency or public API redesign
is included.

The hotkey Workspace merge keeps both `Command.id` and the Bases factory. It
retains the Bases preflight in pane/workspace flush and adds hotkey subscription
cleanup to existing destruction. The current runtime, shared NoteBuffer identity
and recovery guards, cached sessions, and all five Bases style imports remain.
The desktop staging allowlist includes the new bounded menu-caption module.

Image gestures preview width without a Markdown write, then commit a guarded
source edit with isolated undo; cancellation restores the previous width.
Table context events use an event-local owner handoff when cell activation
replaces the original event target. Workspace hotkeys are locally configurable
with reserved editor/system commands, conflict checks and modal ownership.
The individual ledgers describe precise behavior and limitations.

## Integration gate

- 109 serial focused image, hotkey and Workspace Bases tests passed before the
  final table pick; the table slice separately passed nine independent checks.
- The complete suite passed **1,761/1,761 tests**, zero failures/skips, at
  concurrency two in 52.155 seconds on `66a87b0`.
- TypeScript checking and production webpack build passed on `954fdc2`; build
  duration was 5.505 seconds with three bundle/performance warnings.
- Source privacy/credential checks cleared all three feature commits.

No native app, packaging pass or mobile test was launched for this integration.
Native Electron 44 menu captions, removed/rebound shortcuts, image gesture pixels
and table popup placement still require root verification. Configuring editor-wide
commands, native keyboard-layout parity, keyboard image resizing and full context
menu parity remain separate gaps. This batch does not complete every editor
shortcut or interaction request.
