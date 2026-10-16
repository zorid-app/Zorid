import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { WorkspaceViewFactories } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { EditorHandle, EditorOptions } from '../src/ui/editor.ts';

// These integration tests exercise workspace wiring and storage using an injected
// DOM editor. They do not test CodeMirror, layout/pixels, or Obsidian parity.
const editorOptions = new WeakMap<HTMLElement, EditorOptions>();
function editor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', 'Test note editor');
  input.dataset.editorMode = options.mode;
  input.value = options.value;
  input.oninput = () => options.onChange(input.value);
  parent.append(input);
  editorOptions.set(input, options);
  return {
    getValue: () => input.value,
    getViewState:()=>({selection:{ranges:[{anchor:input.selectionDirection==='backward'?input.selectionEnd:input.selectionStart,head:input.selectionDirection==='backward'?input.selectionStart:input.selectionEnd}],mainIndex:0},scrollTop:input.scrollTop,scrollLeft:input.scrollLeft}),
    restoreViewState:state=>{const range=state.selection.ranges[0];input.setSelectionRange(Math.min(range.anchor,range.head),Math.max(range.anchor,range.head),range.anchor>range.head?'backward':'forward');input.scrollTop=state.scrollTop;input.scrollLeft=state.scrollLeft;},
    setValue: value => { input.value = value; },
    focus: () => input.focus(),
    destroy: () => input.remove(),
    insert: text => { input.value += text; options.onChange(input.value); },
    configureLists: value => { options.listOptions = value; },
  };
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() >= end) assert.fail(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(t: TestContext, adapter = new MemoryAdapter(), id = 'test:vault', stored: Record<string, unknown> = {}, views: WorkspaceViewFactories = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://zorid.test/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, JSON.stringify(value));
  const root = document.querySelector<HTMLElement>('#app')!;
  const workspace = new Workspace(root, editor, views);
  let destroyed = false;
  const destroy = async () => { if (!destroyed) { await workspace.destroy(); destroyed = true; } };
  t.after(async () => {
    try { await destroy(); }
    finally {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  await workspace.start({ adapter, label: 'Test vault', id });
  const click = (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
    assert.ok(button, `Button exists: ${label}`);
    button.click();
  };
  const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const key = (target: EventTarget, value: string, extra: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  return { dom, root, workspace, adapter, click, type, key, destroy };
}

const currentEditor = () => document.querySelector<HTMLTextAreaElement>('.pane.is-active textarea')!;

test('workspace creates a note from the toolbar, saves editor text and restores the open note', async t => {
  const { workspace, adapter, click, type, root } = await setup(t);
  click('New note');
  await until(() => Boolean(currentEditor()), 'new note editor');
  assert.ok(workspace.vault.entries.has('Untitled.md'));
  type(currentEditor(), '# Meeting\n\nKeep these notes.');
  await workspace.flush();
  assert.equal(await adapter.read('Untitled.md'), '# Meeting\n\nKeep these notes.');
  assert.equal(root.querySelector('.save-state')!.textContent, '');
  const platform = workspace.platform;
  await workspace.openVault(platform);
  assert.equal(currentEditor().value, '# Meeting\n\nKeep these notes.');
  assert.equal(root.querySelector<HTMLInputElement>('.note-title')!.value, 'Untitled');
  assert.equal(localStorage.getItem('zorid:draft:test:vault:Untitled.md'), null);
});

test('reading-view task toggles persist and survive switching back to the editor', async t => {
  const { workspace, adapter, key, dom } = await setup(t, new MemoryAdapter({ 'Tasks.md': '# Tasks\n- [ ] Ship notes\n- [x] Read docs' }));
  await workspace.openNote('Tasks.md');
  const shortcut = key(document, 'e', { metaKey: true });
  assert.equal(shortcut.defaultPrevented, true);
  await until(() => Boolean(document.querySelector('.markdown-preview input')), 'reading view');
  const checkbox = document.querySelector<HTMLInputElement>('.markdown-preview input')!;
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await until(async () => (await adapter.read('Tasks.md')).includes('- [x] Ship notes'), 'task saved');
  await until(() => Boolean(document.querySelector<HTMLInputElement>('.markdown-preview input')?.checked), 'updated preview');
  key(document, 'e', { metaKey: true });
  await until(() => Boolean(currentEditor()), 'editing restored');
  assert.match(currentEditor().value, /- \[x\] Ship notes/);
});

test('vault search finds note content and opens its result', async t => {
  const { workspace, click, type } = await setup(t, new MemoryAdapter({ 'Alpha.md': 'unrelated', 'Folder/Beta.md': 'The needle is here.' }));
  click('Search');
  const input = document.querySelector<HTMLInputElement>('.sidebar-content input')!;
  assert.ok(input);
  type(input, 'needle');
  await until(() => document.querySelectorAll('.search-result').length === 1, 'search result');
  assert.equal(document.querySelector('.search-result-title')!.textContent, 'Beta');
  assert.equal(document.querySelector('.search-snippet')!.textContent, 'The needle is here.');
  (document.querySelector('.search-result-title') as HTMLButtonElement).click();
  await until(() => currentEditor()?.value === 'The needle is here.', 'search navigation');
  assert.equal(workspace.activePane.tabs.find(tab => tab.id === workspace.activePane.active)?.path, 'Folder/Beta.md');
});

test('split panes share one note buffer and preserve edits through concurrent rendering', async t => {
  const { workspace, adapter, click, type } = await setup(t, new MemoryAdapter({ 'Shared.md': 'First version' }));
  await workspace.openNote('Shared.md');
  click('More options');
  click('Split right');
  await until(() => document.querySelectorAll('.pane textarea').length === 2, 'split editors');
  assert.equal(workspace.buffers.size, 1);
  type(currentEditor(), 'Changed in the second pane');
  assert.deepEqual([...document.querySelectorAll<HTMLTextAreaElement>('.pane textarea')].map(node => node.value), ['Changed in the second pane', 'Changed in the second pane']);
  await Promise.all(workspace.panes.map(pane => workspace.renderPane(pane)));
  assert.deepEqual([...document.querySelectorAll<HTMLTextAreaElement>('.pane textarea')].map(node => node.value), ['Changed in the second pane', 'Changed in the second pane']);
  await workspace.flush();
  assert.equal(await adapter.read('Shared.md'), 'Changed in the second pane');
});

test('renaming an open note migrates both split tabs and subsequent saves to the new path', async t => {
  const { workspace, adapter, click, type, dom } = await setup(t, new MemoryAdapter({ 'Before.md': 'Original', 'Links.md': '[[Before]]' }));
  await workspace.openNote('Before.md');
  click('More options'); click('Split right');
  await until(() => document.querySelectorAll('.pane textarea').length === 2, 'split editors');
  const title = document.querySelector<HTMLInputElement>('.pane.is-active .note-title')!;
  title.value = 'After';
  title.dispatchEvent(new dom.window.FocusEvent('blur'));
  await until(() => workspace.buffers.has('After.md') && [...document.querySelectorAll<HTMLInputElement>('.note-title')].every(node => node.value === 'After') && document.querySelectorAll('.pane textarea').length === 2, 'renamed panes');
  assert.equal(workspace.buffers.has('Before.md'), false);
  assert.equal(await adapter.read('Links.md'), '[[After]]');
  type(currentEditor(), 'Saved after rename');
  await workspace.flush();
  assert.equal(await adapter.read('After.md'), 'Saved after rename');
  await assert.rejects(adapter.read('Before.md'), /does not exist/);
  assert.equal(workspace.buffers.get('After.md')!.path, 'After.md');
});

test('quick switcher supports keyboard selection and Escape restores the previous focus', async t => {
  const { workspace, key } = await setup(t, new MemoryAdapter({ 'Alpha.md': 'Alpha content', 'Beta.md': 'Beta content' }));
  await workspace.openNote('Alpha.md');
  currentEditor().focus();
  workspace.quickSwitcher();
  let input = document.querySelector<HTMLInputElement>('.command-input')!;
  assert.equal(document.activeElement, input);
  key(input, 'ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), 'suggestion-1');
  key(input, 'Enter');
  await until(() => currentEditor()?.value === 'Beta content', 'keyboard-selected note');
  currentEditor().focus();
  const previous = document.activeElement;
  workspace.quickSwitcher();
  input = document.querySelector<HTMLInputElement>('.command-input')!;
  key(input, 'Escape');
  assert.equal(document.querySelector('.modal-overlay'), null);
  assert.equal(document.activeElement, previous);
});

test('failed destroy keeps the workspace and recovery draft until storage can save', async t => {
  class FailingAdapter extends MemoryAdapter {
    fail = false;
    async write(path: string, text: string): Promise<void> {
      if (this.fail) throw new Error('Disk unavailable');
      await super.write(path, text);
    }
  }
  const adapter = new FailingAdapter({ 'Note.md': 'Original' });
  const { workspace, root, type, destroy } = await setup(t, adapter);
  await workspace.openNote('Note.md');
  adapter.fail = true;
  type(currentEditor(), 'Keep this draft');
  await assert.rejects(workspace.destroy(), /Disk unavailable/);
  assert.equal(currentEditor().value, 'Keep this draft');
  assert.equal(workspace.buffers.get('Note.md')!.dirty, true);
  assert.equal(JSON.parse(localStorage.getItem('zorid:draft:test:vault:Note.md')!).content, 'Keep this draft');
  assert.equal(await adapter.read('Note.md'), 'Original');
  adapter.fail = false;
  await destroy();
  assert.equal(await adapter.read('Note.md'), 'Keep this draft');
  assert.equal(root.childElementCount, 0);
  assert.equal(localStorage.getItem('zorid:draft:test:vault:Note.md'), null);
});

test('opening the same note concurrently in split panes shares its initial load', async t => {
  class CountingAdapter extends MemoryAdapter {
    reads = 0;
    async read(path: string): Promise<string> {
      if (path === 'Shared.md') this.reads++;
      await new Promise(resolve => setImmediate(resolve));
      return super.read(path);
    }
  }
  const adapter = new CountingAdapter({ 'Start.md': 'Starting note', 'Shared.md': 'Load this once' });
  const { workspace, click } = await setup(t, adapter);
  await workspace.openNote('Start.md');
  click('More options'); click('Split right');
  await until(() => document.querySelectorAll('.pane textarea').length === 2, 'split ready');
  adapter.reads = 0;
  await Promise.all(workspace.panes.map(pane => workspace.openNote('Shared.md', false, pane)));
  assert.equal(adapter.reads, 1);
  assert.deepEqual([...document.querySelectorAll<HTMLTextAreaElement>('.pane textarea')].map(node => node.value), ['Load this once', 'Load this once']);
});

test('closing a tab once removes only that tab and leaves the neighboring note usable', async t => {
  const { workspace } = await setup(t, new MemoryAdapter({ 'A.md': 'A', 'B.md': 'B', 'C.md': 'C' }));
  await workspace.openNote('A.md');
  await workspace.openNote('B.md', true);
  await workspace.openNote('C.md', true);
  assert.equal(workspace.activePane.tabs.length, 3);
  (document.querySelector('.tab.is-active .tab-close') as HTMLButtonElement).click();
  await until(() => workspace.activePane.tabs.length < 3, 'tab close');
  // Let both DOM listener and any async render continuations finish.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(workspace.activePane.tabs.map(tab => tab.path), ['A.md', 'B.md']);
  assert.equal(currentEditor().value, 'B');
});

test('watcher batches preserve exact changed paths and update open text without a full scan', async t => {
  class WatchedAdapter extends MemoryAdapter {
    listener?: (paths?: readonly string[]) => void;
    lists=0; reads:string[]=[];
    override async list(){this.lists++;return super.list();}
    override async read(path:string){this.reads.push(path);return super.read(path);}
    subscribe(listener:(paths?:readonly string[])=>void){this.listener=listener;return()=>{this.listener=undefined;};}
  }
  const adapter=new WatchedAdapter({'One.md':'one','Two.md':'two','Unrelated.md':'keep'});
  const {workspace}=await setup(t,adapter);
  await workspace.openNote('One.md');adapter.lists=0;adapter.reads=[];
  await adapter.write('One.md','ONE');await adapter.write('Two.md','TWO');
  adapter.listener!(['One.md']);adapter.listener!(['Two.md']);
  await until(()=>currentEditor().value==='ONE','external changes applied');
  assert.equal(adapter.lists,0);assert.equal(adapter.reads.includes('Unrelated.md'),false);
  assert.equal(await workspace.vault.cachedRead('Two.md'),'TWO');
});

test('reading embeds toggle tasks in the referenced note using its original line offset', async t => {
  const {workspace,adapter,key,dom}=await setup(t,new MemoryAdapter({'Home.md':'![[Tasks#Today]]','Tasks.md':'# Later\n- [ ] Leave alone\n# Today\n- [ ] Embedded task\n# Tomorrow\n- [ ] Also untouched'}));
  await workspace.openNote('Home.md');key(document,'e',{metaKey:true});
  await until(()=>!!document.querySelector('.markdown-embed input'),'embedded task loaded');
  const task=document.querySelector<HTMLInputElement>('.markdown-embed input')!;
  task.checked=true;task.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(async()=>(await adapter.read('Tasks.md')).includes('[x] Embedded task'),'embedded task saved');
  assert.equal(await adapter.read('Home.md'),'![[Tasks#Today]]');
  assert.equal(await adapter.read('Tasks.md'),'# Later\n- [ ] Leave alone\n# Today\n- [x] Embedded task\n# Tomorrow\n- [ ] Also untouched');
});

test('properties edits save YAML and keep the live editor and reading body synchronized', async t => {
  const {workspace,adapter,dom,key}=await setup(t,new MemoryAdapter({'Note.md':'---\ntitle: Before\ncount: 2\n---\n# Body\nKeep this paragraph.'}));
  await workspace.openNote('Note.md');
  const value=[...document.querySelectorAll<HTMLInputElement>('.metadata-input')].find(input=>input.value==='Before')!;
  assert.ok(value);value.value='After';value.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(async()=>(await adapter.read('Note.md')).includes('title: After'),'property saved');
  assert.match(currentEditor().value,/title: After/);
  assert.ok(currentEditor().value.endsWith('# Body\nKeep this paragraph.'));
  key(document,'e',{metaKey:true});
  await until(()=>!!document.querySelector('.markdown-preview'),'reading view');
  assert.equal(document.querySelector('.markdown-preview .properties'),null);
  assert.match(document.querySelector('.markdown-preview')!.textContent!,/Keep this paragraph/);
  const number=[...document.querySelectorAll<HTMLInputElement>('.metadata-input')].find(input=>input.value==='2')!;
  assert.ok(number);number.value='3';number.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(async()=>(await adapter.read('Note.md')).includes('count: 3'),'reading property saved');
  assert.match(document.querySelector('.markdown-preview')!.textContent!,/Keep this paragraph/);
});

test('embeds follow external changes even if their source has a previously loaded clean buffer', async t => {
  const {workspace,adapter,key}=await setup(t,new MemoryAdapter({'Home.md':'![[Source]]','Source.md':'Before external edit'}));
  await workspace.openNote('Source.md');await workspace.openNote('Home.md');
  key(document,'e',{metaKey:true});
  await until(()=>document.querySelector('.markdown-embed-content')?.textContent==='Before external edit','initial embed');
  await adapter.write('Source.md','After external edit');await workspace.vault.reload(['Source.md']);
  await until(()=>document.querySelector('.markdown-embed-content')?.textContent==='After external edit','fresh external embed');
});

test('image tabs stay out of text buffers and refresh after binary changes', async t => {
  const adapter=new MemoryAdapter({'Note.md':'# Note'});
  await adapter.writeBinary('Picture.png',Uint8Array.of(0,255,128));
  const {workspace,root}=await setup(t,adapter);
  await workspace.openNote('Picture.png');
  await until(()=>!!root.querySelector('.image-container img')?.getAttribute('src'),'standalone image');
  assert.equal(workspace.buffers.has('Picture.png'),false);
  assert.equal(root.querySelector('.editor-host'),null);
  assert.equal(root.querySelector('[aria-label="Switch to reading view (⌘E)"]'),null);
  assert.match(root.querySelector('.status-bar')!.textContent!,/3 bytes/);
  const previous=root.querySelector<HTMLImageElement>('.image-container img')!.src;
  await workspace.vault.modifyBinary('Picture.png',Uint8Array.of(4,5,6,7));
  await until(()=>!!root.querySelector<HTMLImageElement>('.image-container img')?.src&&root.querySelector<HTMLImageElement>('.image-container img')!.src!==previous,'changed image resource');
  assert.match(root.querySelector('.status-bar')!.textContent!,/4 bytes/);
  await workspace.openNote('Note.md');
  assert.equal(root.querySelector('.image-container'),null);assert.equal(currentEditor().value,'# Note');
});

test('legacy source-mode settings and tabs migrate to live without discarding other saved fields', async t => {
  const id = 'migration:vault';
  const settings = { theme: 'dark', fontSize: 19, readableWidth: false, showInlineTitle: false, defaultMode: 'source', pluginPreferences: { keep: true } };
  const session = {
    panes: [{
      tabs: [
        { id: 'old-live', path: 'Folder/One.md', mode: 'source', kind: 'note', extraTabData: { keep: 1 } },
        { id: 'old-reading', path: 'Two.md', mode: 'reading', kind: 'note' },
      ], active: 0, width: 387, pluginPaneData: 'retained',
    }], collapsed: ['Folder'], bookmarks: ['Two.md'], pluginSessionData: { value: 'retained' },
  };
  const { workspace, adapter, root } = await setup(t, new MemoryAdapter({ 'Folder/One.md': '---\ntitle: Keep\n---\n# Note', 'Two.md': '# Second' }), id, {
    'zorid:settings': settings, [`zorid:workspace:${id}`]: session,
  });
  assert.equal(workspace.settings.defaultMode, 'live');
  assert.deepEqual(JSON.parse(localStorage.getItem('zorid:settings')!), { ...settings, defaultMode: 'live',
    useTab:true, tabSize:4, smartIndentList:true, autoConvertHtml:true, attachmentFolderPath:'/', useMarkdownLinks:false, newLinkFormat:'shortest' });
  assert.deepEqual(workspace.activePane.tabs.map(tab => tab.mode), ['live', 'reading']);
  assert.equal(currentEditor().dataset.editorMode, 'live');
  assert.ok(root.querySelector('.properties-host'));
  assert.equal(root.querySelector('.status-mode')!.textContent, 'Live Edit');
  const saved = JSON.parse(localStorage.getItem(`zorid:workspace:${id}`)!);
  assert.deepEqual(saved.panes[0].tabs.map((tab: { mode: string }) => tab.mode), ['live', 'reading']);
  assert.deepEqual(saved.panes[0].tabs[0].extraTabData, { keep: 1 });
  assert.equal(saved.panes[0].width, 387); assert.equal(saved.panes[0].pluginPaneData, 'retained');
  assert.deepEqual(saved.collapsed, ['Folder']); assert.deepEqual(saved.bookmarks, ['Two.md']);
  assert.deepEqual(saved.pluginSessionData, { value: 'retained' });
  assert.equal(await adapter.read('Folder/One.md'), '---\ntitle: Keep\n---\n# Note');
});

test('workspace exposes only Reading and Live Edit modes through menus, commands and settings', async t => {
  const { workspace, click, key, root } = await setup(t, new MemoryAdapter({ 'One.md': '# First\n\n**Last**' }));
  await workspace.openNote('One.md');
  click('More options');
  let labels = [...document.querySelectorAll('.context-menu-item')].map(item => item.textContent);
  assert.ok(labels.includes('Reading view')); assert.ok(labels.includes('Live Edit'));
  assert.ok(labels.every(label => !/Source mode|Live Preview/.test(label || '')));
  click('Reading view'); await until(() => Boolean(root.querySelector('.markdown-preview')), 'reading mode selected');
  assert.equal(root.querySelector('.status-mode')!.textContent, 'Reading view');
  assert.equal(root.querySelector('.markdown-preview h1')!.textContent, 'First');
  assert.equal(root.querySelector('.markdown-preview strong')!.textContent, 'Last');
  click('More options'); click('Live Edit'); await until(() => Boolean(currentEditor()), 'live mode selected');
  assert.equal(currentEditor().dataset.editorMode, 'live');
  assert.equal(currentEditor().value, '# First\n\n**Last**');
  key(document, 'e', { metaKey: true }); await until(() => Boolean(root.querySelector('.markdown-preview')), 'keyboard reading');
  key(document, 'e', { metaKey: true }); await until(() => Boolean(currentEditor()), 'keyboard live');
  assert.equal(currentEditor().dataset.editorMode, 'live');
  workspace.commandPalette();
  assert.doesNotMatch(document.querySelector('.suggestion-list')!.textContent!, /Source mode|Live Preview/);
  key(document.querySelector('.command-input')!, 'Escape');
  workspace.showSettings();
  assert.equal(document.querySelector('[aria-label="Default editing mode"]'), null);
  assert.doesNotMatch(document.querySelector('.settings-content')!.textContent!, /Source mode|Live Preview/);
  click('Close settings');
  await workspace.newNote(); assert.equal(currentEditor().dataset.editorMode, 'live');
});

test('attachment tabs offer no Markdown mode transitions after the two-mode cleanup', async t => {
  const { workspace, click, key, root } = await setup(t, new MemoryAdapter({ 'Picture.png': Uint8Array.of(0, 255, 1) }));
  await workspace.openNote('Picture.png');
  click('More options');
  const labels = [...document.querySelectorAll('.context-menu-item')].map(item => item.textContent);
  assert.ok(labels.every(label => !/Reading view|Live Edit|Source mode/.test(label || '')));
  key(document, 'e', { metaKey: true }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(root.querySelector('.editor-host'), null);
  assert.equal(root.querySelector('.markdown-preview'), null);
  assert.equal(workspace.buffers.has('Picture.png'), false);
});

test('nested quoted custom tasks toggle only their original status character', async t => {
  const source='---\ntitle: Tasks\n---\n> - parent\n>   - [?] review [x] text\n>   - [ ] next';
  const {workspace,adapter,key,dom}=await setup(t,new MemoryAdapter({'Tasks.md':source}));
  await workspace.openNote('Tasks.md');key(document,'e',{metaKey:true});
  await until(()=>document.querySelectorAll('.markdown-preview input[type=checkbox]').length===2,'nested tasks');
  const checkbox=document.querySelector<HTMLInputElement>('.markdown-preview input[type=checkbox]')!;
  assert.equal(checkbox.checked,true);assert.equal(checkbox.closest('li')!.classList.contains('is-checked'),false);
  checkbox.checked=false;checkbox.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(async()=>(await adapter.read('Tasks.md'))===source.replace('[?]','[ ]'),'custom status saved');
  key(document,'e',{metaKey:true});await until(()=>!!currentEditor(),'live restored');
  assert.equal(currentEditor().value,source.replace('[?]','[ ]'));
});

test('editor settings reconfigure current editors and attachment preferences reach imported links', async t => {
  const {workspace,adapter,click,dom}=await setup(t,new MemoryAdapter({'Folder/Note.md':'- item'}));
  await workspace.openNote('Folder/Note.md');
  const original=currentEditor(), options=editorOptions.get(original)!;
  workspace.showSettings();
  const tabs=document.querySelector<HTMLInputElement>('[aria-label="Indent using tabs"]')!;tabs.click();
  const size=document.querySelector<HTMLInputElement>('[aria-label="Tab size"]')!;size.value='8';size.dispatchEvent(new dom.window.Event('change'));
  const smart=document.querySelector<HTMLInputElement>('[aria-label="Smart indent lists"]')!;smart.click();
  assert.equal(currentEditor(),original);
  assert.deepEqual(options.listOptions,{useTab:false,tabSize:8,smartIndentList:false});
  click('Files and links');
  document.querySelector<HTMLInputElement>('[aria-label="Use Wikilinks"]')!.click();
  const format=document.querySelector<HTMLSelectElement>('[aria-label="New link format"]')!;format.value='relative';format.dispatchEvent(new dom.window.Event('change'));
  const location=document.querySelector<HTMLSelectElement>('[aria-label="Default location for new attachments"]')!;location.value='subfolder';location.dispatchEvent(new dom.window.Event('change'));
  const folder=document.querySelector<HTMLInputElement>('[aria-label="Attachment folder path"]')!;folder.value='Media';folder.dispatchEvent(new dom.window.Event('change'));
  const bytes=new Uint8Array([0,255,17,42]);
  const link=await options.transfers!.importFile({name:'capture.bin',type:'application/octet-stream',read:async()=>bytes});
  assert.equal(link,'![](./Media/capture.bin)');
  assert.deepEqual(await adapter.readBinary('Folder/Media/capture.bin'),bytes);
  const saved=JSON.parse(localStorage.getItem('zorid:settings')!);
  assert.equal(saved.attachmentFolderPath,'./Media');assert.equal(saved.useMarkdownLinks,true);
  assert.equal(saved.tabSize,8);assert.equal(saved.useTab,false);assert.equal(saved.smartIndentList,false);
  assert.equal(await adapter.read('Folder/Note.md'),'- item');
});


test('a pending attachment import cannot allocate into a vault after it is replaced', async t => {
  const first = new MemoryAdapter({ 'Old/Note.md': 'old' });
  const { workspace } = await setup(t, first, 'test:first');
  await workspace.openNote('Old/Note.md');
  workspace.settings.attachmentFolderPath = '.';
  const options = editorOptions.get(currentEditor())!;
  let release!: (bytes: Uint8Array) => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const pending = options.transfers!.importFile({
    name: 'capture.bin', type: 'application/octet-stream',
    read: () => { started(); return new Promise(resolve => { release = resolve; }); },
  });
  await reading;
  const second = new MemoryAdapter({ 'New/Note.md': 'new' });
  await workspace.openVault({ adapter: second, label: 'Second vault', id: 'test:second' });
  await workspace.openNote('New/Note.md');
  release(new Uint8Array([42]));
  await assert.rejects(pending, /destination vault is no longer open/);
  assert.deepEqual((await first.list()).map(entry => entry.path).sort(), ['Old', 'Old/Note.md']);
  assert.deepEqual((await second.list()).map(entry => entry.path).sort(), ['New', 'New/Note.md']);
});

test('native file menus cannot apply actions to a replacement vault', async t => {
  const {workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Same.md':'original'}));
  let finish!: (id:string|null)=>void;
  let items:Array<{id?:string;label?:string}>=[];
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:(request:{items:typeof items})=>{items=request.items;return new Promise<string|null>(resolve=>finish=resolve);},dismissContextMenu:async()=>{}}});
  const file=root.querySelector<HTMLElement>('[role=treeitem][title="Same.md"]')!;
  file.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.ok(finish);const remove=items.find(item=>item.label==='Move to trash')!;assert.ok(remove);
  const other=new MemoryAdapter({'Same.md':'replacement'});
  await workspace.openVault({adapter:other,id:'test:replacement',label:'Replacement'});
  finish(remove.id!);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await adapter.read('Same.md'),'original');assert.equal(await other.read('Same.md'),'replacement');
});


test('fresh right dock is collapsed and its toggled state survives vault restoration', async t => {
  const { workspace, root, click } = await setup(t);
  assert.equal(root.classList.contains('right-hidden'), true);
  click('Toggle right sidebar');
  assert.equal(root.classList.contains('right-hidden'), false);
  await workspace.openVault(workspace.platform);
  assert.equal(root.classList.contains('right-hidden'), false);
});

test('HTML conversion preference updates the existing editor transfer callback', async t => {
  const { workspace, click, dom } = await setup(t, new MemoryAdapter({ 'Note.md': 'text' }));
  await workspace.openNote('Note.md');
  const options = editorOptions.get(currentEditor())!, original = currentEditor();
  assert.equal((options.transfers!.autoConvertHtml as () => boolean)(), true);
  workspace.showSettings();
  const toggle = document.querySelector<HTMLInputElement>('input[aria-label="Auto convert HTML"]')!;
  toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click('Close settings');
  assert.equal(currentEditor(), original);
  assert.equal((options.transfers!.autoConvertHtml as () => boolean)(), false);
  assert.equal(JSON.parse(localStorage.getItem('zorid:settings')!).autoConvertHtml, false);
});


const canvasSource = JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'Original', custom: 42 }], edges: [], unknown: { keep: true } });
function editCanvas(dom: JSDOM, value: string): HTMLTextAreaElement {
  document.querySelector<HTMLElement>('[data-node-id="a"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = document.querySelector<HTMLTextAreaElement>('.zorid-canvas-text-editor')!;
  input.value = value;
  return input;
}

test('Canvas tabs persist active text before note navigation and retain unknown document data', async t => {
  const { workspace, adapter, dom, root } = await setup(t, new MemoryAdapter({ 'Board.canvas': canvasSource, 'Note.md': 'note' }));
  await workspace.openNote('Board.canvas');
  assert.ok(root.querySelector('.zorid-canvas'));
  editCanvas(dom, 'Edited before blur');
  await workspace.openNote('Note.md');
  const saved = JSON.parse(await adapter.read('Board.canvas'));
  assert.equal(saved.nodes[0].text, 'Edited before blur');
  assert.equal(saved.nodes[0].custom, 42); assert.deepEqual(saved.unknown, { keep: true });
  assert.equal(currentEditor().value, 'note');
  await workspace.openNote('Board.canvas');
  assert.equal(root.querySelector('[data-node-id="a"] .zorid-canvas-node-content')?.textContent, 'Edited before blur');
});

test('failed Canvas save blocks navigation and keeps the editable view and recovery draft', async t => {
  class FailingAdapter extends MemoryAdapter { fail = false; override async write(path: string, value: string) { if (this.fail) throw new Error('disk unavailable'); return super.write(path, value); } }
  const adapter = new FailingAdapter({ 'Board.canvas': canvasSource, 'Note.md': 'note' });
  const { workspace, dom, root } = await setup(t, adapter);
  await workspace.openNote('Board.canvas');
  const surface = root.querySelector('.zorid-canvas'); editCanvas(dom, 'Keep this edit');
  adapter.fail = true;
  await assert.rejects(workspace.openNote('Note.md'), /disk unavailable/);
  assert.equal(root.querySelector('.zorid-canvas'), surface);
  assert.equal(workspace.activePane.tabs.find(tab => tab.id === workspace.activePane.active)?.path, 'Board.canvas');
  assert.match(localStorage.getItem('zorid:draft:test:vault:Board.canvas')!, /Keep this edit/);
  adapter.fail = false; await workspace.openNote('Note.md');
  assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text, 'Keep this edit');
});

