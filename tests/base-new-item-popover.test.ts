import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { openBaseNewItemPopover } from '../src/ui/base-new-item-popover.ts';
import type { BaseNewItemPopoverOptions } from '../src/ui/base-new-item-popover.ts';
import type { EditorOptions, EditorHandle } from '../src/ui/editor.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function setup(source = '---\nstatus: Todo\n---\n# Copied template\nLiteral {{date}}', overrides: Partial<BaseNewItemPopoverOptions> = {}) {
  const dom = new JSDOM('<button id="new">New</button><button id="sibling">Sibling</button>', { pretendToBeVisual: true });
  const anchor = dom.window.document.querySelector<HTMLButtonElement>('#new')!;
  const adapter = new MemoryAdapter({ 'Untitled.md': source }), vault = new Vault(adapter); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'Untitled.md', { debounceMs: 60_000 }); await buffer.load();
  const errors: unknown[] = [], opened: string[] = [], editorOptions: EditorOptions[] = [];
  let destroyedEditor = 0, closed = 0, value = '';
  const factory = (parent: HTMLElement, options: EditorOptions): EditorHandle => { editorOptions.push(options); value = options.value; const input = parent.ownerDocument.createElement('textarea'); parent.append(input); return { getValue: () => value, setValue: next => { value = next; }, focus: () => input.focus(), destroy: () => { destroyedEditor++; input.remove(); }, insert() {} }; };
  const handle = await openBaseNewItemPopover({ anchor, vault, path: 'Untitled.md', getBuffer: async () => buffer, validate() {},
    rename: async (_path, destination, validate) => { validate(); await buffer.rename(destination); }, openFile: path => { opened.push(path); }, onError: error => { errors.push(error); }, onClose: () => { closed++; }, editorFactory: factory, ...overrides,
  });
  const title = handle.element.querySelector<HTMLElement>('.inline-title')!;
  return { dom, anchor, adapter, vault, buffer, handle, title, errors, opened, editorOptions, get destroyedEditor() { return destroyedEditor; }, get closed() { return closed; },
    setTitle(value: string) { title.textContent = value; title.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
    async cleanup() { if (handle.element.isConnected) { title.textContent = buffer.path.replace(/\.md$/i, ''); try { await handle.close(); } catch {} } await buffer.dispose(); dom.window.close(); },
  };
}

test('New focuses and selects DIV title of already saved note without mounting body editor', async () => {
  const s = await setup(); assert.equal(s.title.tagName, 'DIV'); assert.equal(s.title.contentEditable, 'true'); assert.equal(s.dom.window.document.activeElement, s.title); assert.equal(s.dom.window.getSelection()!.toString(), 'Untitled'); assert.equal(s.editorOptions.length, 0);
  assert.equal(s.handle.element.style.width, '452px'); assert.equal(s.handle.element.querySelector('.metadata-properties-heading')!.getAttribute('aria-expanded'), 'false'); assert.match(s.handle.element.textContent!, /Literal \{\{date\}\}/); assert.equal(s.handle.hasPendingChanges(), false); await s.cleanup();
});

async function untilPeek(check:()=>boolean) { for(let i=0;i<100&&!check();i++)await tick();assert.ok(check()); }

test('side peek uses a viewport pane and opens existing rows without selecting or editing their title',async()=>{
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,bodyExpanded:true,propertiesExpanded:true});
  try{
    assert.equal(s.handle.element.getAttribute('aria-label'),'Page preview');assert.ok(s.handle.element.classList.contains('is-side-peek'));
    assert.equal(s.handle.element.style.width,'600px');assert.equal(s.handle.element.style.left,'424px');assert.equal(s.handle.element.style.top,'0px');assert.equal(s.handle.element.style.height,'768px');
    assert.equal(s.dom.window.document.activeElement,s.handle.element);assert.notEqual(s.dom.window.getSelection()?.toString(),'Untitled');
    assert.equal(s.editorOptions.length,1);assert.equal(s.handle.element.querySelector('.metadata-properties-heading')!.getAttribute('aria-expanded'),'true');
    assert.ok(s.handle.element.querySelector('.bases-page-peek-header [aria-label="Close preview"]'));
    assert.ok(s.handle.element.querySelector('.bases-page-peek-header [aria-label="Open as full page"]'));
    assert.equal(s.handle.hasPendingChanges(),false);
    Object.defineProperty(s.dom.window,'innerWidth',{value:320,configurable:true});Object.defineProperty(s.dom.window,'innerHeight',{value:480,configurable:true});s.dom.window.dispatchEvent(new s.dom.window.Event('resize'));
    assert.equal(s.handle.element.style.width,'320px');assert.equal(s.handle.element.style.left,'0px');assert.equal(s.handle.element.style.height,'480px');
  }finally{await s.cleanup();}
});

