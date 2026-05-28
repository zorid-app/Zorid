# Code quality workflow

Zorid uses a layered quality gate. No single tool owns correctness by itself:

- **Biome** formats source/config files, runs fast lint checks, and organizes imports.
- **Custom import-boundary lint** preserves Zorid package architecture rules.
- **TypeScript / vue-tsc** remain authoritative for TypeScript and Vue type safety.
- **Vitest** covers behavior and contracts.
- **Build + perf smoke** prove the workspace and desktop app still build and the existing performance budget holds.
- **Knip** reports unused files, exports, dependencies, unresolved imports, and dependency drift.

## Daily commands

```sh
pnpm format        # rewrite files with Biome formatting
pnpm format:check  # check formatting only
pnpm lint          # Biome CI check plus custom import-boundary lint
pnpm check:biome   # Biome CI only: formatting, lint rules, and import organization
pnpm typecheck     # TypeScript project refs plus Vue typechecking
pnpm test          # Vitest suite
pnpm knip          # dead-code and dependency hygiene report
pnpm desktop:build # desktop main/preload/renderer build including Vue SFC checks
```

## AI coding loop

For small changes, run:

```sh
pnpm quality:fast
```

Before claiming a coding task is complete, run the full gate unless the task explicitly scopes it down. This includes the desktop build gate so Vue SFC and Electron entrypoints are covered:

```sh
pnpm quality
```

If the change touches desktop runtime or UI behavior, also boot the app for testing:

```sh
pnpm desktop:dev
```

## Guardrails for future agents

- Do not edit generated `dist/`, `out/`, `.vite/`, `release/`, or `node_modules/` outputs.
- Keep `scripts/check-import-boundaries.mjs` in the lint path; Biome and Knip do not know Zorid's architecture rules.
- Run `pnpm format:check` before broad write-formatting when the worktree already has unrelated changes.
- Stage only files changed for the current task; do not sweep unrelated dirty files into quality-tooling commits.
- Treat Knip findings carefully: delete real dead code, but add narrow ignores for intentional public entrypoints or ambient shim files.
- Keep Vue correctness anchored in `pnpm typecheck`; add ESLint later only if Biome cannot cover a specific Vue template lint requirement.


## Ratchet plan

The first rollout keeps the baseline useful without turning existing repository shape into unrelated cleanup work:

- Biome currently leaves unused imports, unused variables, and unused parameters non-blocking; promote those rules only after a dedicated cleanup pass removes existing intentional test fixtures and Vue/script-setup false positives.
- Knip export/member findings are warnings so public package and plugin APIs are not removed accidentally; make individual findings blocking only after confirming they are not intentional extension points.
- Keep ignores narrow and documented in `knip.json`; prefer deleting real dead code over adding broad ignore globs.
