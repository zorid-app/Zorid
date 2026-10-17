import test from 'node:test';
import assert from 'node:assert/strict';
import { eventHotkey, formatHotkey, HotkeyPreferences, normalizeHotkey, reservedHotkey, parseHotkeyOverrides } from '../src/ui/hotkeys.ts';
import type { Hotkey } from '../src/ui/hotkeys.ts';
const binding=(key:string,...modifiers:Hotkey['modifiers']):Hotkey=>({key,modifiers});
function storage(initial='{}'){let value=initial;return {getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;},get value(){return value;}};}
function event(key:string,extra:Record<string,unknown>={}){return {key,ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,isComposing:false,repeat:false,defaultPrevented:false,...extra} as KeyboardEvent;}

test('defaults, overrides, unbinding and reset survive new preference instances',()=>{
  const store=storage(),prefs=new HotkeyPreferences(store,'other');
  assert.equal(prefs.resolve(event('n')),'new-note');
  prefs.set('new-note',[binding('n','Mod','Alt')]);assert.equal(prefs.resolve(event('n')),null);assert.equal(prefs.resolve(event('n',{altKey:true})),'new-note');
  const loaded=new HotkeyPreferences(store,'other');assert.equal(loaded.label('new-note'),'Ctrl+Alt+N');
  loaded.set('new-note',[]);assert.deepEqual(new HotkeyPreferences(store,'other').bindings('new-note'),[]);
  loaded.set('new-note',null);assert.equal(loaded.resolve(event('n')),'new-note');assert.equal(loaded.customized('new-note'),false);
});
test('conflicts and reset conflicts fail without changing persisted or active bindings',()=>{
  const store=storage(),prefs=new HotkeyPreferences(store,'mac');
  assert.throws(()=>prefs.set('new-note',[binding('o','Mod')]),/quick switcher/);assert.equal(store.value,'{}');
  prefs.set('new-note',[]);prefs.set('graph',[binding('n','Mod')]);const previous=store.value;
  assert.throws(()=>prefs.set('new-note',null),/Graph/);assert.equal(store.value,previous);assert.deepEqual(prefs.bindings('new-note'),[]);
});
test('exact platform modifiers and shifted punctuation normalize without treating AltGraph/IME as commands',()=>{
  const mac=new HotkeyPreferences(storage(),'mac'),other=new HotkeyPreferences(storage(),'other');
  assert.equal(mac.resolve(event('n')),null);assert.equal(mac.resolve(event('n',{ctrlKey:false,metaKey:true})),'new-note');
  for(const extra of [{metaKey:true},{altKey:true},{repeat:true},{isComposing:true},{defaultPrevented:true},{getModifierState:()=>true}])assert.equal(other.resolve(event('n',extra)),null);
  assert.deepEqual(eventHotkey(event('+',{shiftKey:true}),'other'),binding('=','Mod','Shift'));
  assert.equal(formatHotkey(binding('n','Mod','Shift'),'mac'),'⌘ ⇧ N');
});
test('reserved editor/native/text-entry chords are rejected rather than claimed to work',()=>{
  for(const platform of ['mac','other']as const){const prefs=new HotkeyPreferences(storage(),platform);for(const value of [binding('z','Mod'),binding('f','Mod'),binding('q','Mod'),binding('x'),binding('Escape'),binding('ArrowLeft','Mod'),binding('i','Mod'),binding('F2'),binding('F2','Mod','Shift'),binding('F3'),binding('F3','Shift'),binding('F10','Shift')])assert.throws(()=>prefs.set('graph',[value]),/reserved/i);}
  assert.match(reservedHotkey(binding('n','Ctrl'),'mac')!,/suggestions/);
  assert.equal(normalizeHotkey({key:'Dead',modifiers:['Mod']}),null);
});
test('corrupt or ambiguous stored preferences do not execute and quota failures preserve active state',()=>{
  assert.equal(Object.keys(parseHotkeyOverrides('{')).length,0);
  assert.equal(Object.keys(parseHotkeyOverrides('{"__proto__":[],"new-note":[{"key":"n","modifiers":["Bogus"]}]}')).length,0);
  const prefs=new HotkeyPreferences(storage(JSON.stringify({'new-note':[binding('o','Mod')]})),'other');assert.equal(prefs.resolve(event('o')),null);
  const failed=new HotkeyPreferences({getItem:()=>null,setItem(){throw Error('quota');}},'other');assert.throws(()=>failed.set('new-note',[]),/quota/);assert.equal(failed.resolve(event('n')),'new-note');
});
test('storage refresh applies another window changes while preserving distinct empty overrides',()=>{
  const store=storage(),first=new HotkeyPreferences(store,'other'),second=new HotkeyPreferences(store,'other');first.set('new-note',[]);second.reload();assert.equal(second.resolve(event('n')),null);first.set('new-note',null);second.reload();assert.equal(second.resolve(event('n')),'new-note');
});