test('existing peek title participates in sequential focus without changing initial focus or selection',async()=>{
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,bodyExpanded:true});
  try{
    assert.equal(s.dom.window.document.activeElement,s.handle.element);
    assert.equal(s.dom.window.getSelection()?.toString(),'');
    const stops=[...s.handle.element.querySelectorAll<HTMLElement>('button,input,textarea,[contenteditable="true"],[tabindex]')]
      .filter(node=>node.tabIndex>=0&&!node.closest('[hidden]'));
    const close=s.handle.element.querySelector<HTMLElement>('[aria-label="Close preview"]')!;
    const open=s.handle.element.querySelector<HTMLElement>('[aria-label="Open as full page"]')!;
    assert.deepEqual(stops.slice(0,3),[close,open,s.title]);
    s.title.focus();assert.equal(s.dom.window.document.activeElement,s.title);
    assert.equal(s.handle.hasPendingChanges(),false);assert.equal(s.buffer.path,'Untitled.md');
  }finally{await s.cleanup();}
});

test('peek command hints survive a rejected close and release on successful close',async()=>{
  let rejectClose=true;
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,closeEditor:async()=>{if(rejectClose)throw new Error('Child draft retained');}});
  try{
    const doc=s.dom.window.document;
    await assert.rejects(s.handle.close(),/Child draft retained/);
    assert.equal(s.handle.element.isConnected,true);rejectClose=false;
    for(const label of ['Close preview','Open as full page']){
      const control=s.handle.element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      control.focus();
      const hint=doc.querySelector<HTMLElement>('[role="tooltip"]');assert.ok(hint);
      assert.equal(hint.querySelector('.bases-tooltip-label')!.textContent,label);
      assert.equal(control.getAttribute('aria-describedby'),hint.id);
      assert.equal(doc.activeElement,control);assert.equal(control.hasAttribute('title'),false);
    }
    const open=doc.activeElement as HTMLElement;
    await s.handle.close();assert.equal(doc.querySelector('[role="tooltip"]'),null);
    assert.equal(open.hasAttribute('aria-describedby'),false);
    doc.body.append(s.handle.element);open.focus();
    assert.equal(doc.querySelector('[role="tooltip"]'),null,'closed previews release delegated hint listeners');
    s.handle.element.remove();
  }finally{await s.cleanup();}
});

test('peek hover hints appear and closing cancels pending hover work',async()=>{
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false});
  try{
    const close=s.handle.element.querySelector<HTMLElement>('[aria-label="Close preview"]')!;
    close.dispatchEvent(new s.dom.window.MouseEvent('pointerover',{bubbles:true}));
    assert.equal(s.dom.window.document.querySelector('[role="tooltip"]'),null);
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(s.dom.window.document.querySelector('[role="tooltip"]')?.textContent,'Close preview');
    close.dispatchEvent(new s.dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:s.title}));
    assert.equal(s.dom.window.document.querySelector('[role="tooltip"]'),null);
    close.dispatchEvent(new s.dom.window.MouseEvent('pointerover',{bubbles:true}));
    await s.handle.close();await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(s.dom.window.document.querySelector('[role="tooltip"]'),null);
  }finally{await s.cleanup();}
});

