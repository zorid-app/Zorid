import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createBaseListView} from '../src/bases/list-view.ts';
import {baseExpressionValue as value} from '../src/bases/expression.ts';
import type {BaseQueryResult} from '../src/bases/query.ts';
import type {BaseListViewOptions} from '../src/bases/list-view.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
function fixture(count=3,overrides:Partial<BaseListViewOptions>={}){
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document,host=doc.querySelector('main')!;
  const rows=Array.from({length:count},(_,i)=>({path:`Note ${i} #literal.md`,entryId:`entry-${i}`,revision:'r1',values:{'file.name':value(`Note ${i}`),'note.status':value('Started')}}));
  const result:BaseQueryResult={version:1,view:{type:'list',name:'List'},rows,groups:[{key:null,rows}],groupOptions:[],properties:['file.name','note.status'],availableProperties:['file.name','note.status'],counts:{scanned:count,matched:count,afterGroupOrder:count,afterSearch:count,returned:count},diagnostics:[]};
  const opened:{path:string;event:MouseEvent|KeyboardEvent;witness:unknown}[]=[],errors:unknown[]=[];
  const view=createBaseListView(host,{result,openFile:(path,event,witness)=>opened.push({path,event,witness}),onError:error=>errors.push(error),...overrides});
  const key=(node:Element,key:string,init:KeyboardEventInit={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...init});node.dispatchEvent(event);return event;};
  return{dom,doc,host,result,view,opened,errors,key,rows:()=>[...host.querySelectorAll<HTMLElement>('.bases-list-item')],close(){view.destroy();dom.window.close();}};
}

test('default List shows page rows with quiet title and trailing values while explicit configuration is preserved',()=>{
  const f=fixture();try{
    const first=f.rows()[0];assert.ok(first.classList.contains('is-page-row'));assert.ok(first.querySelector('.bases-list-page-icon svg'));assert.equal(first.querySelector('.list-bullet'),null);assert.equal(first.querySelector('.bases-list-separator'),null);
    assert.equal(first.querySelector('.is-title')!.textContent,'Note 0');assert.equal(first.querySelector('.bases-list-item-details')!.textContent,'Started');
    f.view.update({...f.result,view:{...f.result.view,markers:'number',separator:' / '}});
    assert.equal(f.rows()[0].classList.contains('is-page-row'),false);assert.equal(f.rows()[0].textContent,'1.Note 0 / Started');
    f.view.update({...f.result,view:{...f.result.view,markers:'bullet',indentProperties:true}});assert.equal(f.rows()[0].querySelectorAll('.list-bullet').length,2);assert.equal(f.rows()[0].querySelector('.bases-list-page-icon'),null);
  }finally{f.close();}
});

test('row and title activation forward original modifiers and exact file witness once; retained rows are inert',()=>{
  const f=fixture();try{
    const row=f.rows()[0],click=new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,metaKey:true}),middle=new f.dom.window.MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1});row.dispatchEvent(click);row.dispatchEvent(middle);
    const title=row.querySelector('a')!,titleClick=new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true});title.dispatchEvent(titleClick);
    assert.deepEqual(f.opened.map(item=>item.event),[click,middle,titleClick]);assert.ok(f.opened.every(item=>item.path==='Note 0 #literal.md'));assert.deepEqual(f.opened[0].witness,{entryId:'entry-0',revision:'r1'});
    f.view.update({...f.result,version:2});row.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));assert.equal(f.opened.length,3);
  }finally{f.close();}
});

test('row keyboard navigation spans virtualized rows and Enter opens its exact file',async()=>{
  const f=fixture(1000);try{
    assert.ok(f.rows().length<40);f.rows()[0].focus();f.key(f.doc.activeElement!,'ArrowDown');assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'Note 1 #literal.md');
    f.key(f.doc.activeElement!,'End');await tick();assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'Note 999 #literal.md');assert.ok(f.rows().length<42);
    const enter=f.key(f.doc.activeElement!,'Enter',{metaKey:true});assert.equal(f.opened.length,1);assert.equal(f.opened[0].event,enter);assert.deepEqual(f.opened[0].witness,{entryId:'entry-999',revision:'r1'});
    f.key(f.doc.activeElement!,'Home');await tick();assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'Note 0 #literal.md');assert.equal(f.rows().filter(row=>row.tabIndex===0).length,1);
    f.key(f.doc.activeElement!,'End');f.key(f.doc.activeElement!,'Home');await tick();assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'Note 0 #literal.md','new navigation cancels an older pending virtual focus');
    f.view.update({...f.result,version:2});await Promise.resolve();assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'Note 0 #literal.md');
  }finally{f.close();}
});

test('editable children and selected row text retain their pointer and keyboard ownership',()=>{
  let edits=0;const f=fixture(1,{renderProperty(element,context){if(context.property==='file.name'){element.textContent='Title';return;}const button=element.ownerDocument.createElement('button');button.textContent='Status';button.addEventListener('click',()=>edits++);element.append(button);}});
  try{
    const row=f.rows()[0],button=row.querySelector('button')!;button.click();assert.equal(edits,1);assert.equal(f.opened.length,0);button.focus();const down=f.key(button,'ArrowDown'),enter=f.key(button,'Enter');assert.equal(down.defaultPrevented,false);assert.equal(enter.defaultPrevented,false);assert.equal(f.doc.activeElement,button);assert.equal(f.opened.length,0);
    button.blur();const selection=f.dom.window.getSelection()!,range=f.doc.createRange();range.selectNodeContents(row);selection.addRange(range);row.click();assert.equal(f.opened.length,0);selection.removeAllRanges();
  }finally{f.close();}
});

test('New page uses the supplied creation command, serializes activation and retires stale controls',async()=>{
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),f=fixture(1,{onNew:async()=>{calls++;await gate;}});
  try{
    const button=f.host.querySelector<HTMLButtonElement>('.bases-list-new')!;assert.equal(button.textContent,'New page');button.click();button.click();await Promise.resolve();assert.equal(calls,1);assert.equal(button.disabled,true);
    f.view.update({...f.result,version:2});const replacement=f.host.querySelector<HTMLButtonElement>('.bases-list-new')!;assert.equal(replacement.disabled,true);release();await tick();assert.equal(replacement.disabled,false,'settled creation releases its current footer after a result refresh');
    button.click();await Promise.resolve();assert.equal(calls,1);
    f.host.querySelector<HTMLButtonElement>('.bases-list-new')!.click();f.view.update({...f.result,version:3});await Promise.resolve();assert.equal(calls,1,'retired activation cannot create after a source/result switch');
  }finally{release();await tick();f.close();}
});