test('Canvas external changes refresh a clean view and conflict with uncommitted card text', async t => {
  const { workspace, adapter, dom, root } = await setup(t, new MemoryAdapter({ 'Board.canvas': canvasSource }));
  await workspace.openNote('Board.canvas');
  const changed = JSON.parse(canvasSource); changed.nodes[0].text = 'External';
  await adapter.write('Board.canvas', JSON.stringify(changed)); await workspace.vault.reload(['Board.canvas']);
  await until(() => root.querySelector('[data-node-id="a"]')?.textContent === 'External', 'external Canvas refresh');
  editCanvas(dom, 'Local pending');
  changed.nodes[0].text = 'Concurrent'; await adapter.write('Board.canvas', JSON.stringify(changed)); await workspace.vault.reload(['Board.canvas']);
  await until(() => Boolean(workspace.buffers.get('Board.canvas')?.dirty), 'conflicting Canvas buffer');
  assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text, 'Concurrent');
  assert.equal(JSON.parse(workspace.buffers.get('Board.canvas')!.text).nodes[0].text, 'Local pending');
  await assert.rejects(workspace.flush(), /changed outside/);
  // Restore the prior disk revision only to resolve this deliberate test conflict.
  await adapter.write('Board.canvas', workspace.buffers.get('Board.canvas')!.savedText);
  await workspace.flush();
});

