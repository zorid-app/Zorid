# Plugin Vault facade foundation

Implemented in `src/plugins/vault-api.ts`, with original memory-vault fixtures in `tests/plugin-vault-api.test.ts`. This is a bounded compatibility foundation, not a complete Obsidian App, DataAdapter, or plugin execution environment. No community plugin or reference application was executed.

## Evidence

This work reuses retained E3 evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` and the artifact identity recorded in [plugin-api-reference.md](plugin-api-reference.md). Additional ordinary static reads of the same retained `app.js` checked these zero-based Unicode character ranges: `1412236–1414538` (file/folder classes), `1419300–1423205` (lookups, event mapping, tree mutation and creation), `1423205–1427890` (reads, deletion, rename, writes and file enumeration), and `1428500–1430973` (recursive traversal). These are bounded source observations, not a new complete REA graph or runtime trace.

Public names and signatures were cross-checked on 2026-10-16 against [the official API declarations](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts). That moving public declaration is supplemental evidence, not a version-pinned replacement for the retained 1.14.4 artifact.

The reference retains file objects during rename, uses `/` for the root, performs case-sensitive direct lookups, and distinguishes file/folder constructors. Traversal includes its root and visits last children first. Markdown enumeration checks lowercase `md`. Public text reads remove a leading BOM and cache the result; the reference's initial text cache limit is 65,536 characters. Binary APIs use ArrayBuffer.

Reference `Vault.rename` delegates a filesystem rename; link updating belongs to FileManager. Permanent deletion and system/local trash are separate adapter operations. The `force` option is forwarded to folder removal; public documentation describes hidden-child handling. The facade forwards that flag without reinterpreting it. Additional static reads found desktop adapter `rmdir` at offset `549209` forwarding it as `fsPromises.rm`'s `recursive` option, while mobile adapter `rmdir` at `1346857` ignores the flag and delegates to a wrapper at `1341381` that requests recursive removal. Those downstream paths have not been executed; the public comment is not evidence of identical platform behavior.

## Host assembly

Create one facade per live core vault with `new Vault(coreVault, host)`. Put these exact `Vault`, `TAbstractFile`, `TFile`, and `TFolder` exports into the host-supplied `obsidian` namespace. File objects and events then use those constructors. Dispose the facade when its vault closes; individual plugin unloads must only remove their own event registrations.

`VaultApiHost` requires the real vault name and configuration directory. Optional callbacks cover `rename(oldPath, newPath)`, `delete(path, force)`, `trash(path, system)`, `getResourcePath(path)`, and `getFileStats(entry)`. Mutation callbacks receive a third `validate` function. They must share the core vault queue, invoke that function inside the queue before I/O, and publish core events before resolving. The validation rejects disposed facades, deleted/replaced handles, and handles whose path moved while waiting; a caller can retry with the current object/path. Ignoring that callback could mutate a replacement at the captured path. An optional `adapter` is retained by identity; no compatible DataAdapter is synthesized from the differently shaped core adapter. A missing capability throws before any filesystem operation. The host callback fixture checks arguments only, and does not establish filesystem capability correctness.

## Implemented behavior

- Shared classes, root and parent/children links, filename properties, case-sensitive lookups, enumeration, and core-backed file mtime and byte size.
- Stable file/folder identity across core refreshes and recursive folder renames; recreated paths get new objects. Execution-time guards prevent removed, replaced, moved, foreign, or disposed handles from accessing another entry through a queued operation.
- Text read/cachedRead with BOM removal and bounded cache; binary read/create/modify with copied buffers; core text create/modify and folder creation.
- Existing Events semantics and file arguments for create/modify/delete/rename; rename passes the old path. Core initial loading emits create notifications for newly indexed entries. Events see the published tree before mutation promises resolve.
- Host disposal detaches core listeners and rejects subsequent reads/mutations. Adapter errors remain rejected promises; no synthetic success event is emitted.

## Remaining boundaries

There is no production App/namespace assembly in this change. Creation timestamps are absent unless supplied by the core adapter or `getFileStats`; substituting modification time would invent metadata. Timestamp write options reject explicitly because the current core does not forward them. `append`, `appendBinary`, `process`, `copy`, config APIs, external files and hidden-file monitoring are not exposed by this foundation.

Core `rename` rewrites links, so it is deliberately not used as a fallback for plugin `Vault.rename`. The separate `core.renameEntry` and `core.deleteEntry` capabilities can be bound as the host callbacks; the focused integration fixture verifies that binding a low-level rename preserves links and file identity. Core `trash` cannot choose system/local policy and is deliberately not used for permanent deletion or policy-specific trash. The host must supply compatible operations independently. Watcher moves currently arrive from core as delete/create; only a core rename event preserves renamed identity. Core emits one folder rename event; this facade follows that event count while updating all descendant paths. Exact reference descendant rename event ordering remains unverified.

The facade reflects core inventory snapshots. It cannot manufacture notifications for changes that the core silently reconciles during other operations, nor prevent races caused by external direct adapter users. A tree returned after disposal is a stale snapshot. These fixture checks establish the isolated facade behavior only; native/mobile integration and third-party plugin compatibility remain unverified.

Validation: 17 facade fixtures plus 6 coordinated core host fixtures pass with Node test concurrency 1, and the facade with its transitive core imports passes a focused strict TypeScript check. Independent review discovered a queued delete/recreate race in the first implementation; execution-time guards and text/binary regressions were added before integration.
