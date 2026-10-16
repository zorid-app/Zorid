'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateContextMenu, createContextMenuController } = require('../desktop/context-menu.cjs');
const request = (items = [{ id: 'file.open', label: 'Open' }]) => ({ x: 40, y: 60, items });
function setup() {
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  owner.getContentSize = () => [800, 600];
  const contents = owner.webContents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.getZoomFactor = () => 1.5;
  const menus = [];
  const Menu = { buildFromTemplate(template) {
    const menu = { template, closed: 0, popup(options) { this.options = options; }, closePopup(window) { assert.equal(window, owner); this.closed++; this.options.callback(); } };
    menus.push(menu); return menu;
  } };
  return { owner, contents, menus, controller: createContextMenuController(Menu) };
}

test('only bounded labels, action IDs, edit roles and submenu data cross the menu boundary', () => {
  const input = request([{ label: 'Edit', submenu: [{ role: 'copy' }, { id: 'mark:on', label: 'Checked', checked: true }] }, { type: 'separator' }]);
  const result = validateContextMenu(input);
  assert.equal(result.items[0].submenu[1].checked, true);
  assert.notEqual(result.items, input.items);
  for (const invalid of [
    { ...request(), x: NaN }, { ...request(), y: Infinity }, { ...request(), channel: 'shell:exec' },
    request([{ role: 'quit' }]), request([{ role: 'copy', id: 'fake' }]),
    request([{ id: 'a', label: 'A', click: 'code' }]), request([{ id: '../bad space', label: 'A' }]),
    request([{ id: 'a', label: 'A\nB' }]), request([{ id: 'a', label: 'x'.repeat(201) }]),
    request([{ id: 'a', label: 'A', enabled: 'yes' }]), request([{ id: 'a', label: 'A', checked: 1 }]),
    request([{ id: 'a', label: 'A' }, { id: 'a', label: 'Duplicate' }]),
    request([{ type: 'separator', label: 'Bad' }]), request([{ label: 'Empty', submenu: [] }]),
    request(new Array(2)), request(Array.from({ length: 101 }, (_, index) => ({ id: `a${index}`, label: 'A' }))),
  ]) assert.throws(() => validateContextMenu(invalid), TypeError);
  let nested = [{ id: 'a', label: 'A' }];
  for (let index = 0; index < 5; index++) nested = [{ label: 'Nested', submenu: nested }];
  assert.throws(() => validateContextMenu(request(nested)), /size/);
});

test('native actions return IDs; disabled ancestors and mnemonic syntax are contained', async () => {
  const { controller, owner, menus } = setup();
  const result = controller.popup(owner, request([{ id: 'one', label: 'A & B', checked: true }, { label: 'Disabled', enabled: false, submenu: [{ id: 'two', label: 'Two' }] }]));
  const menu = menus[0];
  assert.equal(menu.template[0].label, 'A && B');
  assert.equal(menu.template[0].type, 'checkbox');
  assert.equal(menu.template[1].submenu[0].enabled, false);
  menu.template[1].submenu[0].click();
  menu.template[0].click();
  assert.equal(await result, 'one');
  assert.equal(owner.listenerCount('closed'), 0);
});

test('popup coordinates use window zoom, clamp to content and target their owning window', async () => {
  const { controller, owner, menus } = setup();
  const result = controller.popup(owner, { ...request(), x: -8, y: 1000 });
  assert.deepEqual({ x: menus[0].options.x, y: menus[0].options.y, owner: menus[0].options.window }, { x: 0, y: 599, owner });
  menus[0].options.callback();
  assert.equal(await result, null);
  const second = controller.popup(owner, request());
  assert.equal(menus[1].options.x, 60); assert.equal(menus[1].options.y, 90);
  menus[1].options.callback(); await second;
});

test('dismissal settles and same-turn native click wins a closure callback', async () => {
  const { controller, owner, menus } = setup();
  const result = controller.popup(owner, request());
  menus[0].options.callback();
  menus[0].template[0].click();
  assert.equal(await result, 'file.open');
});