test('PDF tabs receive link subpaths, route Find and release their view without text buffers', async t => {
  const opened: { path: string; subpath?: string }[] = []; let destroyed = 0, searches = 0;
  const { workspace, key, click } = await setup(t, new MemoryAdapter({ 'Paper.pdf': new Uint8Array([37, 80, 68, 70]), 'Note.md': 'note' }), 'test:pdf', {}, {
    pdf(parent, path, _resources, options) {
      opened.push({ path, subpath: options?.subpath }); parent.append(document.createElement('canvas'));
      return { ready: Promise.resolve(), destroy() { destroyed++; }, goToPage() {}, setScale() {}, rotate() {}, showSearch() { searches++; }, applySubpath() {}, getSelectionSubpath() { return null; } };
    },
  });
  await workspace.openNote('Paper.pdf', false, workspace.activePane, true, '#page=2');
  assert.deepEqual(opened, [{ path: 'Paper.pdf', subpath: '#page=2' }]);
  assert.equal(workspace.buffers.has('Paper.pdf'), false);
  const event = key(document, 'f', { metaKey: true }); assert.equal(event.defaultPrevented, true); await until(() => searches === 1, 'PDF find command');
  await workspace.openNote('Note.md'); assert.equal(destroyed, 1);
});


test('Canvas text typed during an external reload remains visible after the read completes', async t => {
  const { workspace, adapter, dom, root, key } = await setup(t, new MemoryAdapter({ 'Board.canvas': canvasSource }));
  await workspace.openNote('Board.canvas');
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = workspace.vault.read.bind(workspace.vault);
  workspace.vault.read = async path => { const result = await original(path); started(); await gate; return result; };
  const changed = JSON.parse(canvasSource); changed.nodes[0].text = 'External';
  await adapter.write('Board.canvas', JSON.stringify(changed)); await workspace.vault.reload(['Board.canvas']);
  await entered;
  const input = editCanvas(dom, 'Local typed during read');
  release();
  await until(() => workspace.buffers.get('Board.canvas')?.text === JSON.stringify(changed), 'external read completed');
  assert.equal(root.querySelector<HTMLTextAreaElement>('.zorid-canvas-text-editor'), input);
  assert.equal(input.value, 'Local typed during read');
  assert.equal(JSON.parse(await adapter.read('Board.canvas')).nodes[0].text, 'External');
  key(input, 'Escape'); // Deliberately cancel this draft so teardown can complete.
});


