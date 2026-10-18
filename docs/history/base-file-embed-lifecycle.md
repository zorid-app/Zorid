# Writable Base file embeds

This slice mounts existing writable Base sessions for file embeds in Reading,
Live Edit, and Canvas Markdown text/file cards. It does not implement fenced
`base` configuration blocks, a public plugin API, or new storage machinery.

## Retained reference evidence

The earlier REA audit used the retained Obsidian 1.14.4 extraction at
`/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`, evidence
`ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`.
`app.js` SHA-256 is
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
The following are static source observations, with zero-based character offsets:

- File embed registration at 3232690 passes the fragment's view name; the `#`
  prefix is removed around 3232766.
- The file-backed save path at 2548060 writes the actual Base file. Containing
  source-file context is provided around 2548268.
- Missing named-view handling around 2541056 reports an error rather than
  silently selecting the first view.
- The separate fenced handler around 3231036 supplies the containing Markdown
  file and rewrites its code block around 3231331. That source-binding path
  remains deferred; a Markdown file is never passed off as a synthetic `.base`.

A bounded CSS follow-up rechecked `app.css` SHA-256
`866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`:
the embedded Base block around 444444 uses an overridable height with an `auto`
fallback. Zorid's current existing virtual views instead receive a bounded
320px viewport through the same height variable. That fallback and the recovery
section are original implementation choices, not established visual parity.
No recovered implementation was copied, and no reference application executed.

## Ownership and persistence

`BaseEmbedSessions` belongs to the loaded tab runtime, outside individual
Markdown renderer instances. `MarkdownEmbeds.releaseEmbed` and `destroy` detach
bindings synchronously. They never discard a writable Base session. Reading
rerenders and Live widget replacements can reclaim the same session DOM.

Bindings match the containing source path and incarnation, resolved Base path
and incarnation, named view, and optional state-local occurrence token. The
token alone is insufficient: two editors can share an EditorState, and target
edits can preserve a token. Simultaneously mounted occurrences have separate
sessions. Four recently used clean detached sessions stay warm; older clean
sessions close asynchronously and release their controllers, thumbnails and
DOM. Failed or unfinished edits are never evicted.

An unfinished detached session moves into a visible, editable recovery section
inside its tab. The user can finish or cancel the original property input. A
source edit that removes an embed therefore cannot silently abandon its draft.
Failed writes retain both that UI and the existing shared NoteBuffer recovery.

The host reuses the ordinary Base session factory, shared buffer registry,
selection mapping, peer editor reconciliation, guarded rename and attachment
leases. `this` refers to the containing source file for embeds; standalone Bases
retain their own file context. The named-view dependency resolves exact names
before each query and keeps a local selector choice bound to its selected name.
Configuration reorder cannot silently switch the requested view.

The manager coalesces concurrent flush callers. A later session's awaited write
can allow another edit in an earlier session; preflight revisits pending work.
Once initial loads settle, clean repeated flushes avoid session flush calls.
Unaccepted property inputs reject navigation rather than being implicitly
committed or discarded. Tab close first flushes nondestructively, validates the
runtime revision, and only then closes sessions during disposal. Editing the
source during a delayed close leaves its Base sessions usable after rejection.

Workspace save, navigation, mode changes, close, vault transitions, external
source deletion and before-unload checks include embedded pending state. Canvas
file sessions wrap their existing persistence gates; text sessions use the
separately reviewed `textEmbedLifecycle` hook. Text-card replacement/removal
checks that hook explicitly. Since the manager belongs to the Canvas tab,
another card's unfinished Base edit can conservatively block replacement.
Geometry changes remain allowed.

Source and target guards run again through the shared buffer's actual queued
write validator. A renamed/deleted/recreated Base target retires its old write
capability: unfinished inputs stay visible and cancelable, but do not write
through a same-path replacement. Seamless rebinding of an unfinished input
after a legitimate target rename remains a limitation, not a completed parity
claim.

## Verification boundary

Focused tests use the actual Workspace, Vault, shared NoteBuffers, CodeMirror,
Base sessions and Canvas cards. They cover property persistence, named views,
source context, visible draft removal/remount, failed-save retry, accepted-write
navigation waits, source/target replacement, source edits during close, Canvas
replacement guards, and clean-session resource bounds. Existing Base, Canvas
Markdown and attachment tests form the adjacent regression gate. Independent
host review is required before promotion; passing jsdom checks do not establish
native interaction, visual layout, mobile behavior or full reference parity.

Fenced Base configuration still requires a dedicated internal source binding:
extract the current complete fenced YAML, preserve the containing note identity,
and transform only the expected fence range through its shared Markdown buffer.
It also requires parser/occurrence reconciliation and the same durable-session
flush gates. Neither a read-only substitute nor a fake file satisfies that work.

## Restart checkpoint — 2026-10-16 (historical pause)

Worktree: `.worktrees/base-file-embeds`, branch `parity/base-file-embeds`.
Dependency HEAD: `ba3d0e1be95b3c4a64e259dc724b347af8976277`. The implementation
is frozen but uncommitted in exactly six files: this document,
`src/ui/base-embed-sessions.ts`, `src/ui/embeds.ts`, `src/ui/workspace.ts`,
`tests/base-embed-sessions.test.ts`, and `tests/workspace-base-embeds.test.ts`.

Starting at main `8cfe95d`, reviewed prerequisite commits were applied in this
order: `e3114bf` (occurrence context), `1247482` and `4ca382f` (Canvas resize and
embed lifetime hook), `b568f2c`, `f34128b`, `f5f924c`, `e958686`, `d282e8d`
(current Kanban/controller baseline), then `eefb947` and `bd8357c` (named view
tests and implementation). Do not apply equivalent prerequisites twice when
integrating onto newer main.

The serial focused gate passed 61 tests across `base-embed-sessions`,
`workspace-base-embeds`, `workspace-bases`, `workspace-canvas-text-services`,
`workspace-canvas-file-integration`, and `embeds`. Review then found URL-encoded
Markdown view fragments; the fix decodes only Markdown fragments and the added
actual-host regression passed (wiki percent names remain literal). Direct
TypeScript checking and `git diff --check` exited successfully afterward.

The pause left independent final review with `/root/reading_render_review`,
including simultaneous occurrence isolation and encoded view names in both
modes. No merge, full build, native verification, or new implementation slice
was performed as part of that checkpoint.

## Review closure after resume

The reviewer confirmed the pre-pause review had completed successfully and
rechecked that all three production file hashes were unchanged after resume.
The independent gate passed all 25 manager and actual-host tests, plus three
original probes: URL-encoded named views in Live Edit and Reading, and two
same-target occurrences retaining distinct active drafts when one is removed.
The raw Markdown fragment issue was fixed and independently verified; no
remaining blocker was found in this scope. The reviewer also checked the
documented lifecycle, 320px viewport choice, and native limitations.

These six files are cleared for a scoped commit. Integration remains with the
editor coordinator, who must reconcile current main and its already-integrated
prerequisites, preserve newer Workspace hotkey wiring, and revalidate the
affected combined behavior. Fenced configuration, native/mobile behavior and
visual/reference parity remain outside this completed file-embed slice.
