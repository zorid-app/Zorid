# Zorid Documentation

Status: v0 planning docs promoted from `plan/` and `.omx/` on 2026-05-27.

## Product

- [Overview](product/overview.md)
- [Frontend](product/frontend.md)
- [Zorid root concept](product/zorid.md)
- [v1 feature notes](product/v1-features/templates.md)
- [Plugin power and shell UI extensibility](product/v1-features/plugin-power-and-shell-ui-extensibility.md)

## Architecture

- [Package/API design](architecture/package-api-design.md)
- [Kernel and plugin host](architecture/kernel-and-plugin-host.md)
- [Plugin manifest](architecture/plugin-manifest.md)
- [Storage model](architecture/storage-model.md)
- [Index schema](architecture/index-schema.md)
- [Fields and types](architecture/fields-and-types.md)
- [Zbase schema and filter grammar](architecture/zbase-schema-and-filter-grammar.md)
- [Core architecture review: Neovim and lazy.nvim comparison](architecture/neovim-lazy-comparison.md)
- [ADR 0001: API-gated vertical architecture](architecture/adr-0001-api-gated-vertical-architecture.md)

## Core plugins

- [Core plugin contract](core-plugins/00-core-plugin-contract.md)
- [File explorer](core-plugins/01-file-explorer.md)
- [Search](core-plugins/02-search.md)
- [Backlinks](core-plugins/03-backlinks.md)
- [Outline](core-plugins/04-outline.md)
- [Tags](core-plugins/05-tags.md)
- [Status bar](core-plugins/06-status-bar.md)
- [Fields](core-plugins/07-fields.md)
- [Data views](core-plugins/08-data-views.md)

## Planning and gates

- [Deep interview spec](planning/deep-interview-zorid-app.md)
- [PRD: v0 first wave](planning/prd-zorid-v0-first-wave.md)
- [Test spec: v0 first wave](planning/test-spec-zorid-v0-first-wave.md)
- [RALPLAN: v0 first wave](planning/ralplan-zorid-v0-first-wave.md)
- [Architect review](planning/ralplan-architect-review-zorid-v0-first-wave.md)
- [Critic review](planning/ralplan-critic-review-zorid-v0-first-wave.md)
- [Handoff record](planning/handoff-zorid-v0-first-wave.md)

## Research

- [Neovim plugins and lazy.nvim lazy loading](research/neovim-plugins-and-lazy-nvim-lazy-loading.md)
- [Obsidian and SiYuan](research/obsidian-and-siyuan.md)
- [Obsidian API design](research/obsidian-api-design.md)
- [Rust backend](research/rust-backend.md)
- [Frontend framework decision](research/which-frontend-framework.md)

## Current implementation gate

Before Phase 1+ implementation, the user must approve or revise the package boundaries, public Plugin API, and core Platform APIs in [Package/API design](architecture/package-api-design.md).
