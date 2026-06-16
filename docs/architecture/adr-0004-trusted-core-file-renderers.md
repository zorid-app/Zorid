# ADR 0004: Trusted Core File Renderers and Plugin UI

## Status

Accepted as product/architecture direction; implementation pending phased execution.

Date: 2026-06-16

## Context

Zorid needs a trusted way for bundled core plugins to render non-Markdown file types both when users open those
files directly and when Markdown documents embed them with wiki-style embed syntax such as `![[...]]`.

This is a file renderer capability, not a Markdown-only embed mechanism. The same renderer path should support direct
file opens and Markdown embeds so core plugins do not need separate rendering systems for the same file type.

## Decision

Adopt trusted core file renderers as the v0 rendering model:

- This capability is `fileRenderer` / custom file renderer, not `markdownEmbed`.
- The same renderer handles both direct file open and Markdown `![[...]]` embed surfaces.
- v0 exposes only direct-open and embed surfaces; sidebar preview and hover preview are not part of v0.
- `platform-api` owns a framework-neutral `FileRendererContribution` mount/dispose contract.
- `platform-api` must not import `@zorid/plugin-ui`, Solid, Vue, Electron, or CodeMirror.
- `workspace.fileRenderers` capability is required for plugins that contribute file renderers.
- Renderer plugins must declare both `rendererEntry` and `contributes.fileRenderers`.

## Renderer Surfaces

Renderer surfaces are intentionally narrow in v0:

- `direct-open` renders a file as the main editor/viewer surface when the user opens the file directly.
- `embed` renders the same file type inside Markdown `![[...]]` embeds.

Matching is static and synchronous:

- match by extension, surface, and priority;
- do not perform async matching in v0;
- do not sniff file contents in v0.

## Plugin UI Authoring

`@zorid/plugin-ui` is in scope as the blessed authoring layer for trusted core plugin UI.

- It is Solid-backed.
- It exports `createSignal`, `createEffect`, `For`, `Show`, and `mountPluginUI`.
- It adapts Solid components to `FileRendererContribution.mount`.
- Core plugins may import `@zorid/plugin-ui`.
- `platform-api` may not import `@zorid/plugin-ui`.

## Runtime And Safety Model

File renderer runtime is trusted-core-only in v0.

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

- The `.zbase` renderer uses `@zorid/plugin-ui`.
- Full `.zbase` processing is out of scope for this ADR.
- The old built-in `.zbase` editor widget is only a fallback when no file renderer resolves.
- A public renderer must override the legacy placeholder.

## Alternatives Considered

- `markdownEmbed`-only renderer: rejected because direct file open and Markdown embed would diverge.
- Framework-specific `platform-api` contracts: rejected because `platform-api` must remain framework-neutral.
- Dynamic renderer loading from manifest paths: rejected for v0 because it expands the runtime and safety surface.
- Community renderer loading in v0: rejected until the trusted-core model, public APIs, and safety boundaries are proven.
- Async/content-sniffed matching: deferred to avoid lifecycle, performance, and security complexity in the initial model.

## Consequences

- Core file renderer work should be implemented in phases.
- Renderer selection remains predictable because matching is static and synchronous.
- Bundled core plugins get a blessed Solid authoring layer without coupling `platform-api` to Solid.
- The runtime remains constrained to trusted bundled code in v0.
- Markdown embeds and direct file opens share renderer behavior for the same file type.
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
