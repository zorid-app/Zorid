'use strict';
const IDS = new Set(['new-window', 'close-tab']);
/** Captions only: workspace owns key events, including recording inside Settings.
 * Never register a second native accelerator that can bypass renderer scopes. */
function validateMenuHotkeys(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError('Invalid menu hotkeys');
  const result = Object.create(null);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'id,shortcut' ||
        !IDS.has(item.id) || Object.hasOwn(result, item.id) || typeof item.shortcut !== 'string' || item.shortcut.length > 240 || /[\x00-\x1f\x7f]/.test(item.shortcut)) throw new TypeError('Invalid menu hotkey');
    result[item.id] = item.shortcut;
  }
  return result;
}
function workspaceFileMenu(hints, actions) {
  const label = (id, name) => (name + (hints?.[id] ? ` (${hints[id]})` : '')).replace(/&/g, '&&');
  return { label:'File', submenu:[
    { label:label('new-window','New window'), click:actions.newWindow },
    { label:label('close-tab','Close tab'), click:actions.closeTab },
    { type:'separator' },
    // Do not use role:close here: it implicitly registers Cmd/Ctrl+W.
    { label:'Close window', click:actions.closeWindow },
  ] };
}
module.exports = { validateMenuHotkeys, workspaceFileMenu };
