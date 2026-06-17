# Ultragoal Brief: ADR0005 editor container contributions

Implement the first ADR0005 editor-container vertical slice: framework-neutral public contracts, manifest/capability validation, trusted-core desktop runtime resolution, renderer bridge delivery, private editor-host adaptation, minimal cursor-popover semantics, plugin-ui helper support, and a core slash-menu dogfood contribution.

Runtime v0 is trusted-core only. Public contracts expose semantic placements such as `cursor-popover`; raw CodeMirror/Electron/Node/Solid/Vue details and raw coordinate placement remain private/internal.
