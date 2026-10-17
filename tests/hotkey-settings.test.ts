import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HotkeyPreferences } from '../src/ui/hotkeys.ts';
import { mountHotkeySettings } from '../src/ui/hotkey-settings.ts';

test('searchable Settings captures/rebinds/removes/resets commands and keeps focus usable',()=>{
  const dom=new JSDOM('<main></main>',{url:'https://test.local',pretendToBeVisual:true}),doc=dom.window.document;
  const prefs=new HotkeyPreferences(dom.window.localStorage,'other');let changed=0;
  const ui=mountHotkeySettings(doc.querySelector('main')!,prefs,()=>changed++);
  const search=doc.querySelector('input')!;search.value='Create new note';search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(doc.querySelectorAll('.hotkey-row').length,1);
  const change=doc.querySelector<HTMLButtonElement>('.hotkey-binding button')!;change.click();
  change.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'n',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));
  assert.equal(prefs.label('new-note'),'Ctrl+Alt+N');assert.equal(changed,1);assert.equal(doc.activeElement?.textContent,'Add shortcut');
  doc.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')!.click();assert.deepEqual(prefs.bindings('new-note'),[]);
  doc.querySelector<HTMLButtonElement>('[aria-label^="Reset"]')!.click();assert.equal(prefs.label('new-note'),'Ctrl+N');
  ui.destroy();dom.window.close();
});
test('capture Escape cancels before modal handling; conflicts and repeats do not commit; Tab exits capture',()=>{
  const dom=new JSDOM('<main></main>',{url:'https://test.local',pretendToBeVisual:true}),doc=dom.window.document,prefs=new HotkeyPreferences(dom.window.localStorage,'other');
  let escapes=0;doc.addEventListener('keydown',event=>{if(event.key==='Escape')escapes++;},true);
  const ui=mountHotkeySettings(doc.querySelector('main')!,prefs,()=>{});
  const add=doc.querySelector<HTMLButtonElement>('[data-command="graph"] .hotkey-add')!;add.click();
  const key=(key:string,extra={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});add.dispatchEvent(event);return event;};
  key('o',{ctrlKey:true});assert.match(doc.querySelector('.hotkey-status')!.textContent!,/Already assigned/);assert.deepEqual(prefs.bindings('graph'),[]);
  key('g',{ctrlKey:true,altKey:true,repeat:true});assert.deepEqual(prefs.bindings('graph'),[]);
  assert.equal(key('Escape').defaultPrevented,true);assert.equal(escapes,0);assert.equal(add.dataset.recording,undefined);
  add.click();assert.equal(key('Tab').defaultPrevented,false);assert.equal(add.dataset.recording,undefined);
  ui.destroy();key('Escape');assert.equal(escapes,1);dom.window.close();
});
test('removing the Settings section releases active window capture',async()=>{
  const dom=new JSDOM('<main></main>',{url:'https://test.local',pretendToBeVisual:true}),doc=dom.window.document;
  mountHotkeySettings(doc.querySelector('main')!,new HotkeyPreferences(dom.window.localStorage,'other'),()=>{});
  doc.querySelector<HTMLButtonElement>('.hotkey-add')!.click();doc.querySelector('main')!.remove();await Promise.resolve();
  const event=new dom.window.KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true});doc.dispatchEvent(event);assert.equal(event.defaultPrevented,false);dom.window.close();
});

test('editor commands are searchable, configurable and conflict with workspace bindings',()=>{
  const dom=new JSDOM('<main></main>',{url:'https://test.local',pretendToBeVisual:true}),doc=dom.window.document;
  const prefs=new HotkeyPreferences(dom.window.localStorage,'other'),ui=mountHotkeySettings(doc.querySelector('main')!,prefs,()=>{});
  assert.equal(doc.querySelectorAll('[data-scope="editor"]').length,14);assert.equal(doc.querySelectorAll('[data-scope="workspace"]').length,27);
  const search=doc.querySelector('input')!;search.value='Toggle bold';search.dispatchEvent(new dom.window.Event('input'));
  const add=doc.querySelector<HTMLButtonElement>('.hotkey-binding button')!;add.click();
  const key=(key:string)=>add.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,ctrlKey:true,altKey:key==='b',bubbles:true,cancelable:true}));
  key('n');assert.match(doc.querySelector('.hotkey-status')!.textContent!,/Create new note/);assert.equal(prefs.label('editor-bold'),'Ctrl+B');
  key('i');assert.match(doc.querySelector('.hotkey-status')!.textContent!,/Toggle italic/);
  key('b');assert.equal(prefs.label('editor-bold'),'Ctrl+Alt+B');
  doc.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')!.click();assert.deepEqual(prefs.effectiveBindings('editor-bold'),[]);
  doc.querySelector<HTMLButtonElement>('[aria-label^="Reset"]')!.click();assert.equal(prefs.customized('editor-bold'),false);
  ui.destroy();dom.window.close();
});

test('macOS Option-letter capture displays the canonical letter and preserves it after reopening',()=>{
  const dom=new JSDOM('<main></main>',{url:'https://test.local',pretendToBeVisual:true}),doc=dom.window.document;
  const prefs=new HotkeyPreferences(dom.window.localStorage,'mac'),ui=mountHotkeySettings(doc.querySelector('main')!,prefs,()=>{});
  const change=doc.querySelector<HTMLButtonElement>('[data-command="new-tab"] .hotkey-binding button')!;change.click();
  change.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'†',code:'KeyT',keyCode:84,metaKey:true,altKey:true,bubbles:true,cancelable:true}));
  assert.equal(doc.querySelector('[data-command="new-tab"] kbd')!.textContent,'⌘ ⌥ T');
  assert.equal(doc.querySelector('.hotkey-status')!.textContent,'Shortcut saved.');
  assert.equal(new HotkeyPreferences(dom.window.localStorage,'mac').label('new-tab'),'⌘ ⌥ T');
  ui.destroy();dom.window.close();
});
