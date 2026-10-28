import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Vault} from '../src/core/vault.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {MarkdownEmbeds} from '../src/ui/embeds.ts';
import {BaseEmbedSessions} from '../src/ui/base-embed-sessions.ts';
import type {BaseSession} from '../src/bases/session.ts';
import type {EmbedRequest} from '../src/ui/markdown.ts';

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,2));
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await tick();assert.ok(check());}

for(const request of [{target:'Untitled.base',kind:'wiki'},{target:'Untitled.base#Table%20view',kind:'markdown',label:'Base alias'}] satisfies EmbedRequest[])test(`${request.kind} Base embeds show the collection title without a second filename heading`,async()=>{
  const dom=new JSDOM('<main></main>'),doc=dom.window.document,previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  const vault=new Vault(new MemoryAdapter({'Source.md':'','Untitled.base':'views: []\n','Note.md':'Ordinary note body'}));await vault.initialize();
  const contexts:Array<{target:string;kind:string;source:string}>=[],opened:string[]=[];
  const sessions=new BaseEmbedSessions({recoveryHost:doc.body,create(root){
    const heading=doc.createElement('h2');heading.textContent='Tasks';heading.className='collection-title';root.append(heading);
    const session:BaseSession={ready:Promise.resolve(),state:{version:0,source:'',result:null,error:null},async refresh(){},async selectView(){},async setCurrentFile(){},hasPendingChanges:()=>false,async flush(){},async close(){root.replaceChildren();}};
    return session;
  }});
  const embeds=new MarkdownEmbeds({vault,bases:{sessions,identity:path=>path},open:(_source,target)=>opened.push(target),
    contextMenu:(event,request,source)=>{event.preventDefault();contexts.push({target:request.target,kind:request.kind,source});}});
  try{
    const node=embeds.render(request,'Source.md');doc.querySelector('main')!.append(node);
    await until(()=>!!node.querySelector('.collection-title'));
    assert.equal(node.querySelector(':scope > .embed-open'),null,'the generic filename line belongs to note embeds, not a mounted Base');
    assert.equal(node.querySelector('.collection-title')!.textContent,'Tasks');assert.ok(node.classList.contains('bases-embed'));
    node.querySelector('.collection-title')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    assert.deepEqual(contexts,[{target:request.target,kind:request.kind,source:'Source.md'}],'the file remains available through its existing host context menu');
    const note=embeds.render({target:'Note',kind:'wiki'},'Source.md');doc.querySelector('main')!.append(note);await until(()=>!!note.querySelector('.markdown-embed-content'));
    const noteHeader=note.querySelector<HTMLAnchorElement>(':scope > .embed-open')!;assert.ok(noteHeader);assert.equal(noteHeader.textContent,'Note');noteHeader.click();assert.deepEqual(opened,['Note']);
  }finally{embeds.destroy();await sessions.close();dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
