'use strict';

const EDIT_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Invalid context menu descriptor');
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid menu label');
  return value;
}
function validateContextMenu(request) {
  object(request, ['x', 'y', 'items']);
  if (![request.x, request.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) throw new TypeError('Invalid menu position');
  const ids = new Set();
  let count = 0;
  function items(values, depth) {
    if (!Array.isArray(values) || values.length > 100 || depth > 4) throw new TypeError('Invalid menu size');
    return Array.from(values, value => {
      if (++count > 100) throw new TypeError('Invalid menu size');
      object(value, ['type', 'id', 'label', 'enabled', 'checked', 'role', 'submenu']);
      if (value.type === 'separator') {
        if (Object.keys(value).length !== 1) throw new TypeError('Invalid separator');
        return { type: 'separator' };
      }
      if (value.type !== undefined || value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('Invalid menu item');
      const enabled = value.enabled !== false;
      if (value.role !== undefined) {
        if (!EDIT_ROLES.has(value.role) || ['id', 'checked', 'submenu'].some(key => Object.hasOwn(value, key))) throw new TypeError('Invalid menu role');
        return { role: value.role, ...(value.label === undefined ? {} : { label: label(value.label) }), enabled };
      }
      const title = label(value.label);
      if (value.submenu !== undefined) {
        if (['id', 'checked'].some(key => Object.hasOwn(value, key))) throw new TypeError('Invalid submenu');
        const submenu = items(value.submenu, depth + 1);
        if (!submenu.length) throw new TypeError('Empty submenu');
        return { label: title, enabled, submenu };
      }
      if (typeof value.id !== 'string' || !ID.test(value.id) || ids.has(value.id) ||
          value.checked !== undefined && typeof value.checked !== 'boolean') throw new TypeError('Invalid menu action');
      ids.add(value.id);
      return { id: value.id, label: title, enabled, ...(value.checked === undefined ? {} : { checked: value.checked }) };
    });
  }
  return { x: request.x, y: request.y, items: items(request.items, 0) };
}

// Electron is injected so validation and popup lifetimes can be tested without
// launching an application or importing a privileged runtime into the renderer.
function createContextMenuController(Menu) {
  const active = new WeakMap();
  function close(owner) { active.get(owner)?.cancel(); }
  function popup(owner, rawRequest) {
    const request = validateContextMenu(rawRequest);
    close(owner);
    if (!request.items.length || owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      let menu;
      const contents = owner.webContents;
      const finish = (id = null, error) => {
        if (settled) return;
        settled = true;
        if (active.get(owner) === session) active.delete(owner);
        owner.removeListener('closed', cancel);
        contents.removeListener('destroyed', cancel);
        contents.removeListener('render-process-gone', cancel);
        contents.removeListener('did-start-navigation', navigate);
        if (error) reject(error); else resolve(id);
      };
      const cancel = () => {
        finish();
        try { menu?.closePopup(owner); } catch { /* Window may already be gone. */ }
      };
      const navigate = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) cancel(); };
      const session = { cancel };
      const template = (entries, parentEnabled = true) => entries.map(item => {
        if (item.type === 'separator') return { type: 'separator' };
        const enabled = parentEnabled && item.enabled;
        // Escape mnemonic syntax: descriptors carry literal user-facing text.
        const title = item.label === undefined ? {} : { label: item.label.replace(/&/g, '&&') };
        if (item.role) return { ...title, role: item.role, enabled };
        if (item.submenu) return { ...title, enabled, submenu: template(item.submenu, enabled) };
        return { ...title, enabled, ...(item.checked === undefined ? {} : { type: 'checkbox', checked: item.checked }),
          click: () => { if (enabled) finish(item.id); } };
      });
      active.set(owner, session);
      owner.once('closed', cancel);
      contents.once('destroyed', cancel);
      contents.once('render-process-gone', cancel);
      contents.on('did-start-navigation', navigate);
      try {
        menu = Menu.buildFromTemplate(template(request.items));
        const zoom = contents.getZoomFactor();
        const [width, height] = owner.getContentSize();
        const coordinate = (value, limit) => Math.max(0, Math.min(Math.max(0, limit - 1), Math.round(value * zoom)));
        menu.popup({ window: owner, x: coordinate(request.x, width), y: coordinate(request.y, height),
          // Defer dismissal one turn so a same-turn item click wins even if a
          // platform reports popup closure before delivering the selection.
          callback: () => setImmediate(() => finish()) });
      } catch (error) { finish(null, error); }
    });
  }
  return { popup, close };
}

module.exports = { validateContextMenu, createContextMenuController };
