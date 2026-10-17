# Zorid

An original, AGPLv3-licensed Markdown workspace pursuing full feature, UI, UX, vault,
and plugin compatibility with a fresh Obsidian 1.14.4 installation. Desktop uses
Electron; the mobile target uses Capacitor; the editor uses CodeMirror 6. The
renderer is TypeScript and DOM/CSS, built with Vite following REA's bundle
format finding. Electron is pinned to 44.8.0; desktop releases require macOS 13 or newer.
Other exact upstream dependency versions and the authoring framework remain
partially unverified.

**This is work in progress, not a full-parity release.** Track the complete target,
missing features, and verification gates in [the parity matrix](docs/parity.md).
The current implementation includes a workspace shell, editable notes, basic live
preview/reading view, vault operations, linking/backlinks, search, tabs/splits,
recovery drafts, and platform storage adapters. These are original implementations;
visual and interaction equivalence have not yet been demonstrated.

## Development

Use Node.js 26+ and pnpm. Node 26 is currently used for the TypeScript tests.
The checked-in pnpm lockfile pins the current dependency resolution.

```sh
pnpm install --frozen-lockfile
pnpm run desktop:install # macOS; explicitly installs/verifies the runtime
pnpm test
pnpm run build
pnpm run desktop
```

For development, run `npm run dev`, then `npm run desktop:dev` in another terminal.
The browser development view uses a separate, device-local preview vault; Electron
opens ordinary vault folders. Notes remain Markdown files.

The native projects are already generated. To update their renderer assets:

```sh
npm run mobile:sync
```

See [platform setup](docs/platforms.md) for native permissions and build limitations.
The iOS and Android projects are generated and synchronized. Native compilation
and device operation are not yet verified.

## Project layout

- `src/core`: vault operations, path handling, note metadata, link resolution.
- `src/ui`: workspace, CodeMirror integration, reading renderer, recovery buffers.
- `src/platform`: Electron bridge, Capacitor storage, browser preview storage.
- `src/plugins`: event/component/plugin lifecycle foundations; not yet a compatible
  third-party plugin loader or complete Obsidian API.
- `desktop`: original Electron entry point, preload, and filesystem service.
- `tests`: core, platform, buffer, plugin lifecycle, and workspace integration tests.
- `docs/reference-evidence.md`: REA evidence, coverage, and unresolved questions.

## Current validation limits

Dependencies are installed and the TypeScript/Vite production build passes.
The automated suite includes real CodeMirror transactions under jsdom, properties,
embeds, vault/adapters, recovery, and workspace integration. It does not establish
native input behavior, layout, or reference parity. The Electron executable was
installed from its checksum-verified cache; launching from the agent session
aborted during macOS application registration before the workspace loaded. A
user-launched instance subsequently passed a bounded native smoke test for vault
opening, Reading mode, embedded-task persistence, and image-dialog opening/closing.
See [desktop validation](docs/desktop-validation.md) for observations and limits.

Both Capacitor projects sync successfully. iOS still needs remote Swift packages
resolved and a native build; Android needs its SDK, Gradle distribution, and Java 21.
See [platform validation](docs/platforms.md). Reference Android package evidence
is recorded separately from native runtime tests in [the Android report](docs/android-reference.md).

`node scripts/benchmark-core.ts` measures synthetic in-memory workloads. It is not
an end-to-end performance result or a comparison with Obsidian. Properties and
reading-view note/heading/block embeds are functional foundations; live editable
embeds, PDF/audio/video viewers, a persistent property-type registry, and complete
Markdown/editor behavior remain unfinished. Image tabs and reading-view image embeds
have original resource loading and lightbox implementations; native visual and
interaction comparison remains outstanding.

The proprietary Obsidian bundles used for inspection are outside this repository.
REA analysis is evidence about the reference, not source for this project. No
recovered Obsidian implementation, fonts, icons, or CSS are part of the AGPLv3-licensed
source. Zorid is independent of Obsidian and is not an official Obsidian product.

## License

Copyright (c) 2026 Zorid contributors. Zorid is licensed under the
[GNU Affero General Public License, version 3 only](LICENSE)
(`AGPL-3.0-only`), without any additional plugin exception. Third-party
dependencies retain their own licenses and notices.

Zorid is distributed without any warranty. Distributors must provide corresponding
source as required by the license. Modified versions used over a network must
offer corresponding source to the users interacting with them, as specified in
section 13. This license applies to the program, not ordinary notes or other user
data created or stored with it.
