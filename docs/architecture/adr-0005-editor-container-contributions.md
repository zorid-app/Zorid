# ADR 0005: Editor Container Contributions

## Status

Accepted as product/architecture direction; implementation pending phased execution.

Date: 2026-06-16

## Context

ADR 0004 establishes trusted core file renderers for `full-page` file views and `markdown-embed` instances. Those
renderers are host-created DOM containers with mount/dispose lifecycle, authored through trusted plugin UI where
applicable, while `platform-api` remains framework-neutral and does not expose raw Electron, Node, CodeMirror, Solid,
Vue, filesystem, or DOM positioning internals.

Zorid also needs editor-adjacent UI that is not a file renderer: slash menus, `[[` wiki link menus, math previews
inside or near `$...$`, selection popovers, hover popovers, range overlays, viewport overlays, and document
header/footer UI. These surfaces attach to the active editor and its semantic anchors rather than replacing or embedding
file content. They need a public direction distinct from ADR 0004 so editor-adjacent UI does not overload
`workspace.fileRenderers` or file renderer lifecycle.

## Decision

Adopt `EditorContainerContribution` as a distinct trusted/core editor UI extension surface.

- The capability is `editor.containers`.
- Static manifest metadata lives at `contributes.editorContainers`.
- Runtime registration uses `ctx.register.editorContainer(...)`.
- The contribution type is `EditorContainerContribution`.
- Contributions that read editor state also need the `editor.read` capability.
- `workspace.fileRenderers` remains only for file renderers, full-page file views, and Markdown embeds. Editor
  containers are not file renderers.
- `EditorExtensionContribution` remains a separate low-level escape hatch and is not the default editor UI container
  API.

## v0 Placements

Editor container placements are semantic in v0:

- `cursor-popover`
- `selection-popover`
- `range-overlay`
- `hover-popover`
- `viewport-overlay`
- `document-header`
- `document-footer`

Side-panel and status-area contributions are deferred. Public contracts do not expose raw `x`, `y`, `top`, `left`, or
arbitrary viewport coordinates. `viewport-overlay` remains semantic: plugins declare intent and the host computes
coordinates. `hover-popover` anchors to a host-derived semantic hover target such as a source range, token, or container
region, not to plugin-supplied pointer coordinates.

## Activation And Editor Reads

Plugins own activation and satisfaction logic for their editor containers.

- Activation is synchronous, read-only, and point-in-time.
- Activation may inspect safe editor state through `EditorReadAPI`.
- `EditorReadAPI` supports cursor-relative text, absolute lines, ranges, selected text, visible ranges, hover target
  summaries, and optional explicit expensive whole-document reads.
- Activation does not mutate editor state.
- `EditorReadAPI` and `platform-api` must not expose raw CodeMirror view/state/transactions, Electron, Node, Solid,
  Vue, filesystem access, raw DOM positioning internals, or mutable editor objects.

## Host-Owned Containers And Lifecycle

The host creates positioned containers and owns editor integration concerns:

- placement, collision, clipping, stacking, and z-index;
- tabbed overlap and grouping for overlapping active containers;
- focus restoration;
- outside click handling;
- disposal and updates when anchors invalidate.

Plugins render into the host-provided container using the trusted plugin UI direction from ADR 0004 where applicable.
`platform-api` remains framework-neutral. `@zorid/plugin-ui` may provide an authoring layer outside `platform-api`.

Overlapping active containers are grouped or tabbed by the host. Plugins do not negotiate z-index or own absolute DOM
positioning.

## Input Model

Editor containers use a hybrid input model with the host remaining the input arbiter.

- `keyboardFocus`: `editor` or `container`.
- `textInput`: `editor`, `container`, or `blocked`.
- `capturedKeys?: string[]` declares keys the container wants to handle.
- `pointer.hitArea`: `container` or `content`.

This supports complex slash-menu behavior. For example, a plugin-owned submenu can use ArrowRight to open, ArrowLeft to
close, arrow keys to navigate, Enter to accept, and Escape to close. `textInput: 'editor'` lets typing continue to update
the document or query, while `textInput: 'container'` lets an advanced picker own text input. IME and composition events
are routed according to `textInput`. Conflicts and reserved keys are handled by host diagnostics and policy.

`pointer.hitArea: 'content'` allows clicks through empty container space to the editor and may close the container as an
outside interaction. `pointer.hitArea: 'container'` captures the full container bounds.

## Alternatives Considered

- Narrow slash, link, or autocomplete-specific APIs: rejected because the same host-managed container lifecycle should
  support multiple editor-adjacent UI patterns.
- Reusing ADR 0004 file renderers: rejected because file renderers are for file surfaces and Markdown embeds, not
  editor-adjacent UI anchored to the active editor.
- Using `EditorExtensionContribution` as the normal path: rejected because it is a low-level escape hatch rather than the
  default UI container API.
- Plugin-owned absolute DOM or pixel positioning: rejected because placement, clipping, collision, stacking, tabbed
  overlap, and anchor invalidation must stay host-owned.
- Raw editor or CodeMirror exposure: rejected to preserve the public API boundary and avoid mutable editor internals in
  plugin contracts.
- Async or mutating activation in v0: rejected to keep activation predictable, read-only, and cheap.
- Side-panel and status-area surfaces in v0: deferred until the editor container model is proven.

## Consequences

- Trusted/core plugins get a distinct editor-adjacent UI surface without overloading file renderers.
- The host remains responsible for layout, focus, input arbitration, and lifecycle safety.
- Public contracts stay semantic and framework-neutral.
- Advanced UI such as slash menus, wiki link menus, math previews, popovers, and overlays can share one container model.
- Plugin input behavior becomes explicit enough for host diagnostics, reserved-key policy, IME routing, and click-through
  behavior.

## Out of Scope


- Manifest validation changes.
- Host container manager implementation.
- Side-panel and status-area surfaces.
- Constraining the legacy editor extension escape hatch.

## Follow-ups

- Add `EditorContainerContribution`, `EditorReadAPI`, and related contracts to `platform-api` / `plugin-api`.
- Add manifest validation for `editor.containers` and `contributes.editorContainers`.
- Implement the host editor container manager.
- Add import-boundary tests for the new contracts and package boundaries.
- Dogfood with slash menu, wiki link menu, and math preview containers.
- Consider constraining the legacy `EditorExtensionContribution` escape hatch once editor containers cover normal UI
  extension needs.
