# Passive mobile editor host integration

Root isolated mobile-web-router-2 base canonicalaab1d5c8, source264fb506,
original7a5caae1,2026-10-18. Only two new module/test files; both byte-identical
approved original. Existing editor guards, Workspace, core and platform unchanged.
Independent reviewer a0c7 approves exact two-file scope in msg_697f98e18561.
Root read actual7/7 DOM/CM log and author fullTS session48435 exit0 attribution;
source/log SHA manifest verifies4/4. Persistent artifacts/report in
`/Users/ctk/orca/artifacts/zorid-native-20261018/mobile-document-editor-host/`.

Actual two CodeMirror instances demonstrate passive construction, writer switch,
canceled freeze retaining editor/selection/inner and outer scroll/undo, same-entry
external snapshot mapping, stale callbacks/late transfer rejection and retryable
owned cleanup. No test or compiler was repeated for byte-identical source.

The thin host reuses existing createEditor with managed inactive construction,
receives snapshots/current/writer predicates from Workspace and owns only wrapper,
editor and scoped hook cleanup. It does not load/replay/save NoteBuffer, claim a
client, parse Markdown independently or own routing/admission. Workspace must
supply and guard title/property hooks/services, canonical buffer/save, actual view
window cap and native toolbar bridge. No user-visible routing activation is added.
Composed Workspace/bridge, WebKit two-live-view gestures, keyboard/IME and physical
phone acceptance remain separate required gates.
