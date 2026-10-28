import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {openBaseNewItemPopover} from '../src/ui/base-new-item-popover.ts';
const source='---\nstatus: Todo\nitems: [one, two]\n---\nExact body\n';
for(const kind of ['scalar','list','add'] as const)test(`New popup retains an unsubmitted implicit ${kind} property draft through close`,async()=>{
  const dom=new JSDOM('<!doctype html><body><button>New</button>',{pretendToBeVisual:true}),adapter=new MemoryAdapter({'Untitled.md':source}),vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Untitled.md',{debounceMs:60000});await buffer.load();
  const popup=await openBaseNewItemPopover({anchor:dom.window.document.querySelector('button')!,vault,path:'Untitled.md',getBuffer:async()=>buffer,validate(){},rename:async()=>{},openFile(){},onError(){}});popup.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  if(kind==='add')popup.element.querySelector<HTMLButtonElement>('.metadata-add-button')!.click();const input=popup.element.querySelector<HTMLInputElement|HTMLTextAreaElement>(kind==='scalar'?'[data-property-key="status"] .metadata-property-value input':kind==='list'?'[data-property-key="items"] textarea':'[aria-label="New property name"]')!;assert.ok(input);input.value='Unsubmitted draft';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  try{assert.equal(popup.hasPendingChanges(),true);await assert.rejects(popup.close(),/Finish editing/);assert.equal(popup.element.isConnected,true);assert.equal(input.isConnected,true);assert.equal(input.value,'Unsubmitted draft');assert.equal(await adapter.read('Untitled.md'),source);}
  finally{if(popup.element.isConnected){if(kind==='add')[...popup.element.querySelectorAll<HTMLButtonElement>('.metadata-add-form button')].find(node=>node.textContent==='Cancel')!.click();else{input.value=kind==='scalar'?'Todo':'one';input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}await popup.close();}await buffer.dispose();dom.window.close();}
});

test('managed page peek forwards Add property to its schema owner without changing the shared note',async()=>{
  const dom=new JSDOM('<!doctype html><body><button>Open</button>',{pretendToBeVisual:true}),adapter=new MemoryAdapter({'Untitled.md':source}),vault=new Vault(adapter);await vault.initialize();const buffer=new NoteBuffer(vault,'Untitled.md',{debounceMs:60000});await buffer.load();
  const anchors:HTMLElement[]=[];
  const popup=await openBaseNewItemPopover({anchor:dom.window.document.querySelector('button')!,vault,path:'Untitled.md',presentation:'side-peek',focusTitle:false,propertiesExpanded:true,
    getBuffer:async()=>buffer,validate(){},rename:async()=>{},openFile(){},onError(){},properties:{isManaged:()=>true,onAddProperty:anchor=>{anchors.push(anchor);}}});
  try{
    const button=popup.element.querySelector<HTMLButtonElement>('.metadata-add-button')!;button.click();await Promise.resolve();
    assert.deepEqual(anchors,[button]);assert.equal(popup.element.querySelector('.metadata-add-form'),null);assert.equal(popup.hasPendingChanges(),false);assert.equal(buffer.text,source);assert.equal(await adapter.read('Untitled.md'),source);
  }finally{await popup.close();await buffer.dispose();dom.window.close();}
});
