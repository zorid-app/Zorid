import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorState,EditorSelection,StateEffect} from '@codemirror/state';
import {history,undo} from '@codemirror/commands';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {frontmatterMarkdown} from '../src/editor/frontmatter-syntax.ts';
import {databaseSlash,databaseSlashContext} from '../src/editor/database-slash.ts';
import type {DatabaseSlashOptions,DatabaseSlashPageRequest,DatabaseSlashInlineRequest} from '../src/editor/database-slash.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function state(doc:string,at=doc.length){return EditorState.create({doc,selection:{anchor:at},extensions:[markdown({base:markdownLanguage,extensions:[frontmatterMarkdown]})]});}
async function fixture(t:TestContext,extra:Partial<DatabaseSlashOptions>={}){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const rect=()=>({top:0,left:0,right:100,bottom:20,width:100,height:20,x:0,y:0,toJSON(){return{};}});dom.window.Range.prototype.getBoundingClientRect=rect;dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
 let lease={},current=true;const errors:unknown[]=[],page:DatabaseSlashPageRequest[]=[],inline:DatabaseSlashInlineRequest[]=[];
 const view=new EditorView({parent:dom.window.document.querySelector('main')!,state:EditorState.create({doc:'',extensions:[history(),markdown({base:markdownLanguage,extensions:[frontmatterMarkdown]}),databaseSlash({inline:true,isCurrent:()=>current,captureAuthoring:()=>{const captured=lease;return()=>current&&captured===lease;},onCreateDatabase:request=>{page.push(request);},onInlineDatabaseInserted:request=>{inline.push(request);},onError:error=>{errors.push(error);},...extra})]})});
 t.after(()=>{view.destroy();dom.window.close();for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const type=async(text:string)=>{view.focus();view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},selection:{anchor:text.length}});await tick();};
 const key=(key:string,extra:KeyboardEventInit={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});view.contentDOM.dispatchEvent(event);return event;};
 const menu=()=>dom.window.document.querySelector<HTMLElement>('.cm-database-slash-menu');
 const rows=()=>[...dom.window.document.querySelectorAll<HTMLElement>('.cm-database-slash-option')];
 return{view,dom,type,key,menu,rows,page,inline,errors,retire(){lease={};},deactivate(){current=false;}};
}

test('database slash matches standalone prose only, including an empty slash filter',()=>{
 for(const text of ['/','/database','  /Database','Before\n/database'])assert.ok(databaseSlashContext(state(text)),text);
 for(const text of ['word /database','    /database','/database trailing content!','```\n/database','`/database`','---\nx: y\n/database'])assert.equal(databaseSlashContext(state(text)),null,text);
 assert.equal(databaseSlashContext(state('/database rest',9)),null,'nonempty trailing text is not consumed');
 const selected=state('/database').update({selection:EditorSelection.range(0,9)}).state;assert.equal(databaseSlashContext(selected),null);
});

test('slash filtering, arrows and Escape work without mutating the command',async t=>{
 const f=await fixture(t);await f.type('/');assert.deepEqual(f.rows().map(row=>row.getAttribute('aria-label')),['Database Inline','Database Full page']);
 assert.equal(f.rows()[0].getAttribute('aria-selected'),'true');assert.equal(f.key('ArrowDown').defaultPrevented,true);assert.equal(f.rows()[1].getAttribute('aria-selected'),'true');
 f.key('ArrowUp');assert.equal(f.rows()[0].getAttribute('aria-selected'),'true');f.key('Escape');assert.equal(f.menu(),null);assert.equal(f.view.state.doc.toString(),'/');
 await f.type('/database');assert.equal(f.rows().length,2);await f.type('/inline');assert.deepEqual(f.rows().map(row=>row.getAttribute('aria-label')),['Database Inline']);
 await f.type('/unavailable');assert.equal(f.menu(),null);assert.deepEqual(f.page,[]);assert.deepEqual(f.inline,[]);
});

test('Enter inserts the inline Base fence in one undo step and calls the focus/setup hook',async t=>{
 const f=await fixture(t);await f.type('/database');f.key('Enter');await tick();
 assert.equal(f.view.state.doc.toString(),'```base\nviews: []\n```\n');assert.equal(f.menu(),null);assert.equal(f.inline.length,1);assert.equal(f.inline[0].layout,'table');assert.equal(f.inline[0].isCurrent(),true);assert.equal(f.view.hasFocus,true);
 assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'/database');assert.equal(f.inline[0].isCurrent(),false);assert.deepEqual(f.errors,[]);
});

test('pointer selection preserves editor focus and full-page creation keeps its exact command until the host succeeds',async t=>{
 let release:()=>void=()=>{};const accepted:DatabaseSlashPageRequest[]=[];
 const f=await fixture(t,{onCreateDatabase:request=>{accepted.push(request);return new Promise<void>(resolve=>{release=resolve;});}});await f.type('/database');
 const row=f.rows()[1],down=new f.dom.window.MouseEvent('mousedown',{bubbles:true,cancelable:true});row.dispatchEvent(down);assert.equal(down.defaultPrevented,true);assert.equal(f.view.hasFocus,true);
 row.click();row.click();f.key('Enter');await tick();assert.equal(accepted.length,1);assert.equal(f.view.state.doc.toString(),'/database','the host retains the exact command while creation is pending');assert.equal(accepted[0].isCurrent(),true);
 f.view.dispatch({changes:{from:9,insert:' changed'}});assert.equal(accepted[0].isCurrent(),false,'typing retires the exact pending command');release();await tick();
});

test('full-page Enter accepts once and captured request rejects selection/lease changes',async t=>{
 const f=await fixture(t);await f.type('/database');f.key('ArrowDown');f.key('Enter');await tick();assert.equal(f.page.length,1);assert.equal(f.view.state.doc.toString(),'/database');assert.equal(f.page[0].from,0);assert.equal(f.page[0].to,9);assert.equal(f.page[0].isCurrent(),true);
 f.retire();assert.equal(f.page[0].isCurrent(),false);
});

test('only supported commands appear and readonly/IME/stale editor actions cannot create a database',async t=>{
 const f=await fixture(t,{onCreateDatabase:undefined});await f.type('/database');assert.deepEqual(f.rows().map(row=>row.getAttribute('aria-label')),['Database Inline']);
 const retired=f.rows()[0];await f.type('/unavailable');retired.click();assert.equal(f.view.state.doc.toString(),'/unavailable');assert.deepEqual(f.inline,[]);
 await f.type('/database');f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.key('Enter',{isComposing:true});assert.deepEqual(f.inline,[]);assert.equal(f.view.state.doc.toString(),'/database');f.view.contentDOM.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
 await f.type('/database');f.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});assert.equal(f.menu(),null);f.key('Enter');assert.deepEqual(f.inline,[]);
});
