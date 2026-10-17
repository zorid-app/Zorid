# Canvas resize and Bases Table integration checkpoint

This aggregate starts from verified main `f718f61`. It combines reviewed Canvas
edge/corner resizing `1247482`, Bases Table range selection/copy `e7367f6`, and
dedicated Canvas resize reference ledger `0ce60a9`. The feature source checkpoint
is `04383ca`; `df66a05` adds only the reference documentation.

Canvas resize previews retain live card owners, then commit an atomic geometry
edit through the existing save/history path. Cancellation restores projection
without committing source. Bases Table ranges retain cell/group identity and
export their supported clipboard representations without taking over native
editable-control selection. Neither slice changes shared NoteBuffer persistence,
Base session/controller write validation, recent Markdown-table rectangle guards,
or the shared editor-hotkey preference source.

The initial combined focused run passed 106 tests. Independent aggregate review
passed 12 selected actual-CodeMirror, Workspace and DOM boundary checks, including
retained editor/media owners through resize and undo, failed geometry persistence
retry, rectangular formatting/context menus, live and parked Canvas hotkeys, and
Base range versus native copy/edit ownership. The production delta passed a
separate source credential/private-path scan.

No native app, browser automation, packaging or mobile test was launched by this
integration lane. The dedicated resize reference ledger records snapping,
geometry and interaction limits plus its native checklist. Bases raw-metadata
clipboard payloads, paste/clear, native geometry and remaining pointer edges are
still outside the selected Table interaction slice. Pending Base embed lifecycle
work and future hotkey-default changes remain separate. The PDF outline menu
change is inherited from the reconciled main checkpoint below, not part of the
authored Canvas/Table feature slice.

## Main reconciliation and pending gate

The isolated candidate merged committed main `c724601` without conflicts as
`03e3c1bb5206ef902fc929ec3659470e9b2b4818`. Main adds the independently reviewed
PDF outline menu change `c47952d` and coordination/browser/restart documentation.
Its only production changes are `src/ui/pdf-sidebar.ts` and `src/ui/pdf-view.ts`;
the reviewed Canvas resize and Bases Table sources are unchanged by the merge.
No shared-core changes or uncommitted primary-checkout files were incorporated.

The inherited PDF handlers resolve outline destinations without navigation,
revalidate document/sidebar/menu ownership after awaits, and retire superseded
menu commands. Canvas geometry changes keep existing card/view owners and DOM;
they do not replace the PDF owner or loosen its lifetime checks. The Bases Table
slice has no PDF interaction or persistence changes.

After reconciliation, six selected PDF outline/menu and retained Canvas owner
checks passed serially (no failures; 1.356 seconds). Independent reconciliation
review confirmed the unchanged Canvas/Bases source and passed five selected
owner/resize/menu retirement checks. These bounded checks do not replace the
pending full integration gate.

Full validation is deliberately pending the explicitly acknowledged cross-session
heavy-work slot on the 8 GB host. Run the following serially in this candidate:

1. `node --test --test-concurrency=2 tests/*.test.*`
2. `node ../../node_modules/typescript/bin/tsc --noEmit --project ./tsconfig.json`
3. `node ../../node_modules/webpack-cli/bin/cli.js --config ./webpack.config.cjs --mode production`

Record terminal results and the exact tested source commit before requesting
canonical-main promotion. Root remains the sole main integrator and native
verification owner; this reconciliation does not establish native/reference
geometry or clipboard parity.
