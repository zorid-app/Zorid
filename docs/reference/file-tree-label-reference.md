# File-tree filename display

The user's latest instruction takes priority over reference parity: show the file type only when Zorid does not recognize it. The original implementation therefore hides recognized filename suffixes and retains unknown suffixes in the filename. It does not add reference-style badges.

Recognition reuses the existing image classifier (`isImage`) and audio/video classifier (`mediaKind`), plus the structured formats `.md`, `.pdf`, `.canvas` and `.base`. These have existing editors, viewers, media embeds or a Bases parser/query implementation. Recognition is not a claim that every format has a complete standalone viewer or that every codec is available on every platform. In particular, direct audio/video and Bases pane support is separate work. The singular `.base` extension is recognized; `.bases`, text/code formats and unregistered media/image extensions retain their suffixes.

The decision is case-insensitive. Only the final recognized suffix is hidden, preserving earlier dots and the original basename spelling. Folder names are untouched, including folder names ending in a known file suffix. Extensionless names, trailing dots and dotfiles with no basename are untouched. Full paths remain in the row's tooltip and accessible name so identical visible basenames remain distinguishable. Inline rename continues to show the complete filename, including its extension, and retains the existing persistence behavior. Existing filename ellipsis styling is sufficient; no new CSS is needed.

## Reference comparison

The reverse-engineer-anything skill was used for focused read-only inspection of the retained Obsidian 1.14.4 artifact. This reused REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, whose expanded semantic graph was incomplete. `app.js` SHA-256 is `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Findings below are ordinary static source readings, not new REA semantic or runtime observations. Sources remain outside the repository at `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`; no recovered implementation or assets were copied.

Zero-based decoded-text character offsets:

- `app.js` 1258760–1259370: distinct image/audio/video/PDF/Markdown/Canvas/Bases extension groups; Markdown's group contains only `md`.
- `app.js` 1502950–1503690: file titles use the basename. Markdown omits the extension tag; other files display a separate extension tag. Registered view support controls the unsupported class and visibility independently of this tag choice.
- `app.css` 499078–500000: extension tags use small uppercase text, while the title has its own clipping/wrapping rules. The reference stylesheet does not justify imposing a badge on the corrected user request.

Thus hiding recognized suffixes without badges is an intentional user-directed difference from the inspected reference. Reference DOM/runtime rendering, exact casing of the underlying extension property and narrow-width badge layout were not executed or fully audited, because the user's correction makes those badge details irrelevant to this implementation.

## Verification

Original focused fixtures cover every currently recognized image/audio/video suffix, structured formats, upper-case variants, unknown suffixes, multi-dot names, extensionless files and folders. A real Workspace jsdom fixture verifies same-basename files retain distinct full-path accessible names/tooltips, and that entering/canceling inline rename reveals/restores the complete/display filename without changing the file. Independent review also found an inherited-property collision in the existing MIME lookup (`constructor`/`__proto__`); an own-property check and unknown-file regressions prevent those names from crashing the explorer. All 24 focused helper and file-tree host tests passed, followed by all 8 attachment tests and a strict TypeScript check scoped to the helper and its dependencies. Native visual verification remains a separate integration task.