test('side peek Close retains failed body drafts and closes only after the same shared save succeeds',async()=>{
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,bodyExpanded:true});
  const write=s.adapter.write.bind(s.adapter);let fail=true;s.adapter.write=async(path,text)=>{if(fail)throw new Error('Peek disk unavailable');await write(path,text);};
  try{
    s.editorOptions[0].onChange(s.buffer.text+'\nRetained peek body');
    const close=s.handle.element.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!;close.focus();close.click();
    await untilPeek(()=>s.errors.length>0);assert.ok(s.handle.element.isConnected);assert.equal(s.closed,0);assert.equal(s.destroyedEditor,0);assert.match(s.buffer.text,/Retained peek body/);
    fail=false;close.click();await untilPeek(()=>!s.handle.element.isConnected);assert.equal(s.closed,1);assert.equal(s.destroyedEditor,1);assert.equal(s.dom.window.document.activeElement,s.anchor);assert.match(await s.adapter.read('Untitled.md'),/Retained peek body/);
  }finally{fail=false;await s.cleanup();}
});

test('side peek full-page action waits for save and close without restoring focus behind the page',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  let savedAtOpen='',focusAtOpen:Element|null=null,s:Awaited<ReturnType<typeof setup>>;
  s=await setup(undefined,{presentation:'side-peek',focusTitle:false,bodyExpanded:true,closeEditor:async()=>{entered();await gate;},openFile:async path=>{savedAtOpen=await s.adapter.read(path);focusAtOpen=s.dom.window.document.activeElement;s.opened.push(path);}});
  try{
    s.editorOptions[0].onChange(s.buffer.text+'\nSaved before full page');
    const open=s.handle.element.querySelector<HTMLButtonElement>('[aria-label="Open as full page"]')!;open.focus();open.click();await started;
    assert.deepEqual(s.opened,[]);assert.ok(s.handle.element.isConnected);release();await untilPeek(()=>s.opened.length===1);
    assert.equal(s.handle.element.isConnected,false);assert.match(savedAtOpen,/Saved before full page/);assert.notEqual(focusAtOpen,s.anchor);
  }finally{release();await s.cleanup();}
});

test('side peek Close cannot restore focus moved outside while an accepted save settles',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,closeEditor:async()=>{entered();await gate;}});
  try{
    const close=s.handle.element.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!;close.focus();close.click();await started;
    const sibling=s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!;sibling.focus();sibling.dispatchEvent(new s.dom.window.MouseEvent('pointerdown',{bubbles:true}));release();await untilPeek(()=>!s.handle.element.isConnected);
    assert.equal(s.dom.window.document.activeElement,sibling);
  }finally{release();await s.cleanup();}
});

test('lazy side peek editor mounting leaves newer outside focus alone',async()=>{
  let release!:(editor:EditorHandle)=>void;const gate=new Promise<EditorHandle>(resolve=>{release=resolve;});let focused=0;
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,editorFactory:()=>gate});
  try{
    const loading=s.handle.expandBody();const sibling=s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!;sibling.focus();
    release({getValue:()=>s.buffer.text,setValue(){},focus(){focused++;},destroy(){},insert(){}});await loading;
    assert.equal(focused,0);assert.equal(s.dom.window.document.activeElement,sibling);
  }finally{await s.cleanup();}
});

test('side peek Close cannot restore focus after its window loses focus during close',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const s=await setup(undefined,{presentation:'side-peek',focusTitle:false,closeEditor:async()=>{entered();await gate;}});
  try{
    const close=s.handle.element.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!;close.focus();close.click();await started;s.dom.window.dispatchEvent(new s.dom.window.Event('blur'));release();
    await untilPeek(()=>!s.handle.element.isConnected);assert.notEqual(s.dom.window.document.activeElement,s.anchor);
  }finally{release();await s.cleanup();}
});

test('title Enter does not take focus back after a delayed accepted rename',async()=>{
  let release!:()=>void,entered!:()=>void,s:Awaited<ReturnType<typeof setup>>;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  s=await setup(undefined,{presentation:'side-peek',rename:async(_path,destination,validate)=>{entered();await gate;validate();await s.buffer.rename(destination);}});
  try{
    s.setTitle('Renamed');s.title.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await started;
    const sibling=s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!;sibling.focus();release();await untilPeek(()=>s.editorOptions.length===1);
    assert.equal(s.handle.path,'Renamed.md');assert.equal(s.dom.window.document.activeElement,sibling);
  }finally{release();await s.cleanup();}
});

