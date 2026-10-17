import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorView} from '@codemirror/view';
import {EditorSelection,EditorState,StateEffect} from '@codemirror/state';
import {undo} from '@codemirror/commands';
import {Workspace} from '../src/ui/workspace.ts';
import type {WorkspaceViewFactories} from '../src/ui/workspace.ts';
import {createEditor} from '../src/ui/editor.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {EDITOR_HOTKEY_COMMANDS} from '../src/ui/hotkeys.ts';

// Real Workspace and CodeMirror ownership, with synthetic geometry. Native
// focus/IME/pointer behavior requires a separate Electron verification pass.
async function setup(t:TestContext,adapter=new MemoryAdapter({'A.md':'Alpha','B.md':'Bravo','C.md':'Charlie','Target.md':'Target'}),factories:WorkspaceViewFactories={}){
  const dom=new JSDOM('<!doctype html><body><div id="app"></div>',{url:'https://zorid.test/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  const matchMedia=(media:string)=>({matches:false,media,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,Text:dom.window.Text,Window:dom.window.Window,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),matchMedia})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=matchMedia as typeof window.matchMedia;
  const rect=()=>({top:0,left:0,right:1000,bottom:600,width:1000,height:600,x:0,y:0,toJSON(){return{};}});
  dom.window.Range.prototype.getBoundingClientRect=rect;
  dom.window.Range.prototype.getClientRects=()=>Object.assign([],{item:()=>null});
  const root=document.querySelector<HTMLElement>('#app')!;
  const workspace=new Workspace(root,createEditor,factories);
  t.after(async()=>{try{await workspace.destroy();}finally{dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}});
  await workspace.start({adapter,id:'test:docking',label:'Test'});
  return{dom,root,workspace,adapter};
}

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function editor(workspace:Workspace){return EditorView.findFromDOM(workspace.activePane.element.querySelector('.editor-host > .cm-editor')!)!;}
function select(view:EditorView,text:string){const from=view.state.doc.toString().indexOf(text);assert.notEqual(from,-1);view.focus();view.dispatch({selection:EditorSelection.range(from,from+text.length)});}
function rows(){return [...document.querySelectorAll<HTMLElement>('.command-modal .suggestion')];}
function editorRows(){return rows().filter(row=>EDITOR_HOTKEY_COMMANDS.some(command=>row.querySelector('span')?.textContent===command.name));}
async function choose(name='Editor: Insert link'){const row=rows().find(row=>row.querySelector('span')?.textContent===name);assert.ok(row,`${name} is available`);row.click();await tick();}
async function dismiss(){document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();}
function childEditor(workspace:Workspace){
  const cell=workspace.activePane.element.querySelector<HTMLElement>('td[data-row="1"][data-column="0"]')!;assert.ok(cell);
  cell.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
  const child=EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;assert.ok(child);child.focus();return child;
}

test('palette preserves workspace commands and edits the captured note selection in one undo step',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');
  workspace.commandPalette();assert.equal(editorRows().length,EDITOR_HOTKEY_COMMANDS.length);assert.ok(rows().some(row=>row.textContent?.includes('Create new note')));
  await choose();assert.equal(view.state.doc.toString(),'[Alpha]()');assert.equal(view.hasFocus,true);
  await workspace.flush();assert.equal(await adapter.read('A.md'),'[Alpha]()');assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),'Alpha');
});

test('palette toolbar preserves a focused note selection and rejects a focused title',async t=>{
  const{workspace,root}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');
  const button=root.querySelector<HTMLButtonElement>('button[data-hotkey-command="command-palette"]')!;
  const down=new window.MouseEvent('pointerdown',{bubbles:true,cancelable:true});button.dispatchEvent(down);assert.equal(down.defaultPrevented,true);button.click();await choose();assert.equal(view.state.doc.toString(),'[Alpha]()');
  const title=workspace.activePane.element.querySelector<HTMLInputElement>('.note-title')!;title.focus();button.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,cancelable:true}));button.click();assert.equal(editorRows().length,0);await dismiss();assert.equal(view.state.doc.toString(),'[Alpha]()');
});

test('title, property, search and foreign text controls never borrow a note selection',async t=>{
  const{workspace,root}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');
  const title=workspace.activePane.element.querySelector<HTMLInputElement>('.note-title')!;
  for(const container of [null,workspace.activePane.element.querySelector('.properties-host')!,view.dom,root]){
    const input=container?document.createElement('input'):title;
    if(container){if(container===view.dom)input.className='cm-search';container.append(input);}
    input.focus();workspace.commandPalette();assert.equal(editorRows().length,0);await dismiss();if(container)input.remove();
  }
  assert.equal(view.state.doc.toString(),'Alpha');
});