test('nested workspace splits preserve surviving editor DOM, per-pane state and saved geometry', async t => {
  const {workspace,root,dom,key}=await setup(t,new MemoryAdapter({'Note.md':'0123456789','Other.md':'second note'}));
  await workspace.openNote('Note.md');
  const original=workspace.activePane,first=currentEditor(),firstHandle=original.editor;
  first.focus();first.setSelectionRange(2,5,'backward');
  original.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop=45;
  await (workspace as any).split('right');
  const second=workspace.activePane,secondEditor=currentEditor();
  assert.equal(original.editor,firstHandle);assert.equal(original.element.querySelector('textarea'),first);
  assert.equal(first.selectionStart,2);assert.equal(first.selectionEnd,5);assert.equal(first.selectionDirection,'backward');
  assert.equal(secondEditor.selectionStart,2);assert.equal(secondEditor.selectionEnd,5);
  secondEditor.setSelectionRange(7,8);second.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop=91;
  await workspace.openNote('Other.md',true,second);
  // Opening another tab saves the first tab's caret, selection direction and scroll.
  const noteTab=[...second.element.querySelectorAll<HTMLElement>('[role=tab]')].find(node=>node.textContent==='Note')!;
  noteTab.click();await until(()=>currentEditor()?.value==='0123456789','return to saved tab');
  assert.equal(currentEditor().selectionStart,7);assert.equal(currentEditor().selectionEnd,8);
  assert.equal(second.element.querySelector<HTMLElement>('.note-scroll')!.scrollTop,91);
  const secondHandle=second.editor;
  await (workspace as any).split('bottom');
  const third=workspace.activePane;
  assert.equal(original.editor,firstHandle);assert.equal(second.editor,secondHandle);
  assert.equal(root.querySelectorAll('.split-layout-group').length,2);
  const divider=root.querySelector<HTMLElement>('.split-layout-separator[data-direction=vertical]')!;
  divider.parentElement!.getBoundingClientRect=()=>({width:1000,height:600,x:0,y:0,top:0,left:0,right:1000,bottom:600,toJSON(){return{};}});
  key(divider,'ArrowRight');
  assert.equal(original.editor,firstHandle);assert.equal(second.editor,secondHandle);
  const state=JSON.parse(localStorage.getItem('zorid:workspace:test:vault')!);
  assert.equal(state.layout.direction,'vertical');assert.notEqual(state.layout.sizes[0],state.layout.sizes[1]);
  assert.equal(state.layout.children[1].direction,'horizontal');
  assert.equal(state.activePaneId,third.id);
  assert.equal(state.panes[0].id,original.id);
  await workspace.openVault(workspace.platform);
  assert.deepEqual(JSON.parse(localStorage.getItem('zorid:workspace:test:vault')!).layout,state.layout);
  assert.equal(workspace.activePane.id,third.id);
  assert.equal(workspace.panes[0].id,original.id);
  const restoredFirst=workspace.panes[0].element.querySelector('textarea')!;
  assert.equal(restoredFirst.selectionStart,2);assert.equal(restoredFirst.selectionEnd,5);assert.equal(restoredFirst.selectionDirection,'backward');
  assert.equal(workspace.panes[0].element.querySelector<HTMLElement>('.note-scroll')!.scrollTop,45);
  assert.equal(workspace.panes[1].tabs.length,2);
  const survivor=workspace.panes[0],survivorEditor=survivor.editor;
  await (workspace as any).closeTab(workspace.activePane,workspace.activePane.tabs[0]);
  assert.equal(workspace.panes.length,2);assert.equal(root.querySelectorAll('.split-layout-group').length,1);
  assert.equal(survivor.editor,survivorEditor);
});