test('workspace New hides ordinary YAML properties and reveals a late confirmed collection membership',async()=>{
  let managed=false;
  const source='---\n_id: trusted-note\n_type: Books\nrating: 4\n---\nExact body';
  const s=await setup(source,{properties:{managedOnly:true,isManaged:()=>managed,getDefinitions:()=>managed?{rating:{type:'number'}}:{}}});
  try{
    const host=s.handle.element.querySelector<HTMLElement>('.bases-new-item-properties')!;
    assert.equal(host.hidden,true);assert.equal(s.handle.element.classList.contains('has-properties'),false);
    s.handle.refresh();assert.equal(host.hidden,true,'YAML count must not re-show an ordinary panel');
    managed=true;s.handle.refresh();assert.equal(host.hidden,false);assert.equal(s.handle.element.classList.contains('has-properties'),true);
    assert.equal(host.querySelector<HTMLElement>('[data-property-key="_id"]')!.hidden,true);
    assert.equal(host.querySelector<HTMLElement>('[data-property-key="rating"] .metadata-property-value')!.dataset.propertyType,'number');
    managed=false;s.handle.refresh();assert.equal(host.hidden,true);assert.equal(s.buffer.text,source);assert.equal(await s.adapter.read('Untitled.md'),source);
  }finally{await s.cleanup();}
});

test('title rename uses shared buffer and ordinary namespace service; copied full template remains exact', async () => {
  const source = '---\nstatus: Todo\n---\n# Copied template\nLiteral {{date}}'; const s = await setup(source); s.setTitle('My note'); await s.handle.flush();
  assert.equal(s.handle.path, 'My note.md'); assert.equal(s.buffer.path, 'My note.md'); assert.equal(await s.vault.read('My note.md'), source); assert.equal(s.vault.entries.has('Untitled.md'), false); await s.handle.close(); assert.equal(s.closed, 1); await s.cleanup();
});

test('lazy body and property edits share one buffer; properties preserve newer full body', async () => {
  const s = await setup(); await s.handle.expandBody(); assert.equal(s.editorOptions.length, 1); assert.ok(s.handle.element.classList.contains('is-body-expanded'));
  const next = s.buffer.text + '\nUser body'; s.editorOptions[0].validateChange!(next); s.editorOptions[0].onChange(next);
  s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const status = s.handle.element.querySelector<HTMLInputElement>('[aria-label="status value"]')!; status.value = 'Done'; status.dispatchEvent(new s.dom.window.Event('input', { bubbles: true })); status.dispatchEvent(new s.dom.window.Event('change', { bubbles: true })); await tick();
  await s.handle.close(); const saved = await s.vault.read('Untitled.md'); assert.match(saved, /status: Done/); assert.ok(saved.endsWith('User body')); assert.equal(s.destroyedEditor, 1); await s.cleanup();
});

test('failed title rename retains its draft and successful Retry keeps Escape in the popup', async () => {
  let reject = true, s: Awaited<ReturnType<typeof setup>>;
  s = await setup(undefined, { rename: async (_path, destination, validate) => { if (reject) throw new Error('Name collision'); validate(); await s.buffer.rename(destination); } });
  const source = s.buffer.text;
  s.setTitle('Taken'); await assert.rejects(s.handle.close(), /Name collision/); assert.equal(s.title.textContent, 'Taken'); assert.ok(s.handle.element.isConnected); assert.equal(s.closed, 0); assert.equal(s.handle.hasPendingChanges(), true);
  const retry = s.handle.element.querySelector<HTMLButtonElement>('.bases-new-item-retry')!;
  retry.focus(); retry.click(); await tick(); assert.equal(retry.hidden, false); assert.equal(s.title.textContent, 'Taken');
  reject = false; s.setTitle('Recovered popup note'); retry.focus(); retry.click(); await tick();
  assert.equal(s.handle.path, 'Recovered popup note.md'); assert.equal(await s.vault.read(s.handle.path), source); assert.equal(retry.hidden, true); assert.equal(s.dom.window.document.activeElement, s.title);
  s.title.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  assert.equal(s.closed, 1); assert.equal(s.dom.window.document.activeElement, s.anchor); await s.cleanup();
});