test('editor commands persist with scope-specific resolution and shared workspace conflicts',()=>{
  const store=storage(),prefs=new HotkeyPreferences(store,'other');
  assert.deepEqual(prefs.bindings('editor-bold'),[]);
  prefs.set('editor-bold',[binding('b','Mod','Alt')]);
  assert.equal(prefs.resolve(event('b',{altKey:true})),null);
  assert.equal(prefs.resolve(event('b',{altKey:true}),'editor'),'editor-bold');
  assert.throws(()=>prefs.set('graph',[binding('b','Mod','Alt')]),/Editor: Toggle bold/);
  assert.throws(()=>prefs.set('editor-bold',[binding('o','Mod')]),/quick switcher/);
  assert.throws(()=>prefs.set('editor-bold',[binding('i','Mod')]),/Reserved/);
  const loaded=new HotkeyPreferences(store,'other');assert.deepEqual(loaded.effectiveBindings('editor-bold'),[binding('b','Mod','Alt')]);
  loaded.set('editor-bold',null);assert.deepEqual(loaded.effectiveBindings('editor-bold'),[]);
});
test('effective editor bindings suppress imported reserved and cross-scope conflicts on both platforms',()=>{
  for(const platform of ['mac','other']as const){
    const store=storage(JSON.stringify({'editor-bold':[binding('n','Mod'),binding('i','Mod'),binding('b','Mod','Alt')]}));
    const prefs=new HotkeyPreferences(store,platform);
    assert.deepEqual(prefs.effectiveBindings('editor-bold'),[binding('b','Mod','Alt')]);
    assert.deepEqual(prefs.effectiveBindings('new-note'),[]);
    const result=prefs.effectiveBindings('editor-bold');result[0].modifiers.length=0;
    assert.deepEqual(prefs.effectiveBindings('editor-bold'),[binding('b','Mod','Alt')]);
    assert.deepEqual(prefs.effectiveBindings('unknown'),[]);
  }
});
test('live preference subscriptions update on successful writes and external changes, with disposal',()=>{
  const store=storage(),prefs=new HotkeyPreferences(store,'other'),observed:Hotkey[][]=[];
  const release=prefs.subscribe(()=>observed.push(prefs.effectiveBindings('editor-bold')));
  prefs.set('editor-bold',[binding('b','Mod','Alt')]);assert.deepEqual(observed,[[binding('b','Mod','Alt')]]);
  assert.throws(()=>prefs.set('editor-bold',[binding('n','Mod')]),/Already/);assert.equal(observed.length,1);
  const other=new HotkeyPreferences(store,'other');other.set('editor-bold',[]);prefs.reload();assert.deepEqual(observed[1],[]);
  prefs.reload();assert.equal(observed.length,2);
  release();prefs.set('editor-bold',null);assert.equal(observed.length,2);
  let failedNotifications=0;const failed=new HotkeyPreferences({getItem:()=>null,setItem(){throw Error('quota');}},'other');failed.subscribe(()=>failedNotifications++);
  assert.throws(()=>failed.set('editor-bold',[binding('b','Mod','Alt')]),/quota/);assert.equal(failedNotifications,0);
});