test('split a background tab uses its owning pane without changing the current tab', async t => {
  const {workspace}=await setup(t,new MemoryAdapter({'A.md':'aaaa','B.md':'bbbb'}));
  await workspace.openNote('A.md');const pane=workspace.activePane,tab=pane.tabs[0];
  await workspace.openNote('B.md',true);const existing=pane.editor,active=pane.active;
  await (workspace as any).split('bottom',pane,tab);
  assert.equal(pane.active,active);assert.equal(pane.editor,existing);
  assert.equal(workspace.activePane.editor?.getValue(),'aaaa');
});

test('session storage failure cannot bypass the unsaved-document unload guard',async t=>{
  const {workspace,dom,type}=await setup(t,new MemoryAdapter({'Note.md':'old'}));
  await workspace.openNote('Note.md');type(currentEditor(),'unsaved');
  const prototype=Object.getPrototypeOf(localStorage),original=prototype.setItem;
  prototype.setItem=function(key:string,value:string){if(key.startsWith('zorid:workspace:'))throw new Error('Quota exceeded');return original.call(this,key,value);};
  try{
    const event=new dom.window.Event('beforeunload',{cancelable:true});
    assert.doesNotThrow(()=>(workspace as any).unloadListener(event));
    assert.equal(event.defaultPrevented,true);
  }finally{prototype.setItem=original;}
});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}

