import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseFileHoverAnchor} from '../src/bases/file-hover.ts';
import {createBaseFileHover} from '../src/ui/base-file-hover.ts';
import {createBaseTableView} from '../src/bases/table-view.ts';
import {createBaseCardsView} from '../src/bases/cards-view.ts';
import {createBaseListView} from '../src/bases/list-view.ts';
import {createBaseKanbanView} from '../src/bases/kanban-view.ts';
import type {BaseQueryRow,BaseQueryResult} from '../src/bases/query.ts';
import type {BaseFileHoverTarget} from '../src/ui/base-file-hover.ts';
import type {NoteBuffer} from '../src/ui/note-buffer.ts';

const row:BaseQueryRow={path:'Folder/A#literal.md',entryId:'original-id',revision:'r1',values:{'file.name':{type:'string',value:'A#literal'},'file.file':{type:'string',value:'A#literal'},'note.status':{type:'string',value:'Todo'}}};
function result(type:string,properties=['file.name','note.status']):BaseQueryResult{return{version:1,view:{name:'Reference',type,groupBy:{property:'note.status',direction:'ASC'}},rows:[row],groups:[{key:{type:'string',value:'Todo'},rows:[row]}],properties,availableProperties:properties,groupOptions:[],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[]};}
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const rect=(left:number,top:number,width:number,height:number)=>({x:left,y:top,left,top,right:left+width,bottom:top+height,width,height,toJSON(){}});
const constructors={table:createBaseTableView,cards:createBaseCardsView,list:createBaseListView,kanban:createBaseKanbanView};

for(const type of Object.keys(constructors) as (keyof typeof constructors)[])test(`${type} production hover uses the filename rectangle and retains the captured file witness`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),parent=dom.window.document.querySelector('main')!;t.after(()=>dom.window.close());
  Object.defineProperties(dom.window,{innerWidth:{value:1024},innerHeight:{value:800}});const mounted:BaseFileHoverTarget[]=[];let selected:HTMLElement|undefined,current:EventTarget|null=null;
  const hover=createBaseFileHover({parent,isMac:true,isCurrent:target=>target.entryId===row.entryId&&target.revision===row.revision&&target.path===row.path,
    getBuffer:async()=>({path:row.path,savedDurableWitness:{path:row.path,entryId:row.entryId!,revision:row.revision!},async load(){}} as unknown as NoteBuffer),
    mount:async(host,context)=>{mounted.push(context.target);host.textContent='Rendered note';return{flush:async()=>{},hasPendingChanges:()=>false,isCurrent:()=>true,dispose(){}};},onError:error=>{throw error;}});
  const view=constructors[type](parent,{result:result(type),openFile(){},hoverFile:(captured,event)=>{current=event.currentTarget;selected=baseFileHoverAnchor(captured,event);if(selected)hover.hover(captured,event,selected);}});
  const link=parent.querySelector<HTMLElement>('[data-property="file.name"] a.internal-link')!;assert.ok(link);const owner=link.closest<HTMLElement>('.zorid-bases-table-cell,.bases-cards-item,.bases-list-item,.bases-kanban-card')!;owner.getBoundingClientRect=()=>rect(300,140,450,60);link.getBoundingClientRect=()=>rect(352,154.516,74.258,17.063);
  (type==='kanban'?owner:link).dispatchEvent(new dom.window.MouseEvent(type==='kanban'?'mouseenter':'mouseover',{bubbles:true,metaKey:true,relatedTarget:dom.window.document.body}));
  assert.equal(current,owner);assert.equal(selected,link);assert.notEqual(selected,owner);t.mock.timers.tick(300);await drain();const popup=dom.window.document.querySelector<HTMLElement>('.bases-file-hover')!;assert.ok(popup);assert.equal(popup.style.left,'352px');assert.ok(Math.abs(parseFloat(popup.style.top)-181.579)<1e-9);assert.deepEqual(mounted,[{path:row.path,entryId:row.entryId,revision:row.revision}]);
  await hover.destroy();view.destroy();
});

function fixture(t:TestContext){const dom=new JSDOM('<main><div class="bases-cards-item"></div></main>'),card=dom.window.document.querySelector<HTMLElement>('.bases-cards-item')!;card.dataset.path=row.path;t.after(()=>dom.window.close());
  const field=(property:string,owner=card)=>{const element=dom.window.document.createElement('div');element.dataset.property=property;const link=dom.window.document.createElement('a');link.className='internal-link';element.append(link);owner.append(element);return link;};
  const select=(target:HTMLElement=card,captured=row)=>{let selected:HTMLElement|undefined;card.addEventListener('mouseover',event=>{selected=baseFileHoverAnchor(captured,event);},{once:true});target.dispatchEvent(new dom.window.MouseEvent('mouseover',{bubbles:true,metaKey:true}));return selected;};return{dom,card,field,select};}
test('relation, foreign and nested links never substitute for the row filename',t=>{
  const f=fixture(t),filename=f.field('file.name'),relation=f.field('note.related');assert.equal(f.select(relation),undefined);assert.equal(f.select(filename),filename);
  const nested=f.dom.window.document.createElement('div');nested.className='bases-list-item';nested.dataset.path='Nested.md';f.card.append(nested);const nestedLink=f.field('file.name',nested);assert.equal(f.select(nestedLink),undefined);assert.equal(f.select(),filename);
});
test('multiple filename fields require the actual hovered link and reject an ambiguous card boundary',t=>{
  const f=fixture(t),name=f.field('file.name'),file=f.field('file.file');assert.equal(f.select(),undefined);assert.equal(f.select(name),name);assert.equal(f.select(file),file);
});
test('recycled row ownership, missing saved witness, disconnected anchor and unrelated links are rejected',t=>{
  const f=fixture(t),link=f.field('file.name');assert.equal(f.select(link,{...row,entryId:undefined}),undefined);f.card.dataset.path='Recycled.md';assert.equal(f.select(link),undefined);f.card.dataset.path=row.path;link.remove();assert.equal(f.select(link),undefined);assert.equal(f.select(),undefined);
  const plain=f.dom.window.document.createElement('a');plain.className='internal-link';f.card.append(plain);assert.equal(f.select(plain),undefined);f.card.remove();assert.equal(f.select(),undefined);
});
