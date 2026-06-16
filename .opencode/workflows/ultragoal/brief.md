# Ultragoal Brief: Trusted-core custom file renderers

Implement the approved custom file renderer foundation with a framework-neutral `fileRenderer` platform contract, Solid-backed `@zorid/plugin-ui`, manifest-declared static matching, trusted desktop runtime hooks, full-page and markdown-embed surfaces, `.zbase` dogfood path, tests, and ADR alignment.

Public identifiers are `fileRenderer`, `full-page`, and `markdown-embed`. Runtime v0 is trusted-core only: static loader map, no arbitrary manifest `rendererEntry` imports, and no raw Node/Electron/filesystem renderer exposure.