test('background-tab caret maps through edits from the other split',async t=>{
 const {workspace,type}=await setup(t,new MemoryAdapter({'Note.md':'0123456789','Other.md':'other'}));
 await workspace.openNote('Note.md');const first=workspace.activePane;
 await (workspace as any).split('right');const second=workspace.activePane;
 currentEditor().setSelectionRange(7,7);
 await workspace.openNote('Other.md',true,second);
 type(first.element.querySelector('textarea')!,'ABC0123456789');
 await workspace.flush();
 await workspace.openNote('Note.md',false,second);
 assert.equal(currentEditor().selectionStart,10,'saved caret before original 7 must follow inserted prefix');
});

test('superseded slow vault initialization cannot recreate the current panes or subscribe old adapter',async t=>{
 const {workspace,destroy}=await setup(t,new MemoryAdapter({'Start.md':'start'}));
 const started=deferred(),release=deferred();
 class SlowVault extends MemoryAdapter{
  subscriptions=0;
  async list(){started.resolve();await release.promise;return super.list();}
  subscribe(){this.subscriptions++;return()=>{this.subscriptions--;};}
 }
 const slow=new SlowVault({'Slow.md':'slow'}),fast=new MemoryAdapter({'Current.md':'current'});
 const pending=workspace.openVault({adapter:slow,id:'slow',label:'slow'});
 await started.promise;
 await workspace.openVault({adapter:fast,id:'fast',label:'fast'});
 await workspace.openNote('Current.md');
 const pane=workspace.activePane,editor=pane.editor!;let destroyed=0;const dispose=editor.destroy;editor.destroy=()=>{destroyed++;dispose();};
 release.resolve();await pending;
 const result={oldWatchers:slow.subscriptions,paneStable:workspace.activePane===pane,editorStable:workspace.activePane.editor===editor};await destroy();
 assert.deepEqual({...result,destroyed},{oldWatchers:0,paneStable:true,editorStable:true,destroyed:1},'superseded initialization must preserve pane ownership and eventual editor disposal');
});


