# Vite renderer migration

User authorized migration on2026-10-17. Root owns isolated
`tingkai-c/vite-renderer-migration`; frozen candidate103428be. Native owner is
reconciling reviewed focus/silent-refresh source for one combined iOS proof.
All affected client gates pass; integrated on main165cf17a.
Main manager-lock preservation60efe609 passes frozen install0, typecheck0 and
73 affected checks. Original manager lock document is byte-identical; the app
lock/resolutions are unchanged. Vite is now the application default. Latest product
sequence: Vite → Bases/tasks/calendar → Stage5; mobile UX continues in parallel.

## Build boundary

- `pnpm dev`: loopback5173, CSS HMR and existing JS full-reload behavior. No main
  module self-acceptance or promise of preserving editor state across JS reload.
- `pnpm build`: typecheck then Vite production browser build; automatic Rust/WASM
  source/artifact fingerprint validation before substituting module URL.
- `pnpm build:desktop`: typecheck then Vite native mode, no browser WASM toolchain.
  Electron main/preload and Rust bindings remain separately owned.
- `mobile/scripts/ios-build.sh`: same native renderer command, cap copy ios only,
  existing locked Rust/static linkage and Xcode build, no native/SPM rewriting.
- All packaged entry/CSS/chunks use relative URLs from dist/index.html. PDF/math/
  Prism/generatedWASM files retain exact bytes/licenses and local lib paths.
- Rust additions/deletions/changes restart the dev configuration so content-addressed
  module/asset defines remain matched. Rust-aware build --watch is explicitly
  rejected; use dev. Fixture mode remains explicit and native mode bypasses it.
- Legacy isolated prototype runners still use Webpack dependencies/wrapper plugins;
  application scripts and root configuration use Vite exclusively. These harnesses
  are not an alternate production application path.

## Observed acceptance

| Gate | Result |
| --- | --- |
| Pinned dependencies | Vite8.3.4/directAcorn8.17.0; existing app resolutions preserved; isolated frozen install0 |
| Vendor identity |232PDF+72math exact old/new extraction paths/order/sizes/hashes; all307 PDF/math/Prism assets byte-equal in actual Vite output |
| Asset/worker/CSP/staging checks |34/34 pass; two additional dev MIME/source-invalidation checks pass |
| Combined native/shared source | Full TypeScript0,272/272 focused checks; independent source audit passes |
| Native renderer build | Final production build1.05s, success; not a benchmark or speedup claim |
| Actual Electron file renderer | Loaded candidate dist; note editor/math/code; save exact146 bytes including raw math/code, then test app37382 closed0 |
| Actual production browser | Default Rust/WASM startup, create, rename, save, reload; persisted89-character note; rendered math1 and actual Prism keyword/number/operator tokens; no observed warn/error logs |
| Actual dev browser | Default Rust/WASM startup, create/save/reload; persisted64-character note; math1 and Prismkeyword1; no observed warn/error logs |
| Real desktop staging/archive | PASS347files, actual arm64Rusthost; ASAR verified against exact input manifest. Pinned official RPC notices independently source-reviewed; strict notice guard retained |
| iOS renderer | PASS build7/sourcece1e0ace: create/save99physicalbytes/reopen stableID; actual mathglyphs/PrismPython; validPDF2pages; existing-list silentrefresh. Owner reportedmsg67c02132f86d; appclosed, slotreturned |

Root test browser tabs are closed, servers10517/18756 stopped130, Electronclosed0.
No Rust semantic changes were needed by the migration. Unchanged final Stage4WASM
cache was copied then accepted only through existing fingerprint and artifact hash
validation; generated SHAe65d47a4… remains the accepted Stage4 binary.

First production browser attempt exposed config bundling of CJS parser require as
a file URL; Node createRequire now keeps helper loading external. Regression tests
exercise actual Vite asset emission and strict generated-module validation. Existing
stale RPC export inventory was strengthened to declared RPC functions/page methods;
no fixture/export validation was removed.

The real desktop staging check also found missing desktop document-semantics.cjs
in the older explicit inventory; it is now included and an independent full local
require-closure audit found no remaining omissions. No release/signing/publication
claim follows from local source or staging checks. No mobile focus/search or
production sync/security completion is implied by the bundler migration.

Final iOS evidence: Simulator86404 build0, install/launch67696 exit0; actual save
proof59873, reopen70052, PDF29423 and refresh33719 pass. Screenshots were viewed by
native owner at /private/tmp/mobile-v7-vite-math-code.png and mobile-v7-vite-pdf.png.
Keyboard focus matrix and new native search/Settings remain separate pending work.
The existing disposable vault also reports incomplete reconciliation of newly copied
fixtures; Vite source does not conceal it or establish data-loss causality. Existing
listed notes and PDF supply this bundler gate. No phone7 runtime claim yet.