test('a palette opened in Reading or Canvas exposes no note insertion commands',async t=>{
  const{workspace}=await setup(t,new MemoryAdapter({'A.md':'Alpha','Board.canvas':'{"nodes":[],"edges":[]}'}));
  await workspace.openNote('A.md');await(workspace as any).toggleReading();workspace.commandPalette();assert.equal(editorRows().length,0);await dismiss();
  await workspace.openNote('Board.canvas');workspace.commandPalette();assert.equal(editorRows().length,0);await dismiss();
});

test('navigation while the palette is open does not edit the captured or replacement note',async t=>{
  const{workspace,adapter}=await setup(t);await workspace.openNote('A.md');const first=editor(workspace);select(first,'Alpha');workspace.commandPalette();
  await workspace.openNote('B.md',true);const second=editor(workspace);await choose();
  assert.equal(first.state.doc.toString(),'Alpha');assert.equal(second.state.doc.toString(),'Bravo');await workspace.flush();assert.equal(await adapter.read('A.md'),'Alpha');assert.equal(await adapter.read('B.md'),'Bravo');
});

test('changes to the captured document or selection invalidate the insertion',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');workspace.commandPalette();
  view.dispatch({changes:{from:5,insert:' peer'}});await choose();assert.equal(view.state.doc.toString(),'Alpha peer');
  select(view,'Alpha');workspace.commandPalette();view.dispatch({selection:{anchor:5}});await choose();assert.equal(view.state.doc.toString(),'Alpha peer');
});

test('modal focus restoration is revalidated before the insertion runs',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');workspace.commandPalette();
  view.contentDOM.addEventListener('focus',()=>{(workspace as any).navigationIntent.set(workspace.activePane,999);},{once:true});
  await choose();assert.equal(view.state.doc.toString(),'Alpha');
});

test('a focus handler changing selection during target refocus cannot redirect the insertion',async t=>{
  const{workspace,root}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');
  // Keyboard-focus on the toolbar is supported using the last note selection.
  root.querySelector<HTMLButtonElement>('button[data-hotkey-command="command-palette"]')!.focus();workspace.commandPalette();
  view.contentDOM.addEventListener('focus',()=>view.dispatch({selection:{anchor:5}}),{once:true});
  await choose();assert.equal(view.state.doc.toString(),'Alpha');
});

test('read-only and composition guards apply at capture and again after opening',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');
  view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));workspace.commandPalette();assert.equal(editorRows().length,0);await dismiss();
  view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));await tick();
  // The readonly facet can change while a palette already owns focus.
  select(view,'Alpha');workspace.commandPalette();view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});await choose();assert.equal(view.state.doc.toString(),'Alpha');
  view.focus();workspace.commandPalette();assert.equal(editorRows().length,0);await dismiss();
});

test('palette retains a table child through blur and applies only to the captured cell',async t=>{
  const source='| A | B |\n| --- | --- |\n| word | other |';const{workspace}=await setup(t,new MemoryAdapter({'A.md':source}));await workspace.openNote('A.md');const child=childEditor(workspace);select(child,'word');
  workspace.commandPalette();await tick();assert.equal(child.dom.isConnected,true);await choose();assert.match(workspace.activePane.editor!.getValue(),/\| \[word\]\(\) \| other \|/);assert.equal(child.hasFocus,true);
});

test('Escape and backdrop cancellation release table retention without changing content',async t=>{
  const source='| A | B |\n| --- | --- |\n| word | other |';const{workspace}=await setup(t,new MemoryAdapter({'A.md':source}));await workspace.openNote('A.md');
  for(const backdrop of [false,true]){
    const child=childEditor(workspace);select(child,'word');workspace.commandPalette();await tick();assert.equal(child.dom.isConnected,true);
    if(backdrop){document.querySelector('.modal-overlay')!.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));await tick();}else await dismiss();
    assert.equal(child.hasFocus,true);workspace.activePane.element.querySelector<HTMLInputElement>('.note-title')!.focus();await tick();assert.equal(child.dom.isConnected,false);assert.equal(workspace.activePane.editor!.getValue(),source);
  }
});


test('palette uses the shared catalogue for formatting, folding and syntax selection',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');workspace.commandPalette();
  for(const name of ['Editor: Toggle bold','Editor: Fold all','Editor: Select parent syntax'])assert.ok(rows().some(row=>row.querySelector('span')?.textContent===name));
  await choose('Editor: Toggle bold');assert.equal(view.state.doc.toString(),'**Alpha**');assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),'Alpha');
});


test('palette composition Enter commits search input without executing a command',async t=>{
  const{workspace}=await setup(t);await workspace.openNote('A.md');const view=editor(workspace);select(view,'Alpha');workspace.commandPalette();
  const input=document.querySelector<HTMLInputElement>('.command-input')!;input.value='Editor: Insert link';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  for(const init of [{isComposing:true},{keyCode:229}]){
    const event=new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...init});input.dispatchEvent(event);await tick();
    assert.equal(event.defaultPrevented,false);assert.equal(input.isConnected,true);assert.equal(view.state.doc.toString(),'Alpha');
  }
  input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.equal(view.state.doc.toString(),'[Alpha]()');
});