test('toolbar menus anchor below their controls while right-click menus retain pointer coordinates',async t=>{
  const {workspace,root,dom}=await setup(t,new MemoryAdapter({'Note.md':'note'}));
  await workspace.openNote('Note.md');
  const positions:{x:number;y:number}[]=[];
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:async(request:{x:number;y:number})=>{positions.push({x:request.x,y:request.y});return null;},dismissContextMenu:async()=>{}}});
  for(const label of ['More options','Tab menu']){
    const button=root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    button.getBoundingClientRect=()=>({x:880,y:45,left:880,right:910,top:45,bottom:75,width:30,height:30,toJSON(){return{};}});
    button.click();assert.deepEqual(positions.at(-1),{x:880,y:75});
  }
  const status=root.querySelector<HTMLButtonElement>('.status-mode')!;
  status.getBoundingClientRect=()=>({x:900,y:650,left:900,right:980,top:650,bottom:680,width:80,height:30,toJSON(){return{};}});
  status.click();assert.deepEqual(positions.at(-1),{x:900,y:680});
  root.querySelector<HTMLElement>('[role=tab]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{clientX:315,clientY:27,bubbles:true,cancelable:true}));
  assert.deepEqual(positions.at(-1),{x:315,y:27});
});


test('inactive caret preserves unchanged middle text across separated sibling edits',async t=>{
  const {workspace,type}=await setup(t,new MemoryAdapter({'Note.md':'prefix MIDDLE suffix','Other.md':'other'}));
  await workspace.openNote('Note.md');const first=workspace.activePane;await (workspace as any).split('right');const second=workspace.activePane;
  currentEditor().setSelectionRange(9,9);await workspace.openNote('Other.md',true,second);
  type(first.element.querySelector('textarea')!,'XXprefix MIDDLE suffixYY');await workspace.flush();
  await workspace.openNote('Note.md',false,second);assert.equal(currentEditor().selectionStart,11);
});


test('file toolbar auto-reveal and collapse controls persist real tree state',async t=>{
  const {workspace,root,click}=await setup(t,new MemoryAdapter({'Folder/Note.md':'note','Other.md':'other'}));
  await workspace.openNote('Folder/Note.md');
  click('Collapse all folders');assert.equal(root.querySelector('[role=treeitem][title="Folder"]')?.getAttribute('aria-expanded'),'false');
  assert.ok(root.querySelector('button[aria-label="Expand all folders"]'));
  click('Auto-reveal active file');
  assert.equal(root.querySelector('[role=treeitem][title="Folder"]')?.getAttribute('aria-expanded'),'true');
  assert.equal(root.querySelector('[data-action="auto-reveal"]')?.getAttribute('aria-pressed'),'true');
  await workspace.openVault(workspace.platform);
  assert.equal(root.querySelector('[data-action="auto-reveal"]')?.getAttribute('aria-pressed'),'true');
  assert.ok(root.querySelector('[role=treeitem][title="Folder/Note.md"]'));
});

