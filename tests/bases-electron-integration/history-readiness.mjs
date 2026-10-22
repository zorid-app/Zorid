// Public DOM readiness for Base history shortcuts. A saved-file read alone does
// not establish completion of the command's publication/acknowledgement tail.
export function baseHistoryReadiness(document, path, property) {
  const session = document.querySelector('.pane.is-active .bases-session');
  const content = session?.querySelector('.bases-session-content');
  const table = content?.querySelector('.zorid-bases-table');
  const focused = document.activeElement;
  const attr = (element, name) => element?.getAttribute(name) ?? null;
  const controllerVersion = attr(session, 'data-base-controller-version');
  const renderedVersion = attr(table, 'data-base-rendered-version');
  const widgetVersion = attr(focused, 'data-base-widget-version');
  const busy = attr(content, 'aria-busy');
  const updating = attr(session, 'data-base-controller-updating');
  const error = attr(session, 'data-base-controller-error');
  const ownedCell = !!focused?.isConnected && !!table?.contains(focused) && attr(focused, 'role') === 'gridcell'
    && attr(focused, 'data-path') === path && attr(focused, 'data-property') === property;
  const editing = !!session?.querySelector('[data-base-editing]');
  const disabled = !!focused?.closest('[aria-disabled="true"],[inert]') || !!focused?.matches(':disabled');
  const ready = ownedCell && !editing && !disabled && busy === 'false' && updating === 'false' && error === 'false'
    && /^\d+$/.test(controllerVersion ?? '') && controllerVersion === renderedVersion && renderedVersion === widgetVersion;
  return { ready, observedAt: Date.now(), controllerVersion, renderedVersion, widgetVersion, busy, updating, error, ownedCell, editing, disabled,
    focus: { role: attr(focused, 'role'), path: attr(focused, 'data-path'), property: attr(focused, 'data-property') } };
}

export async function waitForBaseHistoryReady(c, path, property, command) {
  const receipt = await c.ui.wait(`const frame=(${baseHistoryReadiness.toString()})(document,${JSON.stringify(path)},${JSON.stringify(property)});return frame.ready?frame:false;`, `Current focused Base cell ready for ${command}`, 45000);
  c.evidence.actions.push({ action: 'base-history-ready', command, ...receipt });
}
