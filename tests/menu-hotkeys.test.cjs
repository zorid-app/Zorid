'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateMenuHotkeys,workspaceFileMenu}=require('../desktop/menu-hotkeys.cjs');
test('native hints accept exactly bounded known command IDs with no arbitrary accelerator registration',()=>{
  const value=[{id:'new-window',shortcut:'⌘ ⇧ N'},{id:'close-tab',shortcut:''}];
  const hints=validateMenuHotkeys(value);assert.equal(hints['new-window'],'⌘ ⇧ N');
  for(const invalid of [[],[value[0],value[0]],[value[0],{id:'quit',shortcut:'Q'}],[value[0],{id:'close-tab',shortcut:'x\ny'}],[value[0],{id:'close-tab',shortcut:'x'.repeat(241)}],[value[0],{id:'close-tab',shortcut:'Q',accelerator:'Cmd+Q'}]])assert.throws(()=>validateMenuHotkeys(invalid));
  const called=[],menu=workspaceFileMenu(hints,{newWindow:()=>called.push('new'),closeTab:()=>called.push('tab'),closeWindow:()=>called.push('window')});
  assert.equal(menu.submenu[0].label,'New window (⌘ ⇧ N)');assert.equal(menu.submenu[1].label,'Close tab');
  assert.ok(menu.submenu.every(item=>!('accelerator'in item)&&!('role'in item)));menu.submenu[0].click();menu.submenu[1].click();menu.submenu[3].click();assert.deepEqual(called,['new','tab','window']);
});
test('preload forwards only fixed close-tab commands and releases each subscription',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');
  const ipc=new EventEmitter(),calls=[];let bridge;
  ipc.invoke=(...args)=>{calls.push(args);return Promise.resolve();};
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return {ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}},webUtils:{}};}});
  const received=[],release=bridge.onCommand(id=>received.push(id));
  ipc.emit('zorid:command',{},'quit');ipc.emit('zorid:command',{},'close-tab');
  assert.deepEqual(received,['close-tab']);release();ipc.emit('zorid:command',{},'close-tab');
  assert.deepEqual(received,['close-tab']);assert.equal(ipc.listenerCount('zorid:command'),0);
  const bindings=[{id:'new-window',shortcut:''},{id:'close-tab',shortcut:'Ctrl+W'}];bridge.setMenuHotkeys(bindings);
  assert.deepEqual(calls,[['zorid:setMenuHotkeys',bindings]]);
});