test('live link ownership uses source-relative metadata and external URLs never create notes',async t=>{
  const {workspace}=await setup(t,new MemoryAdapter({'Folder/Note.md':'links','Folder/Target.md':'target','Target.md':'root'}));
  await workspace.openNote('Folder/Note.md');const options=editorOptions.get(currentEditor())!;
  assert.equal(options.isUnresolved?.('Target.md','markdown'),false);
  assert.equal(options.isUnresolved?.('Missing','wiki'),true);
  const opened:string[]=[];window.open=((url:unknown)=>{opened.push(String(url));return null;}) as typeof window.open;
  await (workspace as any).followLink('Folder/Note.md','https://example.test',workspace.activePane,'markdown');
  await (workspace as any).followLink('Folder/Note.md','javascript:alert(1)',workspace.activePane,'markdown');
  assert.deepEqual(opened,['https://example.test']);assert.equal(workspace.vault.entries.size,4);
  await workspace.openVault({adapter:new MemoryAdapter({'Current.md':'current'}),label:'new',id:'new'});
  options.open('Should not exist','wiki');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(workspace.vault.entries.has('Should not exist.md'),false);
});

test('workspace sidebar controls persist outside scrolling tabs and retire with their shell',async t=>{
  const {workspace,root,destroy}=await setup(t,new MemoryAdapter({'Note.md':'note'}));
  await workspace.openNote('Note.md');
  const controls=root.querySelector<HTMLElement>(':scope > .workspace-sidebar-controls')!;
  const left=controls.querySelector<HTMLButtonElement>('.is-left')!,right=controls.querySelector<HTMLButtonElement>('.is-right')!;
  left.click();right.click();assert.ok(root.classList.contains('left-hidden'));assert.ok(!root.classList.contains('right-hidden'));
  assert.equal(left.getAttribute('aria-expanded'),'false');assert.equal(right.getAttribute('aria-expanded'),'true');
  await (workspace as any).split('right');await new Promise(resolve=>setImmediate(resolve));
  assert.ok(root.querySelector('.workspace-sidebar-controls')===controls);
  assert.equal(root.querySelectorAll('.workspace-sidebar-controls').length,1);
  assert.equal(root.querySelectorAll('.tab-bar[data-chrome-edge-left]').length,1);
  assert.equal(root.querySelectorAll('.tab-bar[data-chrome-edge-right]').length,1);
  for(const pane of workspace.panes){const bar=pane.element.querySelector('.tab-bar')!;assert.equal(bar.querySelectorAll(':scope > .tab-strip > .tab').length,pane.tabs.length);assert.ok(bar.querySelector(':scope > .tab-add'));}
  await workspace.openVault(workspace.platform);
  assert.ok(root.classList.contains('left-hidden'));assert.ok(!root.classList.contains('right-hidden'));
  left.click();right.click();assert.ok(root.classList.contains('left-hidden'));assert.ok(!root.classList.contains('right-hidden'));
  assert.equal(root.querySelectorAll('.workspace-sidebar-controls').length,1);
  await destroy();assert.equal(root.querySelector('.workspace-sidebar-controls'),null);assert.ok(!root.classList.contains('has-sidebar-controls'));
});

test('file-list background menu offers root creation and opens a valid new Canvas',async t=>{
  const {workspace,root,dom,adapter}=await setup(t,new MemoryAdapter({'Note.md':'note'}));
  await workspace.openNote('Note.md');let request:any;let choice='file-list.new-canvas';
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:async(value:any)=>{request=value;return choice;},dismissContextMenu:async()=>{}}});
  const active=root.querySelector<HTMLElement>('[role=treeitem][title="Note.md"]')!;active.focus();
  const surface=root.querySelector<HTMLElement>('.sidebar-content')!;
  const event=new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:52,clientY:311});surface.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);assert.equal(request.x,52);assert.equal(request.y,311);
  assert.deepEqual(request.items.map((item:any)=>item.label),['New note','New folder','New canvas']);assert.ok(active.classList.contains('is-active'));assert.notEqual(document.activeElement,active);
  await until(()=>workspace.activePane.tabs.find(tab=>tab.id===workspace.activePane.active)?.path==='Untitled.canvas'&&!!root.querySelector('.zorid-canvas'),'new Canvas mounted');
  assert.deepEqual(JSON.parse(await adapter.read('Untitled.canvas')),{nodes:[],edges:[]});
  choice='file-list.new-note';root.querySelector('.file-tree')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  await until(()=>workspace.vault.entries.has('Untitled.md')&&!!currentEditor(),'root note created');
});

test('a background popup and pending folder prompt cannot create into a replacement vault',async t=>{
  const {workspace,root,dom,adapter,click}=await setup(t,new MemoryAdapter({'Note.md':'note'}));
  let finish!:(id:string)=>void;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:()=>new Promise<string>(resolve=>finish=resolve),dismissContextMenu:async()=>{}}});
  root.querySelector('.file-tree')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));assert.ok(finish);
  const prompt=workspace.newFolder();const input=document.querySelector<HTMLInputElement>('[aria-label="New folder"]')!;input.value='Old prompt folder';
  const other=new MemoryAdapter({'Other.md':'other'});await workspace.openVault({adapter:other,id:'other',label:'Other'});
  finish('file-list.new-note');click('Create');await prompt;await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await adapter.list()).some(entry=>entry.path==='Untitled.md'||entry.path==='Old prompt folder'),false);
  assert.equal((await other.list()).some(entry=>entry.path==='Untitled.md'||entry.path==='Old prompt folder'),false);
});

for(const kind of ['note','canvas'] as const)test(`new ${kind} waiting on a save preserves a later pane activation`,async t=>{
  class SlowSaveAdapter extends MemoryAdapter {
    enabled=false;waiting=false;release!:()=>void;
    gate=new Promise<void>(resolve=>this.release=resolve);
    override async write(path:string,content:string):Promise<void>{
      if(this.enabled&&path==='Note.md'){this.waiting=true;await this.gate;}
      await super.write(path,content);
    }
  }
  const adapter=new SlowSaveAdapter({'Note.md':'note'});
  const {workspace,type}=await setup(t,adapter);
  await workspace.openNote('Note.md');await (workspace as any).split('right');
  const target=workspace.activePane,other=workspace.panes.find(pane=>pane!==target)!;
  adapter.enabled=true;type(currentEditor(),'dirty');
  const creating=kind==='note'?workspace.newNote():(workspace as any).newCanvas();
  await until(()=>adapter.waiting,'source save pending');
  other.element.focus();assert.ok(workspace.activePane===other);
  adapter.release();await creating;
  assert.ok(workspace.activePane===other);
  assert.equal(target.tabs.find(tab=>tab.id===target.active)?.path,'Note.md');
  assert.equal(await adapter.read('Note.md'),'dirty');
  assert.ok(workspace.vault.entries.has(`Untitled.${kind==='note'?'md':'canvas'}`));
});
