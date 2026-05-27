# ADR 0001: API-Gated Vertical Architecture

Status: accepted by RALPLAN consensus; pending final user API/package gate  
Date: 2026-05-27

## Context

Zorid v0 must become a runnable desktop-first local Markdown workspace while preserving a future plugin ecosystem and cross-platform architecture. The user requested co-design and approval of package boundaries, the public Plugin API, and core Platform APIs before implementation.

## Decision

Use an API-gated vertical architecture:

1. approve package/API design first;
2. scaffold monorepo, contracts, and import-boundary tests;
3. implement thin but real vertical slices through the approved APIs;
4. dogfood the plugin model with bundled core plugins;
5. revise major API/package changes only through documented ADRs.

## Accepted refinements

Zorid's core architecture now includes:

- Neovim-inspired API metadata via `AppAPI.apiInfo()`;
- capability-enforced plugin contexts;
- lazy.nvim-inspired lazy-load observability and plugin diagnostics.

## Consequences

- Deep implementation must not begin until the API/package gate is approved or revised.
- Core plugins may use `core-experimental` APIs, but must not import private shell or implementation internals.
- First-wave core plugins are desktop-only unless explicitly mobile-tested.
- Public `AppAPI` remains metadata-only and must not expose `getService()`.
