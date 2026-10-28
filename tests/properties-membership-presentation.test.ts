import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderProperties} from '../src/ui/properties.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';

function fixture(source:string) {
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
  let managed=false,writes=0;
  const view=renderProperties(host,{managedOnly:true,isManaged:()=>managed,collectionName:()=>managed?'Books':undefined,
    getDefinitions:():Record<string,BasePropertyDefinition>=>managed?{rating:{type:'number'}}:{},getSource:()=>source,
    onVisibilityChange:visible=>{host.hidden=!visible;},onChange:next=>{writes++;source=next;}});
  return {dom,host,view,root:host.querySelector<HTMLElement>('.metadata-container')!,setManaged(value:boolean){managed=value;view.refresh();},
    get source(){return source;},get writes(){return writes;},close(){view.destroy();dom.window.close();}};
}

test('ordinary notes have no properties panel or host spacing, regardless of YAML content',()=>{
  for(const source of ['Plain body','---\nrating: 4\n---\nBody','---\n_id: misleading\n_type: Books\nrating: 4\n---\nBody','---\ninvalid: [\n---\nBody']){
    const f=fixture(source);try{
      assert.equal(f.root.hidden,true);assert.equal(f.host.hidden,true);
      assert.equal(f.source,source);assert.equal(f.writes,0);
    }finally{f.close();}
  }
});

test('late authoritative membership reveals schema controls and hides readable identities without changing source',()=>{
  const source='---\n_id: trusted-note\n_type: Books\nrating: 4\n---\nExact body',f=fixture(source);
  try{
    assert.equal(f.host.hidden,true);f.setManaged(true);
    assert.equal(f.root.hidden,false);assert.equal(f.host.hidden,false);
    assert.equal(f.host.querySelector('.metadata-properties-heading')!.textContent,'Books properties');
    assert.equal(f.host.querySelector<HTMLElement>('[data-property-key="rating"] .metadata-property-value')!.dataset.propertyType,'number');
    assert.equal(f.host.querySelector<HTMLElement>('[data-property-key="_id"]')!.hidden,true);
    assert.equal(f.host.querySelector<HTMLElement>('[data-property-key="_type"]')!.hidden,true);
    f.setManaged(false);assert.equal(f.host.hidden,true);assert.equal(f.source,source);assert.equal(f.writes,0);
  }finally{f.close();}
});

test('membership loss retains a rich edit and failed save until explicit cancellation',async()=>{
  const source='---\nrating: 4\n---\nExact body',f=fixture(source);
  try{
    f.setManaged(true);const value=f.host.querySelector<HTMLElement>('[data-property-key="rating"] .metadata-property-value')!;
    value.click();const input=value.querySelector<HTMLInputElement>('input')!;input.value='5';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    f.setManaged(false);assert.equal(f.host.hidden,false);assert.equal(input.isConnected,true);assert.equal(input.value,'5');
    input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await assert.rejects(f.view.flush(),/definition changed/);f.view.refresh();
    assert.equal(f.host.hidden,false);assert.equal(f.view.hasPendingChanges(),true);assert.equal(input.value,'5');assert.equal(f.source,source);assert.equal(f.writes,0);
    input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await new Promise(resolve=>setTimeout(resolve,0));await f.view.flush();f.view.refresh();assert.equal(f.host.hidden,true);
  }finally{f.close();}
});
