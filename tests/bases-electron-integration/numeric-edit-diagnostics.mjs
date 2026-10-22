// Passive DOM-only receipts: missing markers stay null, and no version equality
// is an admission condition. Reading a frame must never wait for or repair state.
export function numericEditFrame(document, cellSelector) {
  const session = document.querySelector('.pane.is-active .bases-session');
  const table = session?.querySelector('.zorid-bases-table');
  const cells = [...document.querySelectorAll(cellSelector)];
  const cell = cells[0];
  const editors = cell ? [...cell.querySelectorAll('input:not([type="checkbox"]),textarea')] : [];
  const focused = document.activeElement;
  const attr = (node, name) => node?.getAttribute(name) ?? null;
  return {
    controllerVersion: attr(session, 'data-base-controller-version'),
    controllerUpdating: attr(session, 'data-base-controller-updating'),
    controllerError: attr(session, 'data-base-controller-error'),
    renderedVersion: attr(table, 'data-base-rendered-version'),
    widgetVersion: attr(cell, 'data-base-widget-version'),
    busy: attr(session?.querySelector('.bases-session-content'), 'aria-busy'),
    gridRowCount: attr(table, 'aria-rowcount'),
    cellCount: cells.length,
    editorCount: editors.length,
    mountedCellCount: table?.querySelectorAll('[role="gridcell"][data-path]').length ?? 0,
    draftCount: session?.querySelectorAll('[data-base-editing="draft"]').length ?? 0,
    pendingCount: session?.querySelectorAll('[data-base-editing="pending"]').length ?? 0,
    cell: cell ? { connected: cell.isConnected, path: attr(cell, 'data-path'), property: attr(cell, 'data-property'), editing: attr(cell, 'data-base-editing'), title: attr(cell, 'title') } : null,
    editors: editors.map(editor => ({ value: editor.value, disabled: editor.disabled, invalid: attr(editor, 'aria-invalid'), focused: focused === editor })),
    focus: { tag: focused?.tagName ?? null, role: attr(focused, 'role'), label: attr(focused, 'aria-label'), path: attr(focused?.closest('[data-path]'), 'data-path'), property: attr(focused?.closest('[data-property]'), 'data-property'), insideCell: !!cell?.contains(focused) },
  };
}
