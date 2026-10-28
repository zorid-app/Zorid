import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorState,EditorSelection,StateEffect} from '@codemirror/state';
import type {Extension} from '@codemirror/state';
import {history,undo} from '@codemirror/commands';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {frontmatterMarkdown} from '../src/editor/frontmatter-syntax.ts';
import {databaseSlash,databaseSlashContext} from '../src/editor/database-slash.ts';
import type {DatabaseSlashOptions,DatabaseSlashPageRequest,DatabaseSlashInlineRequest} from '../src/editor/database-slash.ts';
import {wikiCompletion} from '../src/editor/wiki-completion.ts';
import {completionStatus} from '@codemirror/autocomplete';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function state(doc:string,at=doc.length){return EditorState.create({doc,selection:{anchor:at},extensions:[markdown({base:markdownLanguage,extensions:[frontmatterMarkdown]})]});}
async function fixture(t:TestContext,extra:Partial<DatabaseSlashOptions>={},before:Extension=[]){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const rect=()=>({top:0,left:0,right:100,bottom:20,width:100,height:20,x:0,y:0,toJSON(){return{};}});dom.window.Range.prototype.getBoundingClientRect=rect;dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
 let lease={},current=true;const errors:unknown[]=[],page:DatabaseSlashPageRequest[]=[],inline:DatabaseSlashInlineRequest[]=[];
 const view=new EditorView({parent:dom.window.document.querySelector('main')!,state:EditorState.create({doc:'',extensions:[history(),markdown({base:markdownLanguage,extensions:[frontmatterMarkdown]}),before,databaseSlash({inline:true,isCurrent:()=>current,captureAuthoring:()=>{const captured=lease;return()=>current&&captured===lease;},onCreateDatabase:request=>{page.push(request);},onInlineDatabaseInserted:request=>{inline.push(request);},onError:error=>{errors.push(error);},...extra})]})});
 view.coordsAtPos=()=>({left:10,right:10,top:10,bottom:30});
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

test('slash context recognizes genuine empty top-level heading, list, task and quote blocks',()=>{
 for(const source of ['# /h2','## /','###### /text','- /quote','+ /h1','* /text','1. /h2','42) /h3','- [ ] /heading','- [x] /text','> /','>/h1','  ## /h1']){const context=databaseSlashContext(state(source));assert.ok(context,source);assert.equal(context.from,0);assert.equal(context.to,source.length);}
 for(const source of ['####### /h1','###\t/h1','- ordinary /h1','## ordinary /text','word /h1','> - /h1','> ## /h1','>> /h1','- > /h1','- parent\n  - /h1','- parent\n  /h1','- parent\n  ## /h1','> parent\n/heading','```\n## /h1','    - /h1'])assert.equal(databaseSlashContext(state(source)),null,source);
});

test('a top-level marker cannot be converted when its container owns following child or continuation lines',()=>{
 for(const source of ['- /h1\n  - child','- /h1\n  continued text','- [ ] /h1\n  - child','1. /h1\n   continued text','> /h1\ncontinued text','> /h1\n> child','- /database\n  - child','> /database\ncontinued text'])assert.equal(databaseSlashContext(state(source,source.indexOf('\n'))),null,source);
 for(const source of ['- /h1\n- sibling','1. /h1\n2. sibling','> /h1\n\nOutside','## /h1\nOutside'])assert.ok(databaseSlashContext(state(source,source.indexOf('\n'))),source);
});

test('following list children keep their hierarchy when a database slash query is typed in the parent',async t=>{
 const f=await fixture(t);const source='- /database\n  - Child text';await f.type(source);f.view.dispatch({selection:{anchor:11}});await tick();assert.equal(f.menu(),null);assert.equal(f.view.state.doc.toString(),source);f.key('Enter');await tick();assert.equal(f.inline.length,0);assert.equal(f.page.length,0);assert.ok(f.view.state.doc.toString().includes('- /database'));assert.ok(f.view.state.doc.toString().includes('\n  - Child text'));assert.equal(f.view.state.doc.toString().includes('```base'),false);
});

test('slash can reopen after choosing Heading 2 and replace its marker in one undo unit',async t=>{
 const f=await fixture(t);await f.type('/h2');f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),'## ');f.view.dispatch({changes:{from:3,insert:'/h3'},selection:{anchor:6}});await tick();assert.equal(f.rows()[0].getAttribute('aria-label'),'Heading 3');f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),'### ');assert.equal(f.view.hasFocus,true);assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'## /h3');
});

test('empty block conversions replace rather than duplicate their captured marker and preserve surrounding text',async t=>{
 const f=await fixture(t);for(const source of ['## /text','- /text','1. /text','- [ ] /text','> /text']){await f.type(`Before\n\n${source}\n\nAfter`);const at=8+source.length;f.view.dispatch({selection:{anchor:at}});await tick();assert.equal(f.rows()[0].getAttribute('aria-label'),'Text',source);f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),'Before\n\n\n\nAfter');assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),`Before\n\n${source}\n\nAfter`);f.key('Escape');}
});

