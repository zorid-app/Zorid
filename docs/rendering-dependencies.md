# Upstream rendering dependencies

The supplied Obsidian 1.14.4 ASAR has SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.
The restored extraction is recorded by REA evidence
`ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`.
Recovered files remain outside the project.

The packaged `lib/mathjax/obsidian-mathjax.js` identifies MathJax 4.1.3;
its SHA-256 is `ac00d774192009417b8fa50412f4b27f94426014e7526fe1151276a9784de965`.
The renderer config uses CHTML, the TeX font, and the mhchem font extension.
Zorid pins official npm packages `mathjax`, `@mathjax/mathjax-tex-font`, and
`@mathjax/mathjax-mhchem-font-extension` to 4.1.3. Registry metadata was checked
before installation: all three were published on 2026-07-03. Their integrity
values are retained in `pnpm-lock.yaml`; the existing release-age policy was
not changed. The distribution also depends on the upstream New Computer Modern
font; its presence alone does not select it as Zorid's configured font.

The packaged `lib/prism.min.js` header identifies PrismJS 1.30.0;
its SHA-256 is `9389ca2110991b037228c190018c94abcf25d1af0ad32fc51b78263660acbddb`.
Zorid pins the official `prismjs` npm package to 1.30.0. The reference loads an
all-language bundle lazily; Zorid's asset construction must use upstream package
components and their dependency metadata, not copy the recovered bundle.

These dependency identities establish an implementation input, not rendering
parity. Local asset emission, lazy loading, font selection, language coverage,
editing behavior, performance, and native/mobile rendering need separate
validation as their modules are integrated.
