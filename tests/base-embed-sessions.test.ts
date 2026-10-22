import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {BaseEmbedSessions} from '../src/ui/base-embed-sessions.ts';
import type {BaseSession} from '../src/bases/session.ts';
import {inlineBaseRequest} from '../src/bases/inline-base.ts';

const target=()=>({sourcePath:'Source.md',targetPath:'Work.base',viewName:'Table',targetIdentity:Symbol('file'),sourceIdentity:Symbol('source'),occurrence:{}});
function fake(root:HTMLElement){
  const input=root.ownerDocument.createElement('input');root.append(input);
  let dirty=false,closed=0;
  const session:BaseSession={ready:Promise.resolve(),state:{version:0,source:'',result:null,error:null},async refresh(){},async selectView(){},hasPendingChanges:()=>dirty,async flush(){if(dirty)throw new Error('unfinished');},async close(){await this.flush();closed++;root.replaceChildren();}};
  return{input,session,setDirty(value:boolean){dirty=value;},get closed(){return closed;}};
}
test('widget detach preserves exact draft DOM in visible recovery and compatible remount reclaims it',async()=>{
  const dom=new JSDOM('<body><main></main><aside></aside></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.querySelector('aside')!,create(root){const view=fake(root);views.push(view);return view.session;}}),request=target(),host=doc.querySelector('main')!;
  const first=manager.mount(request,host);await first.ready;views[0].input.value='draft';views[0].setDirty(true);first.detach();
  assert.equal(doc.querySelector('.base-embed-recovery input'),views[0].input);await assert.rejects(manager.close(),/unfinished/);assert.equal(views[0].closed,0);
  const second=manager.mount(request,host);await second.ready;assert.equal(views.length,1);assert.equal(host.querySelector('input'),views[0].input);assert.equal(views[0].input.value,'draft');
  first.detach();assert.equal(host.contains(views[0].input),true);views[0].setDirty(false);await manager.close();assert.equal(views[0].closed,1);second.detach();dom.window.close();
});
test('equal state occurrence tokens in concurrent views never share a mounted session',async()=>{
  const dom=new JSDOM('<body><main></main><aside></aside></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);views.push(view);return view.session;}}),request=target();
  await manager.mount(request,doc.querySelector('main')!).ready;await manager.mount(request,doc.querySelector('aside')!).ready;assert.equal(views.length,2);
  assert.notEqual(doc.querySelector('main input'),doc.querySelector('aside input'));await manager.close();dom.window.close();
});
test('same path with a new file incarnation cannot reclaim a retired dirty session',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);views.push(view);return view.session;}}),request=target(),host=doc.querySelector('main')!;
  const binding=manager.mount(request,host);await binding.ready;views[0].setDirty(true);binding.detach();
  await manager.mount({...request,targetIdentity:Symbol('replacement')},host).ready;assert.equal(views.length,2);assert.equal(host.querySelector('input'),views[1].input);assert.equal(manager.hasPendingChanges(),true);
  views[0].setDirty(false);await manager.close();assert.deepEqual(views.map(view=>view.closed),[1,1]);dom.window.close();
});
test('close waits for an in-flight session creation and disposes its eventual resources once',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document;let release!:()=>void,view:ReturnType<typeof fake>|undefined;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,async create(root){await gate;view=fake(root);return view.session;}});
  const binding=manager.mount(target(),doc.querySelector('main')!);binding.detach();let closed=false;const closing=manager.close().then(()=>{closed=true;});
  try{await Promise.resolve();assert.equal(closed,false);assert.throws(()=>manager.mount(target(),doc.body),/closing/);release();await closing;assert.equal(view!.closed,1);assert.equal(doc.querySelector('input'),null);await manager.close();assert.equal(view!.closed,1);}
  finally{release();await closing;dom.window.close();}
});

