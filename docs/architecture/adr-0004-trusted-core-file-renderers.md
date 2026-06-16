# ADR 0004: Trusted Core File Renderers and Plugin UI

## Status

Accepted as product/architecture direction; implementation pending phased execution.

Date: 2026-06-16

## Context

Zorid needs a trusted way for bundled core plugins to render non-Markdown file types both as full-page file views
and when Markdown documents embed them with wiki-style embed syntax such as `![[...]]`.

This is a file renderer capability, not a Markdown-only embed mechanism. The same renderer path should support
`full-page` file views and `markdown-embed` instances so core plugins do not need separate rendering systems for the
same file type.

Current `markdownProcessor` and `viewRenderer` hooks are not the right public API for this: they are Markdown-oriented,
do not model full-page file rendering, and cannot safely express trusted renderer UI lifecycle. Existing `.zbase`
support also relies on shortcuts, regex matching, and private editor block registrations rather than a public file
renderer contract. There is no `@zorid/plugin-ui` package today; this ADR defines the direction for introducing that
trusted authoring layer. It supersedes the earlier Markdown-only / embed-only direction.

## Decision

Adopt trusted core file renderers as the v0 rendering model:

- This capability is `fileRenderer` / custom file renderer, not `markdownEmbed`.
- The same renderer handles both `full-page` and `markdown-embed` surfaces.
- v0 exposes only `full-page` and `markdown-embed` surfaces; sidebar preview and hover preview are not part of v0.
- `platform-api` owns a framework-neutral `FileRendererContribution` mount/dispose contract.
- `platform-api` must not import `@zorid/plugin-ui`, Solid, Vue, Electron, or CodeMirror.
- `workspace.fileRenderers` capability is required for plugins that contribute file renderers.
- Renderer plugins must declare both `rendererEntry` and `contributes.fileRenderers`.

## Renderer Surfaces

Renderer surfaces are intentionally narrow in v0:

- `full-page` renders a file as the main editor/viewer surface when the user opens the file directly.
- `markdown-embed` renders the same file type inside Markdown `![[...]]` embed instances.

Matching is static and synchronous:

- match by extension, surface, and priority;
- do not perform async matching in v0;
- do not sniff file contents in v0.

Terms such as direct-open and embed may be used descriptively in prose, but they are not accepted aliases or public
surface identifiers. The only public surface identifiers in v0 are `full-page` and `markdown-embed`.

## API Shape

- `FileRendererContribution` metadata includes `id`, `title`, `priority`, `extensions`, `surfaces`, and
  `rendererExport`.
- Plugins register runtime contributions with `ctx.register.fileRenderer(contribution)`.
- Plugin manifests provide static metadata via `rendererEntry` and `contributes.fileRenderers`.
- For trusted core v0, `rendererEntry` and `rendererExport` identify the renderer module export loaded by the static
  trusted renderer map.
- The renderer contract is `mount(context) => dispose | { dispose }`, with disposal required when the host removes the
  contribution or the containing DOM is torn down.
- Renderer context provides the target DOM element, file identity/content access, selected surface, and safe host
  services.
- Writes use safe public APIs or narrow write helpers, never raw Node/Electron/filesystem access.
- The manifest remains the source of static renderer metadata and capabilities.

## Plugin UI Authoring

`@zorid/plugin-ui` will be the blessed authoring layer for trusted core plugin UI.

- It is Solid-backed.
- It exports `createSignal`, `createEffect`, `onCleanup`, `For`, `Show`, and `mountPluginUI`.
- It adapts Solid components to `FileRendererContribution.mount`.
- `mountPluginUI` creates and disposes the Solid owner for the mounted component, so component cleanup registered with
  `onCleanup` runs when the renderer contribution is disposed.
- Core plugins may import `@zorid/plugin-ui`.
- `platform-api` may not import `@zorid/plugin-ui`.

## Runtime And Safety Model

File renderer runtime is trusted-core-only in v0.

- Main/plugin host remains the manifest and capability authority.
- Renderer-side runtime loads only trusted renderer entries/components from the static loader map.
- Preload/IPC exposes only safe APIs needed by renderer contexts and narrow write helpers.
- The renderer process mounts and disposes contributions only where the owning DOM surface exists.
- Use a static loader map for known bundled renderer entries.
- Do not use dynamic `import(manifest.rendererEntry)`.
- Do not load arbitrary filesystem paths, path-derived modules, or `file://` URLs.
- Do not support community renderer loading in v0.
- Renderer UI code must not receive raw Node, Electron, or unrestricted filesystem access.
- Plugin UI writes go through safe public APIs or narrow write helpers.

## Editing And Refresh Model

Renderer UI may edit files only through approved APIs.

- Writes go through safe public APIs or narrow write helpers, not raw Node/Electron/filesystem APIs.
- Refresh is explicit or watcher-based.
- Renderer implementations should treat refresh as part of the renderer lifecycle rather than relying on hidden mutable
  filesystem access.

## .zbase Dogfood And Legacy Fallback

`.zbase` should dogfood the file renderer path.

- The `.zbase` renderer uses `@zorid/plugin-ui` once that package exists.
- Full `.zbase` processing is out of scope for this ADR.
- The old built-in `.zbase` editor widget is only a fallback when no file renderer resolves.
- A public renderer must override the legacy placeholder.

## Alternatives Considered

- `markdownEmbed`-only renderer: rejected because `full-page` and `markdown-embed` rendering would diverge.
- Framework-specific `platform-api` contracts: rejected because `platform-api` must remain framework-neutral.
- Dynamic renderer loading from manifest paths: rejected for v0 because it expands the runtime and safety surface.
- Community renderer loading in v0: rejected until the trusted-core model, public APIs, and safety boundaries are proven.
- Async/content-sniffed matching: deferred to avoid lifecycle, performance, and security complexity in the initial model.

## Consequences

- Core file renderer work should be implemented in phases.
- Renderer selection remains predictable because matching is static and synchronous.
- Bundled core plugins get a blessed Solid authoring layer without coupling `platform-api` to Solid.
- The runtime remains constrained to trusted bundled code in v0.
- `markdown-embed` instances and `full-page` file views share renderer behavior for the same file type.
- Legacy `.zbase` UI becomes fallback behavior rather than the primary path once a renderer resolves.

## Out of Scope

- Sidebar preview and hover preview surfaces.
- Community or third-party renderer loading.
- Dynamic loading from arbitrary `rendererEntry` paths.
- Async renderer matching or file content sniffing.
- Full `.zbase` processing semantics.
- Exposing raw Node, Electron, unrestricted filesystem, CodeMirror, Solid, or Vue through `platform-api`.

## Follow-ups

- Define the exact `FileRendererContribution` mount/dispose TypeScript contract in `platform-api`.
- Add import-boundary enforcement for `@zorid/plugin-ui` usage by core plugins and non-usage by `platform-api`.
- Implement the static trusted renderer loader map.
- Add renderer contribution manifest validation for `workspace.fileRenderers`, `rendererEntry`, and
  `contributes.fileRenderers`.
- Dogfood the path with a `.zbase` renderer built on `@zorid/plugin-ui`.