test('successful Retry does not take focus moved outside during the save', async () => {
  let release!: () => void, started!: () => void, s: Awaited<ReturnType<typeof setup>>;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  s = await setup(undefined, { rename: async (_path, destination, validate) => { started(); await gate; validate(); await s.buffer.rename(destination); } });
  s.setTitle('Invalid/name'); await assert.rejects(s.handle.flush(), /path separators/);
  s.setTitle('Recovered popup note'); const retry = s.handle.element.querySelector<HTMLButtonElement>('.bases-new-item-retry')!;
  retry.focus(); retry.click(); await entered;
  const sibling = s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!; sibling.focus(); release(); await tick();
  assert.equal(s.handle.path, 'Recovered popup note.md'); assert.equal(retry.hidden, true); assert.equal(s.dom.window.document.activeElement, sibling); await s.cleanup();
});

test('failed buffer flush retains body draft and does not dispose shared buffer', async () => {
  const s = await setup(); await s.handle.expandBody(); s.editorOptions[0].onChange(s.buffer.text + '\nUnsaved');
  const original = s.adapter.write.bind(s.adapter); let reject = true; s.adapter.write = async (path, text) => { if (reject) throw new Error('Disk unavailable'); await original(path, text); };
  await assert.rejects(s.handle.close(), /Disk unavailable/); assert.ok(s.handle.element.isConnected); assert.equal(s.destroyedEditor, 0); assert.match(s.buffer.text, /Unsaved/);
  reject = false; await s.handle.close(); assert.match(await s.vault.read('Untitled.md'), /Unsaved/); assert.equal(s.destroyedEditor, 1); s.buffer.update(s.buffer.text + '\nStill shared'); await s.buffer.flush(); await s.cleanup();
});

test('a clean externally retired note can flush and close its popup without recreating the file', async () => {
  let childCloses=0;const s=await setup(undefined,{closeEditor:async()=>{childCloses++;}});
  await s.vault.trash('Untitled.md');assert.equal(s.handle.hasPendingChanges(),false);
  await s.handle.flush();await s.handle.close();assert.equal(childCloses,1);assert.equal(s.closed,1);assert.equal(s.handle.element.isConnected,false);
  assert.equal(s.vault.entries.has('Untitled.md'),false);await s.cleanup();
});

test('external retirement never discards a title, body or nested editor draft', async () => {
  for(const draft of ['title','body','nested'] as const){
    let nested=false;const s=await setup(undefined,{hasPendingEditorChanges:()=>nested});
    if(draft==='title')s.setTitle('Retained title');else if(draft==='body')s.buffer.update(s.buffer.text+'\nRetained body');else nested=true;
    await s.vault.trash('Untitled.md');await assert.rejects(s.handle.close(),/identity|available|changed/);assert.ok(s.handle.element.isConnected);assert.equal(s.closed,0);
    // Restore the same fixture path solely for teardown; the failure assertions
    // above establish that no implicit recreation/discard happened.
    nested=false;await s.vault.create('Untitled.md',s.buffer.savedText);s.setTitle('Untitled');
    s.buffer.update(s.buffer.savedText);
    await s.cleanup();
  }
});

test('nested Base drafts participate in popup save, unload accounting and close retry', async () => {
  let pending=true,closed=0;
  const s=await setup(undefined,{hasPendingEditorChanges:()=>pending,flushEditor:async()=>{if(pending)throw new Error('Finish nested Base property edit');},closeEditor:async()=>{closed++;}});
  assert.equal(s.handle.hasPendingChanges(),true);
  await assert.rejects(s.handle.close(),/nested Base/);assert.ok(s.handle.element.isConnected);assert.equal(closed,0);
  pending=false;await s.handle.close();assert.equal(closed,1);assert.equal(s.closed,1);await s.cleanup();
});