test('concurrent preflights share one flush and revisit edits accepted during a later save',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  let release!:()=>void,secondStarted!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{secondStarted=resolve;});let calls=0;
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root),index=views.length;views.push(view);view.session.flush=async()=>{calls++;if(index===1&&calls===2){secondStarted();await gate;}view.setDirty(false);};return view.session;}});
  await manager.mount(target(),doc.querySelector('main')!).ready;await manager.mount(target(),doc.querySelector('main')!).ready;
  views[0].setDirty(true);views[1].setDirty(true);const first=manager.flush(),second=manager.flush();assert.equal(first,second);
  try{await started;views[0].setDirty(true);release();await first;assert.equal(calls,3);assert.equal(manager.hasPendingChanges(),false);}
  finally{release();await first;await manager.close();dom.window.close();}
});

test('clean detached sessions are bounded while unfinished drafts are never evicted',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);views.push(view);return view.session;}}),host=doc.querySelector('main')!;
  for(let i=0;i<10;i++){const binding=manager.mount(target(),host);await binding.ready;if(i===0)views[0].setDirty(true);binding.detach();}
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(views[0].closed,0);assert.equal(views.filter(view=>view.closed===0).length,5);assert.equal(doc.querySelector('.base-embed-recovery input'),views[0].input);
  views[0].setDirty(false);await manager.close();assert.equal(views.every(view=>view.closed===1),true);dom.window.close();
});

test('source incarnation changes and failed initial mounts create fresh sessions',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,host=doc.querySelector('main')!;let calls=0;
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){calls++;if(calls===1)throw new Error('missing view');return fake(root).session;}}),request=target();
  const failed=manager.mount(request,host);await assert.rejects(failed.ready,/missing view/);failed.detach();
  const valid=manager.mount(request,host);await valid.ready;valid.detach();await manager.mount({...request,sourceIdentity:Symbol('replacement source')},host).ready;assert.equal(calls,3);await manager.close();dom.window.close();
});

test('repeated clean preflights skip session flush work after initial loading',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document;let calls=0;
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);view.session.flush=async()=>{calls++;};return view.session;}});
  await manager.mount(target(),doc.querySelector('main')!).ready;for(let i=0;i<20;i++)await manager.flush();assert.equal(calls,0);await manager.close();dom.window.close();
});

test('identical inline configurations at distinct source spans never reclaim each other or a file embed',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);views.push(view);return view.session;}});
  const block='```base\nviews: []\n```',source=block+'\n\n'+block,request=target(),host=doc.querySelector('main')!;
  const inline={...request,inline:inlineBaseRequest(source,0,block.length)!};
  const first=manager.mount(inline,host);await first.ready;views[0].setDirty(true);first.detach();
  const second=manager.mount({...inline,inline:inlineBaseRequest(source,block.length+2,source.length)!},host);await second.ready;second.detach();
  await manager.mount(request,host).ready;assert.equal(views.length,3);
  assert.equal(doc.querySelector('.base-embed-recovery input'),views[0].input);
  views[0].setDirty(false);await manager.close();dom.window.close();
});

test('changed containing source cannot reclaim an inline session with a retained configuration draft',async()=>{
  const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,views:ReturnType<typeof fake>[]=[];
  const manager=new BaseEmbedSessions({recoveryHost:doc.body,create(root){const view=fake(root);views.push(view);return view.session;}});
  const block='```base\nviews: []\n```',source=block+'\nOld body',request=target(),host=doc.querySelector('main')!;
  const first=manager.mount({...request,inline:inlineBaseRequest(source,0,block.length)!},host);await first.ready;
  views[0].setDirty(true);first.detach();
  await manager.mount({...request,inline:inlineBaseRequest(source.replace('Old body','New body'),0,block.length)!},host).ready;
  assert.equal(views.length,2);assert.equal(doc.querySelector('.base-embed-recovery input'),views[0].input);
  views[0].setDirty(false);await manager.close();dom.window.close();
});
