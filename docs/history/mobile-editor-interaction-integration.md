# Retained editor interaction source integration

Root isolated mobile-web-router-2 (Orca display mobile-web-integration), base
canonical bd2c2af8, 2026-10-18. This reserve has no second router implementation
owner. Source owner mobile-editor-interaction remains the original API author.

Ordered source originals71c362b0, ec8ca471,12a8fa72,047d5687 plus historical
report commits51a1f7a5/fd61a42e/12b17257 compose without conflict. Isolated source
commits c38990ad/185ece58/5f22bc79/00c93d24 preserve exact approved files.
Root compared the entire src/tests tree to047d5687: zero difference. Canonical
0ccab450→bd2c2af8 had no frontend/test/package/TypeScript configuration changes.
No additional compiler campaign is needed merely to repeat an identical source.

Independent reviewer term_a0c7b316 approval msg_8c29b2e29e46 covers exact047d
and cumulative scoped changes. Reviewer ran no checks; inspected source and the
actual91-test log. Root also read the91/91 result, zero failures/skips, and hashed
log469bfe4c57bcfa3ad00a04ca1b8d9dd25f212c11f823f214827dbac0bbba6ee5.
Author final report80cb19b7 attributes the exact bounded full TypeScript
command `node --max-old-space-size=768 node_modules/typescript/bin/tsc --noEmit`
to exit0. Root read its empty log (SHA256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855).
Both exact logs were copied without rerun into persistent root artifacts at
`/Users/ctk/orca/artifacts/zorid-native-20261018/editor-interaction-integration/`.
Final report is retained in mobile-editor-interaction-gating.md.
Source approval does not establish router/mobile/native acceptance.

Construction-time canMutate/interactionState opt-in is required for retained
editors, including the first active editor. Inactive surfaces deny editing/focus;
temporary writer freeze keeps keyboard focus. Router revokes authority before
setters and restores only after admission. Same-value setters invalidate old
async authoring and refresh child readOnly/editable/focus queues. Imports already
dispatched to storage may finish; revoked callbacks cannot insert or start the
remaining batch. Private external snapshot synchronization still maps undo.

Menus are per-editor abortable and epoch-validated before effects and focus.
Guarded requests use the existing renderer menu, preserving browser clipboard
limitations; default unmanaged desktop menus retain native behavior. Calling a
setter later cannot retroactively protect a native menu opened before opt-in.
The router must satisfy this consuming contract, not assume the optional setter
alone fences every old menu. No IPC/native role API or generic menu rewrite.

Pending composed requirements: actual router/window consumption, at most three
live runtimes and one writer, two actual WebKit editor views during swipe,
cancel/commit state retention, keyboard/IME and physical UI. Dev19 stays unchanged.