test('embedded-session close failures retain the popup and shared buffer for retry', async () => {
  let reject=true;
  const s=await setup(undefined,{closeEditor:async()=>{if(reject)throw new Error('Nested Base close failed');}});
  await assert.rejects(s.handle.close(),/Nested Base close failed/);assert.ok(s.handle.element.isConnected);
  s.buffer.update(s.buffer.text+'\nRetained after child failure');reject=false;await s.handle.close();
  assert.match(await s.vault.read('Untitled.md'),/Retained after child failure/);await s.cleanup();
});

test('Escape cancels a descendant rich property draft before popup dismissal can blur-save it', async () => {
  const s=await setup('---\ncount: 2\n---\nBody',{properties:{getDefinitions:()=>({count:{type:'number'}})}});await tick();
  s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const value=s.handle.element.querySelector<HTMLElement>('[data-property-key="count"] .metadata-property-value')!;value.click();
  const input=value.querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value='3';input.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();
  assert.ok(s.handle.element.isConnected);assert.match(s.buffer.text,/count: 2/);assert.equal(value.hasAttribute('data-base-editing'),false);await s.cleanup();
});

test('a rich property portal opened during delayed child close retains its exact unaccepted draft', async () => {
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const s=await setup('---\ntopics: []\n---\nBody',{properties:{getDefinitions:()=>({topics:{type:'multiselect',options:[{value:'Rust'}]}})},closeEditor:async()=>{started();await gate;}});
  await tick();s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const closing=s.handle.close();await entered;
  const value=s.handle.element.querySelector<HTMLElement>('[data-property-key="topics"] .metadata-property-value')!;value.click();
  const input=s.dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input')!;assert.ok(input);input.value='Rust';input.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
  release();await assert.rejects(closing,/changed while closing/);assert.ok(s.handle.element.isConnected);assert.equal(input.value,'Rust');
  input.dispatchEvent(new s.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await s.handle.close();await s.cleanup();
});

test('outside dismissal preserves sibling focus and flushes note; Escape respects title composition', async () => {
  const s = await setup(); s.title.dispatchEvent(new s.dom.window.CompositionEvent('compositionstart', { bubbles: true })); s.title.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); assert.ok(s.handle.element.isConnected);
  s.title.dispatchEvent(new s.dom.window.CompositionEvent('compositionend', { bubbles: true })); const sibling = s.dom.window.document.querySelector<HTMLButtonElement>('#sibling')!; sibling.focus(); sibling.dispatchEvent(new s.dom.window.MouseEvent('pointerdown', { bubbles: true })); await tick(); assert.equal(s.handle.element.isConnected, false); assert.equal(s.dom.window.document.activeElement, sibling); await s.cleanup();
});

test('closing during lazy factory load disposes late editor without taking sibling focus', async () => {
  let release!: (factory: EditorHandle) => void; let destroyed = 0; const gate = new Promise<EditorHandle>(resolve => { release = resolve; });
  const s = await setup(undefined, { editorFactory: () => gate }); const loading = s.handle.expandBody(); await s.handle.close(); release({ getValue: () => '', setValue() {}, focus() { throw new Error('late focus'); }, destroy() { destroyed++; }, insert() {} }); await loading;
  assert.equal(destroyed, 1); assert.equal(s.closed, 1); await s.cleanup();
});


test('empty notes hide empty Properties and preserve full source without an eager editor', async () => {
  const s = await setup(''); assert.equal(s.handle.element.querySelector<HTMLElement>('.bases-new-item-properties')!.hidden, true); assert.equal(s.editorOptions.length, 0); await s.handle.close(); assert.equal(await s.vault.read('Untitled.md'), ''); await s.cleanup();
});

