# Plugin foundation integration

This checkpoint combines the reviewed loader/module resolver, Vault facade,
shared file classes and UI controls with core and desktop capabilities. It does
not install community plugins or expose a production `App` object. The namespace
assembly in the integration test is an original fixture, not application wiring.

The desktop preload's `remove` capability now has a matching authenticated main
IPC handler. It follows the same broker queue and window/vault grant checks as
other mutations. Tests load the actual main script with mocked Electron, exercise
valid deletion forwarding, reject a foreign vault and child frame, and retain the
existing queued-grant, filesystem boundary and shutdown checks. No native app or
external plugin was executed for these tests.

The facade's optional rename/delete callbacks must bind to
`core.renameEntry.bind(core)` and `core.deleteEntry.bind(core)` (or an equivalent
host implementation that invokes the supplied validation inside the same queue).
They must not discard the validation argument. Integration tests queue deletion
and recreation before an old handle's rename/delete and verify the replacement
survives. Low-level plugin rename preserves file identity and does not rewrite
Markdown links. Permanent deletion forwards the force flag and publishes normal
core events. Policy-specific local/system trash and resource URLs remain absent
unless a host supplies those capabilities explicitly.

An original loader fixture assembles the exact shared Plugin, Vault/file and UI
constructors, creates a real Setting/TextComponent, uses the core-backed facade,
and unloads its commands, styles and controls without disposing the shared vault.
This establishes compatibility between these particular foundation modules only.
Production namespace assembly, plugin discovery and enabled-state persistence,
App/Workspace/MetadataCache/FileManager APIs, real command/settings integration,
editor extension registration and broad third-party plugin compatibility remain
separate work. The CommonJS evaluator is not a security sandbox.

The focused integration/module/core/desktop suite passes 76 tests at concurrency
one. Native/mobile behavior, external plugin execution and complete API parity are
not established by this checkpoint. See the individual plugin API, loader and UI
reference documents for bounded source evidence and unsupported methods.

## Combined checkpoint verification

After merging renderer checkpoint `9ec259a` and the independently reviewed optional
core rename validation hook, implementation `a99a968` passes **1,146/1,146 tests**
with concurrency two (23.4 seconds), a separate TypeScript check and production
webpack build (4.3 seconds; three existing bundle/performance warnings). No tests
were skipped. These checks were serialized on the 8 GB development machine. The
hook passes file-tree caller validation through the existing link-updating rename
queue; this foundation checkpoint does not include the file-tree host UI changes.
The native main-handler and cross-module integration delta was independently
reviewed before the full run. No Electron window or external plugin was launched.
