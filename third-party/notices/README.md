# Audited npm distribution notices

These checked-in notices cover exact npm releases whose published packages omit
standalone license files. `scripts/desktop-notices.mjs` includes their full texts
in `THIRD_PARTY_NOTICES.txt` only when package name, version, declared license and
repository match the audited record. It checks the source commit and every
notice SHA-256 before use. Missing or changed notice files remain errors; this is
not a generic Apache fallback. A package upgrade requires another audit.

| Packages | Official tag | Immutable upstream commit |
| --- | --- | --- |
| `@bufbuild/protobuf@2.16.0` | `bufbuild/protobuf-es` `v2.16.0` | `b3b232f7f466eda27c66e8f63c82f930578b6cc6` |
| `@connectrpc/connect@2.2.0`, `@connectrpc/connect-web@2.2.0` | `connectrpc/connect-es` `v2.2.0` | `378bb8fde1209afc3ab6a9b0aa97c00d0db58c24` |

Each `provenance.json` records official raw source URLs, complete source-file
hashes, copied notice hashes, and line ranges for an extracted header. Release
tag references were resolved with GitHub's official git-ref API; notice files
were fetched from immutable commit URLs. Only license and notice text is vendored here.

Protobuf declares `(Apache-2.0 AND BSD-3-Clause)`. Its repository `LICENSE` supplies
the complete Apache text and Buf copyright. The Google 2008 BSD notice is copied
byte-for-byte, retaining comment prefixes, from lines 1–32 of
`packages/protobuf/src/wire/varint.ts`. That exact notice also prefixes the
installed `dist/esm/wire/varint.js` and is retained independently of minification
or tree shaking. The Connect repository `LICENSE` includes its full Apache text
and Connect Authors copyright. Both pinned upstream trees contain only the root
`LICENSE` as a standalone license/notice file. Installed runtime header inspection
found Buf, Google, and Connect Authors copyrights, covered by these copies.

This source audit preserves distributed notices; it does not establish release,
code-signing, native runtime or legal compatibility verification.