test('uncertain rename acknowledgement reconciles only the same buffer destination before retry', async () => {
  let s: Awaited<ReturnType<typeof setup>>, calls = 0; s = await setup(undefined, {rename: async (_path, destination, validate) => { calls++; validate(); await s.buffer.rename(destination); throw new Error('Rename acknowledgement interrupted'); }});
  s.setTitle('Renamed'); await assert.rejects(s.handle.flush(), /acknowledgement/); assert.equal(s.handle.path, 'Renamed.md'); assert.equal(s.title.textContent, 'Renamed'); await s.handle.close(); assert.equal(calls, 1); assert.equal(s.vault.entries.has('Renamed.md'), true); await s.cleanup();
});

test('invalid property drafts prevent dismissal and remain editable until corrected', async () => {
  const s = await setup('---\ncount: 2\n---\nBody'); s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.click();
  const count = s.handle.element.querySelector<HTMLInputElement>('[aria-label="count value"]')!; count.value = 'invalid'; count.dispatchEvent(new s.dom.window.Event('input',{bubbles:true})); count.dispatchEvent(new s.dom.window.Event('change',{bubbles:true})); await tick();
  assert.equal(s.handle.hasPendingChanges(), true); await assert.rejects(s.handle.close(), /number|Invalid value/); assert.ok(s.handle.element.isConnected); assert.equal(count.value, 'invalid');
  count.value = '3'; count.dispatchEvent(new s.dom.window.Event('input',{bubbles:true})); count.dispatchEvent(new s.dom.window.Event('change',{bubbles:true})); await tick(); await s.handle.close(); assert.match(await s.vault.read('Untitled.md'), /count: 3/); await s.cleanup();
});

test('initial expanded-body factory failure retains a managed surface and shared note', async () => {
  const s = await setup(undefined, {bodyExpanded:true,editorFactory:()=>{throw new Error('Editor unavailable');}}); assert.ok(s.handle.element.isConnected); assert.match(s.handle.element.textContent!, /Editor unavailable/); await s.handle.close(); await s.cleanup();
});


test('a late editor starts from the latest shared source and cleanup survives a throwing child', async () => {
  let release!: (editor: EditorHandle) => void, displayed = ''; const gate = new Promise<EditorHandle>(resolve => { release = resolve; });
  const s = await setup(undefined, {editorFactory:()=>gate}); const loading = s.handle.expandBody(); s.buffer.update(s.buffer.text+'\nNewer while loading');
  release({getValue:()=>displayed,setValue:next=>{displayed=next;},focus(){},destroy(){throw new Error('child disposal');},insert(){}}); await loading; assert.ok(displayed.endsWith('Newer while loading')); await s.handle.close(); assert.equal(s.handle.element.isConnected,false); assert.equal(s.closed,1); assert.ok(s.errors.some(error=>String(error).includes('child disposal'))); await s.cleanup();
});

test('the note Properties context menu remains owned by the New surface', async () => {
  const s = await setup(); s.handle.element.querySelector<HTMLElement>('.metadata-properties-heading')!.dispatchEvent(new s.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));
  const menu = s.dom.window.document.querySelector<HTMLElement>('.context-menu')!; assert.ok(menu); menu.dispatchEvent(new s.dom.window.MouseEvent('pointerdown',{bubbles:true})); await tick(); assert.ok(s.handle.element.isConnected); await s.cleanup();
});


test('a newer title typed during a slow rename cannot be discarded by closing', async () => {
  let release!: () => void, started!: () => void, calls = 0; const gate = new Promise<void>(resolve=>{release=resolve;}), began = new Promise<void>(resolve=>{started=resolve;});
  let s: Awaited<ReturnType<typeof setup>>; s = await setup(undefined, {rename:async(_path,destination,validate)=>{if(++calls===1){started();await gate;}validate();await s.buffer.rename(destination);}});
  s.setTitle('First'); const close = s.handle.close(); await began; s.setTitle('Second'); release(); await assert.rejects(close,/title changed/i); assert.ok(s.handle.element.isConnected); assert.equal(s.title.textContent,'Second'); assert.equal(s.handle.path,'First.md');
  await s.handle.close(); assert.equal(s.handle.path,'Second.md'); assert.equal(calls,2); await s.cleanup();
});