test('database insertion from an empty heading consumes the old block marker under the same guarded hook',async t=>{
 const f=await fixture(t);await f.type('## /database');assert.equal(f.rows().length,2);f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),'```base\nviews: []\n```\n');assert.equal(f.inline[0].from,0);assert.equal(f.inline[0].to,f.view.state.doc.length);assert.equal(f.inline[0].isCurrent(),true);assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'## /database');
});

test('slash filtering, arrows and Escape work without mutating the command',async t=>{
 const f=await fixture(t);await f.type('/');assert.equal(f.rows()[0].getAttribute('aria-label'),'Text');assert.ok(f.rows().some(row=>row.getAttribute('aria-label')==='Heading 3'));assert.ok(f.rows().some(row=>row.getAttribute('aria-label')==='Database Full page'));assert.deepEqual([...f.menu()!.querySelectorAll('.cm-slash-command-heading')].map(node=>node.textContent),['Basic blocks','Media','Database','Advanced blocks']);
 assert.equal(f.rows()[0].getAttribute('aria-selected'),'true');assert.equal(f.key('ArrowDown').defaultPrevented,true);assert.equal(f.rows()[1].getAttribute('aria-selected'),'true');
 f.key('ArrowUp');assert.equal(f.rows()[0].getAttribute('aria-selected'),'true');f.key('Escape');assert.equal(f.menu(),null);assert.equal(f.view.state.doc.toString(),'/');
 await f.type('/database');assert.equal(f.rows().length,2);await f.type('/inline');assert.deepEqual(f.rows().map(row=>row.getAttribute('aria-label')),['Database Inline']);
 await f.type('/unavailable');assert.equal(f.rows().length,0);assert.equal(f.menu()?.querySelector('[role="status"]')?.textContent,'No results');assert.deepEqual(f.page,[]);assert.deepEqual(f.inline,[]);
});

test('one Escape closes the visible slash menu before an earlier wiki completion can consume it',async t=>{
 const f=await fixture(t,{},wikiCompletion({paths:()=>['Code.md']}));let outer=0;f.view.dom.parentElement!.addEventListener('keydown',()=>{outer++;});f.view.focus();f.view.dispatch({changes:{from:0,insert:'/code'},selection:{anchor:5},userEvent:'input.type'});assert.equal(completionStatus(f.view.state),'pending');assert.ok(f.menu());assert.equal(f.view.dom.querySelector('.cm-tooltip-autocomplete'),null);const event=f.key('Escape');assert.equal(event.defaultPrevented,true);assert.equal(f.menu(),null,'a pending invisible completion must not consume the visible menu first');assert.equal(f.view.state.doc.toString(),'/code');assert.equal(f.view.hasFocus,true);assert.equal(outer,0,'the same Escape must not also dismiss an enclosing editor surface');
});

test('slash Escape ownership excludes composition, modifiers and previously prevented events',async t=>{
 const f=await fixture(t,{},wikiCompletion({paths:()=>['Code.md']}));await f.type('/code');
 for(const extra of [{isComposing:true},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true}]){f.key('Escape',extra);assert.ok(f.menu());assert.equal(f.view.state.doc.toString(),'/code');}
 const prevented=new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});prevented.preventDefault();f.view.contentDOM.dispatchEvent(prevented);assert.ok(f.menu());f.key('Escape');assert.equal(f.menu(),null);assert.equal(f.view.hasFocus,true);
});

test('Escape still closes an actual wiki completion when the slash menu is absent',async t=>{
 const f=await fixture(t,{},wikiCompletion({paths:()=>['Code.md']}));f.view.focus();f.view.dispatch({changes:{from:0,insert:'[[Co'},selection:{anchor:4},userEvent:'input.type'});for(let n=0;n<50&&completionStatus(f.view.state)!=='active';n++)await tick();assert.equal(completionStatus(f.view.state),'active');assert.equal(f.menu(),null);assert.equal(f.key('Escape').defaultPrevented,true);assert.equal(completionStatus(f.view.state),null);assert.equal(f.view.state.doc.toString(),'[[Co');assert.equal(f.view.hasFocus,true);
});

test('supported block acceptance replaces its query in one undo step and preserves editor focus',async t=>{
 const f=await fixture(t);for(const[query,expected]of[['/h2','## '],['/todo','- [ ] '],['/code','```\n\n```'],['/image','![]()']]as const){await f.type(query);assert.equal(f.rows().length,1);f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),expected);assert.equal(f.menu(),null);assert.equal(f.view.hasFocus,true);assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),query);f.key('Escape');}assert.deepEqual(f.errors,[]);
});

