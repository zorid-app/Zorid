import test from 'node:test';
import assert from 'node:assert/strict';
import {previousBrowserData,legacyBrowserExport} from '../src/platform/browser-legacy-export.ts';
function storage(values:Record<string,string>):Storage{const map=new Map(Object.entries(values));return{get length(){return map.size;},getItem:key=>map.get(key)??null,setItem:(key,value)=>{map.set(key,value);},removeItem:key=>{map.delete(key);},clear:()=>map.clear(),key:index=>[...map.keys()][index]??null};}
test('legacy export preserves raw preview data and drafts without mutating or including other vaults',()=>{
  const raw='not even valid JSON\nwith original bytes';
  const data=storage({'zorid.browser-vault.v1':raw,'zorid:draft:browser:default:One.md':'unsaved raw draft','zorid:workspace:browser:default':'old session','zorid:draft:browser:core:other:One.md':'private other vault','zorid:settings':'{}'});
  const before=Array.from({length:data.length},(_,index)=>[data.key(index),data.getItem(data.key(index)!)]);
  assert.deepEqual({...previousBrowserData(data)},{'zorid.browser-vault.v1':raw,'zorid:draft:browser:default:One.md':'unsaved raw draft','zorid:workspace:browser:default':'old session'});
  assert.equal(typeof legacyBrowserExport(data),'function');
  assert.deepEqual(Array.from({length:data.length},(_,index)=>[data.key(index),data.getItem(data.key(index)!)]),before);
});
test('no previous data means no export action',()=>{assert.equal(legacyBrowserExport(storage({})),undefined);});