test('a newer popup cancels the old one; stale callbacks cannot close the new session', async () => {
  const { controller, owner, menus, contents } = setup();
  const first = controller.popup(owner, request());
  const second = controller.popup(owner, request([{ id: 'new', label: 'New' }]));
  assert.equal(await first, null); assert.equal(menus[0].closed, 1);
  menus[0].template[0].click(); menus[0].options.callback();
  menus[1].template[0].click();
  assert.equal(await second, 'new');
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
});

test('navigation, renderer loss and owner closure cancel outstanding menu promises', async () => {
  for (const kind of ['navigate', 'crash', 'close', 'destroy']) {
    const { controller, owner, contents, menus } = setup();
    const result = controller.popup(owner, request());
    if (kind === 'navigate') contents.emit('did-start-navigation', {}, 'file:///new', false, true);
    if (kind === 'crash') contents.emit('render-process-gone');
    if (kind === 'close') owner.emit('closed');
    if (kind === 'destroy') contents.emit('destroyed');
    assert.equal(await result, null, kind);
    assert.equal(menus[0].closed, 1);
    assert.equal(contents.listenerCount('did-start-navigation'), 0);
  }
});

test('native popup errors reject and remove lifecycle listeners', async () => {
  const { owner, contents } = setup();
  const controller = createContextMenuController({ buildFromTemplate() { throw new Error('popup failed'); } });
  await assert.rejects(controller.popup(owner, request()), /popup failed/);
  assert.equal(owner.listenerCount('closed'), 0);
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
});

test('preload exposes a fixed menu channel without exposing ipcRenderer', async () => {
  let bridge;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'zorid'); bridge = value; } },
    ipcRenderer: { invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve('chosen'); } }, webUtils: {} };
  vm.runInNewContext(readFileSync(new URL('../desktop/preload.cjs', `file://${__filename}`), 'utf8'), { require(name) { assert.equal(name, 'electron'); return electron; } });
  const input = request();
  assert.equal(await bridge.showContextMenu(input), 'chosen');
  assert.deepEqual(calls, [['zorid:showContextMenu', input]]);
  assert.equal(bridge.ipcRenderer, undefined); assert.equal(Object.isFrozen(bridge), true);
});

test('main IPC rejects a foreign sender, child frame and unexpected document before opening a menu', async () => {
  const handlers = new Map();
  let ready, window, popupOptions;
  const directory = path.resolve(__dirname, '../desktop');
  const packaged = pathToFileURL(path.join(directory, '../dist/index.html')).href;
  class Window extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: packaged }, isDestroyed: () => false, getZoomFactor: () => 1,
        setWindowOpenHandler() {},
      });
    }
    isDestroyed() { return false; }
    getContentSize() { return [800, 600]; }
    async loadFile() {}
    static getAllWindows() { return [window]; }
  }
  const electron = {
    app: { setName() {}, whenReady: () => ({ then(callback) { ready = callback; } }), getPath: () => '/unused-test-path', on() {} },
    BrowserWindow: Window, ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    Menu: { setApplicationMenu() {}, buildFromTemplate() { return { popup(options) { popupOptions = options; }, closePopup() {} }; } },
    dialog: {}, shell: {},
  };
  vm.runInNewContext(readFileSync(path.join(directory, 'main.cjs'), 'utf8'), {
    __dirname: directory, process: { env: {}, platform: process.platform }, URL, console,
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return { async readFile() { throw new Error('No saved vault'); } };
      if (name === './vault-service.cjs') return { VaultService: {} };
      if (name === './vault-dispatch.cjs') return { dispatchVaultOperation() {} };
      if (name === './context-menu.cjs') return { createContextMenuController };
      return require(name);
    },
  });
  await ready();
  const handler = handlers.get('zorid:showContextMenu');
  assert.ok(handler);
  assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }, request()), /Untrusted sender/);
  assert.throws(() => handler({ sender: window.webContents, senderFrame: { url: packaged } }, request()), /Untrusted sender/);
  window.webContents.mainFrame.url = 'https://untrusted.example/';
  assert.throws(() => handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, request()), /Untrusted page/);
  assert.equal(popupOptions, undefined);
  window.webContents.mainFrame.url = `${packaged}#note`;
  const result = handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, request());
  popupOptions.callback();
  assert.equal(await result, null);
});
