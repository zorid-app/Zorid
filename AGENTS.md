# Project Guidelines

## Workflow

- At the end of every coding session, add only the files you changed and commit them with a clear plain commit message; do not include omx lore.
- If not on `main`, after committing create `.agent-context/Zorid/merge-requests/<branch-name>` containing the commit message.
- If the user mentions screenshots, use the latest file in `.agent-context/screenshots` unless they specify another one.
- Ignore generated/build outputs unless explicitly requested: `dist`, `out`, `coverage`, `.vite`, `release`, `.omx`.

## Workspace Shape

- Package manager is `pnpm@9.15.2`; workspace packages are `apps/*`, `packages/*`, and `plugins/core/*`.
- Desktop app entrypoints are `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, and `apps/desktop/src/renderer/src/main.ts`; electron-vite config is `apps/desktop/electron.vite.config.ts`.
- Public contracts live in `packages/platform-api` and `packages/plugin-api`; implementation packages live under `packages/*`; bundled plugins live under `plugins/core/*` and must dogfood the public plugin APIs.
- Architecture docs in `docs/architecture/package-api-design.md` and `docs/architecture/adr-0001-api-gated-vertical-architecture.md` are useful for intent, but trust `scripts/check-import-boundaries.mjs` and `tsconfig.base.json` for enforced boundaries.

## Commands

- Install with `pnpm install`.
- Fast full verification: `pnpm quality:fast` runs `lint`, `typecheck`, and `test`.
- Root quality gate: `pnpm quality` runs lint, typecheck, tests, build, perf smoke, knip, and desktop build.
- Focused checks: `pnpm lint`, `pnpm lint:boundaries`, `pnpm typecheck`, `pnpm test`, `pnpm test tests/<file>.test.ts`.
- Desktop app: `pnpm desktop:dev`, `pnpm desktop:dev:watch`, `pnpm desktop:build`, `pnpm desktop:pack`, `pnpm desktop:dist`.
- Root `typecheck`, `build`, and `test` first run `prepare:ui-vue`; if invoking package TypeScript directly, build `@zorid/ui-vue` first when needed.

## Boundaries And Style

- Enforced import direction: apps may import non-plugin packages; shells may import implementation packages and `@zorid/ui-vue`; implementation packages may import only `shared`, `platform-api`, and explicit lower-level internals; core plugins may import only `shared`, `platform-api`, and `plugin-api`.
- Relative imports must not escape the owning package root; use workspace aliases such as `@zorid/editor` instead.
- Renderer/preload boundaries matter: do not expose raw Electron, Node, SQLite, or unrestricted filesystem APIs to renderer or plugins.
- Public `AppAPI` must remain metadata-only and must not grow a generic `getService()` escape hatch.
- Biome is the formatter/linter: 2-space indent, single quotes in JS/TS/CSS, semicolons, trailing commas, 120-column line width.

## Testing Notes

- Vitest tests live in `tests/**/*.test.{ts,js,mjs}` and use aliases to source files, not built package output.
- Import-boundary behavior is also covered by `tests/import-boundaries.test.mjs`; update both the script and tests when changing package rules.
- Desktop dev on headless Linux requires display variables; for smoke-only runs use `ZORID_DESKTOP_HEADLESS=1` if `xvfb-run` is available. WSLg display variables are repaired automatically by `scripts/desktop-dev.mjs`.