test('hover and boundary keys share the active command while descriptions remain accessible',async t=>{
 const f=await fixture(t);await f.type('/');const rows=f.rows();f.key('End');assert.equal(rows.at(-1)?.getAttribute('aria-selected'),'true');f.key('Home');assert.equal(rows[0].getAttribute('aria-selected'),'true');rows[3].dispatchEvent(new f.dom.window.MouseEvent('pointermove',{bubbles:true}));assert.equal(rows[3].getAttribute('aria-selected'),'true');assert.equal(f.view.contentDOM.getAttribute('aria-activedescendant'),rows[3].id);assert.equal(f.view.hasFocus,true);assert.ok(f.dom.window.document.getElementById(rows[3].getAttribute('aria-describedby')!)?.textContent);
 f.key('Enter');await tick();assert.equal(f.view.state.doc.toString(),'### ');
});

test('Tab and outside pointer dismiss without authoring a block or stealing the next focus',async t=>{
 const f=await fixture(t);await f.type('/heading');assert.equal(f.key('Tab').defaultPrevented,false);assert.equal(f.menu(),null);assert.equal(f.view.state.doc.toString(),'/heading');await f.type('/table');const outside=f.dom.window.document.createElement('button');outside.textContent='Outside';f.dom.window.document.body.append(outside);outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));outside.focus();assert.equal(f.menu(),null);assert.equal(f.view.state.doc.toString(),'/table');assert.equal(f.dom.window.document.activeElement,outside);assert.equal(f.view.contentDOM.getAttribute('aria-activedescendant'),null);
});

test('popup styling contains a reduced-motion override and stale supported rows cannot author',async t=>{
 const f=await fixture(t);await f.type('/quote');const row=f.rows()[0];await f.type('/h1');row.click();assert.equal(f.view.state.doc.toString(),'/h1');f.deactivate();f.rows()[0].click();assert.equal(f.view.state.doc.toString(),'/h1');assert.match([...f.dom.window.document.querySelectorAll('style')].map(style=>style.textContent).join('\n'),/prefers-reduced-motion:\s*reduce/);
});

test('popup placement flips above a lower caret and follows ancestor scrolling and viewport resizing',async t=>{
 const f=await fixture(t);let rect={left:480,right:482,top:380,bottom:400};Object.defineProperty(f.dom.window,'innerWidth',{configurable:true,value:520});Object.defineProperty(f.dom.window,'innerHeight',{configurable:true,value:420});f.view.coordsAtPos=()=>rect;
 await f.type('/');const menu=f.menu()!;Object.defineProperty(menu,'offsetWidth',{configurable:true,value:300});Object.defineProperty(menu,'offsetHeight',{configurable:true,value:280});f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));await new Promise(resolve=>setTimeout(resolve,35));assert.equal(menu.dataset.placement,'above');assert.equal(menu.style.left,'212px');assert.equal(menu.style.top,'94px');
 rect={left:20,right:22,top:20,bottom:40};f.view.dom.parentElement!.dispatchEvent(new f.dom.window.Event('scroll'));await new Promise(resolve=>setTimeout(resolve,35));assert.equal(menu.dataset.placement,'below');assert.equal(menu.style.left,'20px');assert.equal(menu.style.top,'46px');
  rect={left:20,right:22,top:-100,bottom:-80};f.view.dom.parentElement!.dispatchEvent(new f.dom.window.Event('scroll'));await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.menu(),null,'a scrolled-out anchor must not leave a floating detached command menu');assert.equal(f.view.state.doc.toString(),'/');
});

test('dismissal releases only the slash-owned accessible controls',async t=>{
 const f=await fixture(t);f.view.contentDOM.setAttribute('aria-controls','other-widget');await f.type('/');assert.match(f.view.contentDOM.getAttribute('aria-controls')!,/other-widget database-slash-/);f.view.contentDOM.setAttribute('aria-activedescendant','foreign-option');f.key('Escape');assert.equal(f.view.contentDOM.getAttribute('aria-controls'),'other-widget');assert.equal(f.view.contentDOM.getAttribute('aria-activedescendant'),'foreign-option');
});

test('authoring admission revoked while a menu is open prevents supported block insertion',async t=>{
 let admitted=true;const f=await fixture(t,{captureAuthoring:()=>admitted?()=>admitted:null});await f.type('/h1');const row=f.rows()[0];admitted=false;row.click();assert.equal(f.view.state.doc.toString(),'/h1');assert.equal(f.page.length,0);assert.equal(f.inline.length,0);
});

test('a footnote command is unavailable when its end-of-note insertion would enter an unclosed fence',async t=>{
 const f=await fixture(t);await f.type('/footnote\n\n```\ncode');f.view.dispatch({selection:{anchor:9}});await tick();assert.equal(f.rows().length,0);assert.equal(f.menu()?.querySelector('[role="status"]')?.textContent,'No results');assert.equal(f.view.state.doc.toString(),'/footnote\n\n```\ncode');
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
