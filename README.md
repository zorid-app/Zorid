# Zorid

An original open-source Markdown workspace informed by Obsidian. Zorid uses a
shared TypeScript/CodeMirror editor, Electron on desktop, a browser client and a
native iOS shell embedding the shared editor. Rust supplies shared data semantics,
native persistence, indexing/query services and encrypted sync foundations.

The application is in development. Current priority is desktop saving/recovery
reliability and measured Rust indexing/search performance, followed by complete
desktop Bases, Tasks, Calendar and Google integration. Existing iOS work is
preserved; further native implementation follows desktop completion.

## Documentation

Follow the [product roadmap](docs/roadmap.md) for the delivery sequence and
milestone gates. Start with the [architecture overview](docs/architecture/README.md), organized by
platform and then by Rust system. The [documentation index](docs/README.md) separates
maintained design, current decisions, execution tracking and historical evidence.
[Platform setup](docs/platforms.md) lists development/build entry points.

## Development

Use Node.js 26+ and the repository's pinned pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

For Electron, use `pnpm run desktop:dev` alongside Vite. Native renderer, Rust host,
WASM generation, packaging and mobile builds have separate requirements; see the
[build architecture](docs/architecture/build.md) before selecting a check. Source
or component success does not establish native/mobile runtime behavior.

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/ui`, `src/editor` | Workspace, buffers, editor and document presentation |
| `src/core`, `src/platform` | Frontend services, platform bindings and current browser transaction host |
| `src/bases`, `src/tasks`, `src/calendar`, `src/canvas` | Feature presentation and service consumers |
| `crates` | Portable Rust semantics, native Store/filesystem, bindings, CLI and relay |
| `desktop` | Electron main/preload and Rust-host transport |
| `ios`, `mobile/rust` | Native iOS shell and embedded Rust C ABI |
| `android` | Existing Capacitor Android project |
| `tests` | Semantic, storage, component and integration checks |

## License and provenance

Zorid is licensed under [AGPL-3.0-only](LICENSE), without a plugin exception.
Third-party dependencies retain their licenses and notices. The license applies
to the program, not ordinary user notes. Distributors must provide corresponding
source as required by the license, including applicable network-use obligations.

Zorid is independent of Obsidian. Proprietary reference bundles and recovered
implementation assets stay outside this repository. Historical reference audits
are evidence, not source or a claim of complete compatibility.
