import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Workspace } from '../src/ui/workspace.ts';
import type { EditorHandle } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import type { DurableWrites } from '../src/core/durable-writes.ts';
import type { DocumentCursor, DocumentLiteralHit, DocumentLiteralPage, DocumentPage, DocumentPin, DocumentPinId, DocumentService, DocumentSnapshotId } from '../src/core/document-semantics.ts';
import { freshnessUntil, heldDocumentFreshness } from './fixtures/held-document-freshness.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const snapshot: DocumentSnapshotId = {
  localStoreId: 'store', generationEpoch: 'epoch', generation: '1',
  versions: { schema: 1, extraction: 'markdown-1', resolver: 'resolver-1', query: 'query-1' },
};
const source = { localStoreId: 'store', watermark: '10' };
const hit = (id = 'note', path = 'Note.md', line = 0): DocumentLiteralHit => ({
  entry: { id, path, revision: `revision-${id}`, kind: 'file', deleted: false },
  line, range: { bytes: [0, 6], utf16: [0, 6] }, snippet: `NeEdLe line ${line}`, snippetTruncated: false,
});
function page(hits: readonly DocumentLiteralHit[] = [], cursor: string | null = null, coverage = true, sourceBytes = 1): DocumentPage<DocumentLiteralPage> {
  return { result: { snapshot, source, coverageComplete: coverage, value: {
    snapshot, next: null, scanComplete: cursor === null, coverageComplete: coverage,
    complete: cursor === null && coverage, hits, sourceBytes, documents: 1,
  } }, cursor: cursor as DocumentCursor | null };
}
function fixture(search: (input: Parameters<DocumentPin['search']>[0], pinIndex: number) => Promise<DocumentPage<DocumentLiteralPage>>, coverage = true) {
  const pins: { closed: number }[] = [], queries: Parameters<DocumentPin['search']>[0][] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected semantic operation'); };
  const service: DocumentService = {
    status: async () => ({ source, snapshot, coveredSource: source, current: true, rebuildRequired: false, coverageComplete: coverage }),
    initialize: unused, rebuild: unused, begin: unused, pump: unused, publish: unused, discard: unused,
    open: async () => {
      const state = { closed: 0 }, index = pins.length; pins.push(state);
      return { pinId: String(index + 1) as DocumentPinId, snapshot, source, coverageComplete: coverage,
        close: async () => { state.closed++; }, search: async input => { queries.push(input); return search(input, index); },
        metadata: unused, backlinks: unused, base: unused };
    },
  };
  return { service, pins, queries };
}
async function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const adapter = new MemoryAdapter({ 'Note.md': 'Legacy needle', 'Settings.txt': 'Unknown text' });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  const workspace = new Workspace(root, (parent, options): EditorHandle => {
    const input = document.createElement('textarea'); input.value = options.value; parent.append(input);
    return { getValue: () => input.value, setValue: value => { input.value = value; }, focus: () => input.focus(),
      destroy: () => input.remove(), insert: text => { input.value += text; options.onChange(input.value); } };
  });
  t.after(async () => {
    delete (adapter as MemoryAdapter & { durableWrites?: DurableWrites }).durableWrites;
    try { await workspace.destroy(); }
    finally { dom.window.close(); for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    } }
  });
  await workspace.start({ adapter, id: 'test:workspace-document-search', label: 'Search test' });
  const internal = workspace as any;
  internal.treeTab = 'search'; internal.renderSidebar();
  return { workspace, adapter, root, internal,
    async search(query: string) { await Promise.resolve(); internal.query = query; await internal.search(); },
    setService(service: DocumentService) {
      (adapter as MemoryAdapter & { documentSemantics: DocumentService }).documentSemantics = service;
      internal.query = ''; internal.renderSidebar();
    },
  };
}

test('workspace shared search passes exact literals, pages one snapshot and groups existing titles/snippets without frontend reads', async t => {
  const ui = await setup(t), f = fixture(async input => input.cursor
    ? page([hit('note', 'Note.md', 4), hit('settings', 'Settings.txt')])
    : page([0, 1, 2, 3].map(line => hit('note', 'Note.md', line)), 'next'));
  ui.setService(f.service);
  ui.workspace.vault.read = async () => { assert.fail('Shared search must not read and parse vault files'); };
  await ui.search('NeEdLe');
  assert.deepEqual(f.queries.map(input => [input.query, input.cursor]), [['NeEdLe', null], ['NeEdLe', 'next']]);
  assert.equal(ui.root.querySelector('.search-box')?.getAttribute('aria-label'), 'Search text (case-sensitive)');
  assert.deepEqual([...ui.root.querySelectorAll('.search-result-title')].map(node => node.textContent), ['Note', 'Settings.txt']);
  assert.equal(ui.root.querySelectorAll('.search-result').length, 2);
  assert.equal(ui.root.querySelector('.search-result')?.querySelectorAll('.search-snippet').length, 4);
  assert.equal(ui.root.querySelector('.search-snippet')?.getAttribute('title'), 'Line 1');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'ready');
  assert.equal(f.pins.length, 1); assert.equal(f.pins[0].closed, 1);
});

for(const reason of ['query','source','sidebar','owner'] as const)test(`legacy Workspace search ${reason} cancels capable freshness before a late admission ACK`,async t=>{
  const ui=await setup(t),held=heldDocumentFreshness(),f=fixture(async()=>page());
  ui.setService({...f.service,maintenance:held.maintenance});
  const old=ui.search('old');await freshnessUntil(()=>held.requests.length===1);const first=held.requests[0];
  let latest:Promise<void>|undefined;
  if(reason==='query')latest=ui.search('new');
  else if(reason==='source')await ui.workspace.vault.modify('Note.md','new saved source');
  else if(reason==='sidebar'){ui.internal.treeTab='files';ui.internal.renderSidebar();}
  else {ui.internal.documentSearchSuspended=true;ui.internal.clearDocumentSearch();}
  assert.equal(f.pins.length,0);held.release(first);
  if(reason==='query'||reason==='source'){
    await freshnessUntil(()=>held.requests.length===2);ui.internal.clearDocumentSearch();held.release(held.requests[1]);
    await freshnessUntil(()=>held.outcomeAcks.includes(held.requests[1]));
  }
  await freshnessUntil(()=>held.outcomeAcks.includes(first));
  assert.equal(held.cancellations.includes(first),true);assert.equal(f.pins.length,0);
  await old;await latest;assert.equal(f.pins.length,0);assert.equal(held.subscriptions,0);
});

test('workspace shared search reserves the source budget before each page and labels bounded empty output incomplete', async t => {
  const ui = await setup(t); let calls = 0;
  const f = fixture(async () => page([], `page-${++calls}`, true, 16 * 1024 * 1024));
  ui.setService(f.service); await ui.search('absent');
  assert.equal(calls, 4, 'four maximum-size pages consume the complete 64 MiB budget');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'incomplete');
  assert.match(ui.root.querySelector('.search-results')!.textContent!, /Search limit reached/);
  assert.doesNotMatch(ui.root.querySelector('.search-results')!.textContent!, /No results found/);
  assert.equal(f.pins[0].closed, 1);
});

test('workspace shared search distinguishes excluded files and snapshot lag from true empty results', async t => {
  const ui = await setup(t), f = fixture(async () => page([], null, false), false);
  ui.setService(f.service); await ui.search('absent');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'incomplete');
  assert.match(ui.root.querySelector('.search-results')!.textContent!, /Some files could not be indexed/);
  const complete = fixture(async () => page()); ui.setService(complete.service); await ui.search('absent');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'empty');
  assert.match(ui.root.querySelector('.search-results')!.textContent!, /No results found/);
  const lagged = fixture(async () => page()); let observations = 0;
  lagged.service.status = async () => ({ source: ++observations === 1 ? source : { ...source, watermark: '11' },
    snapshot, coveredSource: source, current: observations === 1, rebuildRequired: false, coverageComplete: true });
  ui.setService(lagged.service); await ui.search('absent');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'lagged');
  assert.match(ui.root.querySelector('.search-results')!.textContent!, /older saved snapshot/);
  assert.doesNotMatch(ui.root.querySelector('.search-results')!.textContent!, /No results found/);
});

test('a new workspace query retires only its old pin and ignores a late old page', async t => {
  const ui = await setup(t), response = deferred<DocumentPage<DocumentLiteralPage>>();
  const f = fixture(async (_input, index) => index === 0 ? response.promise : page([hit('new', 'New.md')]));
  ui.setService(f.service); const old = ui.search('old'); await until(() => f.queries.length === 1, 'old page started');
  await ui.search('new');
  assert.deepEqual(f.pins.map(pin => pin.closed), [1, 1]);
  response.resolve(page([hit('old', 'Old.md')])); await old;
  assert.deepEqual([...ui.root.querySelectorAll('.search-result-title')].map(node => node.textContent), ['New']);
  assert.deepEqual(f.pins.map(pin => pin.closed), [1, 1], 'old finally must not close the newer query pin');
});

test('a late workspace search open after disposal retries a rejected close without rendering', async t => {
  const ui = await setup(t), opened = deferred<DocumentPin>();
  const f = fixture(async () => page([hit()])); const realOpen = f.service.open; let entered = false;
  f.service.open = async () => { entered = true; return opened.promise; };
  ui.setService(f.service); const pending = ui.search('old'); await until(() => entered, 'open started');
  ui.internal.disposeShell();
  const pin = await realOpen(); let closeAttempts = 0;
  opened.resolve({ ...pin, close: async () => { if (++closeAttempts === 1) throw new Error('Lost close ACK'); } });
  await pending;
  assert.equal(closeAttempts, 2); assert.equal(f.queries.length, 0);
  assert.equal(ui.root.querySelector('.search-result-title'), null);
});

test('workspace search keeps failed close ownership and retries before acquiring a replacement pin', async t => {
  const ui = await setup(t), f = fixture(async () => page([hit()]));
  const realOpen = f.service.open; let attempts = 0;
  f.service.open = async () => {
    assert.ok(f.pins.length === 0 || attempts >= 2, 'old close must be acknowledged before the next open');
    const pin = await realOpen(); return { ...pin, close: async () => { if (++attempts === 1) throw new Error('Lost close ACK'); } };
  };
  ui.setService(f.service); await ui.search('first');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'unavailable');
  await ui.search('second'); assert.equal(f.pins.length, 2); assert.equal(attempts, 3);
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'ready');
});

test('adapters without document semantics retain insensitive markdown and filename search', async t => {
  const ui = await setup(t); await ui.search('NOTE');
  assert.equal(ui.root.querySelector('.search-box')?.getAttribute('aria-label'), 'Search all files');
  assert.equal(ui.root.querySelector('.search-result-title')?.textContent, 'Note');
});

test('workspace result navigation resolves the stable ID to its current path instead of the indexed path', async t => {
  const ui = await setup(t);
  await ui.workspace.openNote('Note.md');
  await ui.internal.newTab(ui.workspace.activePane);
  const current = ui.workspace.vault.entries.get('Note.md')!;
  ui.workspace.vault.entries.set('Note.md', { ...current, entryId: 'note', revision: 'current-revision' });
  const f = fixture(async () => page([hit('note', 'Old.md')])); ui.setService(f.service);
  (ui.adapter as MemoryAdapter & { durableWrites: DurableWrites }).durableWrites = {
    readTextById: async id => ({ entryId: id, revision: 'current-revision', path: 'Note.md', content: 'Legacy needle', stat: { size: 13, ctime: 1, mtime: 1 } }),
  } as DurableWrites;
  await ui.search('NeEdLe');
  const title = ui.root.querySelector<HTMLButtonElement>('.search-result-title')!;
  assert.equal(title.textContent, 'Old'); title.click();
  await until(() => ui.workspace.activePane.tabs.find(tab => tab.id === ui.workspace.activePane.active)?.path === 'Note.md', 'current stable ID navigation');
  assert.ok(ui.workspace.panes.every(pane => pane.tabs.every(tab => tab.path !== 'Old.md')));
});

test('workspace result navigation ignores a durable ID lookup completed after its query changed', async t => {
  const ui = await setup(t), observed = deferred<Awaited<ReturnType<DurableWrites['readTextById']>>>();
  (ui.adapter as MemoryAdapter & { durableWrites: DurableWrites }).durableWrites = { readTextById: async () => observed.promise } as DurableWrites;
  ui.internal.query = 'before';
  const navigation = ui.internal.openDocumentSearchEntry('note', 'before');
  ui.internal.query = 'after';
  observed.resolve({ entryId: 'note', revision: 'revision', path: 'Note.md', content: 'Legacy needle', stat: { size: 13, ctime: 1, mtime: 1 } });
  await navigation;
  assert.equal(ui.workspace.activePane.tabs.find(tab => tab.id === ui.workspace.activePane.active)?.path, null);
});

test('vault teardown cancels search and queued sidebar work cannot acquire a replacement pin', async t => {
  const ui = await setup(t), response = deferred<DocumentPage<DocumentLiteralPage>>();
  const f = fixture(async () => response.promise); ui.setService(f.service);
  const pending = ui.search('old'); await until(() => f.queries.length === 1, 'old vault page');
  await ui.workspace.openVault({ adapter: new MemoryAdapter({ 'Fresh.md': 'fresh' }), id: 'test:fresh-search', label: 'Fresh' });
  response.resolve(page([hit('old', 'Old.md')])); await pending;
  assert.equal(f.pins[0].closed, 1);
  assert.equal(ui.root.querySelector('.search-result-title'), null);
  ui.internal.disposeShell(); await ui.internal.search();
  assert.equal(f.pins.length, 1);
});

test('rapid query cancellation serializes late opens and acquires only the final replacement pin', async t => {
  const ui = await setup(t), opened = deferred<DocumentPin>(), f = fixture(async input => page([hit(input.query, `${input.query}.md`)]));
  const realOpen = f.service.open; let opens = 0;
  f.service.open = async () => ++opens === 1 ? opened.promise : realOpen();
  ui.setService(f.service); const first = ui.search('first'); await until(() => opens === 1, 'first pending open');
  const second = ui.search('second'); const last = ui.search('last');
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(opens, 1);
  opened.resolve(await realOpen()); await Promise.all([first, second, last]);
  assert.equal(opens, 2); assert.equal(f.pins.length, 2);
  assert.deepEqual(f.queries.map(query => query.query), ['last']);
  assert.deepEqual(f.pins.map(pin => pin.closed), [1, 1]);
  assert.equal(ui.root.querySelector('.search-result-title')?.textContent, 'last');
});

test('workspace search caps low-byte pagination and preserves a whitespace literal', async t => {
  const ui = await setup(t); let calls = 0;
  const f = fixture(async () => page([], `page-${++calls}`, true, 0)); ui.setService(f.service);
  await ui.search(' ');
  assert.equal(calls, 64); assert.ok(f.queries.every(query => query.query === ' '));
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'incomplete');
  assert.equal(f.pins[0].closed, 1);
});

test('successful old-vault release retires lost-close acknowledgments before a new service searches', async t => {
  const ui = await setup(t), old = fixture(async () => page([hit()]));
  const realOpen = old.service.open; let released = false, closes = 0;
  old.service.open = async () => ({ ...await realOpen(), close: async () => {
    closes++; throw Object.assign(new Error(released ? 'Released owner' : 'Lost close ACK'), { code: released ? 'client_not_admitted' : 'transport_error' });
  } });
  ui.workspace.platform.release = async () => { released = true; };
  ui.setService(old.service); await ui.search('old');
  assert.equal(ui.root.querySelector('.search-results')?.getAttribute('data-state'), 'unavailable');
  const fresh = fixture(async () => page([hit('fresh', 'Fresh.md')]));
  const adapter = new MemoryAdapter({ 'Fresh.md': 'fresh' }) as MemoryAdapter & { documentSemantics: DocumentService };
  adapter.documentSemantics = fresh.service;
  await ui.workspace.openVault({ adapter, id: 'test:released-search-owner', label: 'Fresh' });
  await until(() => fresh.pins.length === 1 && fresh.pins[0].closed === 1, 'new service can search after final old cleanup');
  assert.equal(released, true); assert.equal(ui.root.querySelector('.search-result-title')?.textContent, 'Fresh');
  const settled = closes; await ui.internal.search();
  assert.equal(closes, settled, 'successful platform cleanup forbids retrying revoked old-service handles');
  assert.equal(fresh.pins.length, 2);
});

test('a pending old-vault open neither delays new-vault search nor resurrects released pin ownership', async t => {
  const ui = await setup(t), opened = deferred<DocumentPin>(), old = fixture(async () => page([hit()]));
  const realOpen = old.service.open; let entered = false, released = false, closes = 0;
  old.service.open = async () => { entered = true; return opened.promise; };
  ui.workspace.platform.release = async () => { released = true; };
  ui.setService(old.service); const pending = ui.search('old'); await until(() => entered, 'old service open pending');
  const fresh = fixture(async () => page([hit('fresh', 'Fresh.md')]));
  const adapter = new MemoryAdapter({ 'Fresh.md': 'fresh' }) as MemoryAdapter & { documentSemantics: DocumentService };
  adapter.documentSemantics = fresh.service;
  await ui.workspace.openVault({ adapter, id: 'test:late-released-search-owner', label: 'Fresh' });
  await until(() => fresh.pins.length === 1 && fresh.pins[0].closed === 1, 'new search does not await old pending open');
  assert.equal(released, true);
  opened.resolve({ ...await realOpen(), close: async () => { closes++; throw new Error('Released service cannot accept close'); } });
  await pending; assert.equal(closes, 0, 'backend final cleanup already retired this late transport handle');
  assert.equal(ui.root.querySelector('.search-result-title')?.textContent, 'Fresh');
  await ui.internal.search(); assert.equal(fresh.pins.length, 2);
});

test('failed platform release preserves old-owner close retries', async t => {
  const ui = await setup(t), f = fixture(async () => page([hit()]));
  const realOpen = f.service.open; let closes = 0;
  f.service.open = async () => ({ ...await realOpen(), close: async () => { closes++; throw new Error('Lost close ACK'); } });
  ui.setService(f.service); await ui.search('old');
  ui.workspace.platform.release = async () => { throw new Error('Release failed'); };
  await assert.rejects(ui.internal.releasePlatform(), /Release failed/);
  const before = closes; await ui.search('retry');
  assert.ok(closes > before, 'no final cleanup ACK means ownership must remain retryable');
  assert.equal(f.pins.length, 1, 'failed closes still block replacement pins from the same service');
  ui.workspace.platform.release = async () => {};
});

function richFixture(){
  const f=fixture(async()=>{throw new Error('Literal fallback forbidden');});let starts=0,pages=0;
  const original=f.service.open;
  Object.assign(f.service,{richSearchAvailable:true,open:async()=>({...await original(),richSearch:async({spec}:any)=>{
    starts++;return {queryId:String(starts),prepare:async()=>({state:'ready',cursor:'ready'}),close:async()=>{},page:async()=>{pages++;return {cursor:null,result:{snapshot,source,coverageComplete:true,value:{snapshot,next:null,scanComplete:true,coverageComplete:true,complete:true,dialect:'zorid-search-rust-unicode-1',spec,explanation:null,
      files:[{entry:hit().entry,chunk:0,lastChunk:true,occurrenceCount:9,locations:[],snippets:[]}],totals:{files:{relation:'exact',value:1},occurrences:{relation:'exact',value:9}},coverage:{candidateFiles:1,evaluatedFiles:1,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true},outputComplete:true,work:{documents:1,sourceBytes:1,units:1}}}};}};
  }})});return {...f,get starts(){return starts;},get pages(){return pages;}};
}

test('Workspace mounts rich capability and preserves query/pin/view during sidebar refresh and note opening',async t=>{
  const ui=await setup(t),f=richFixture();ui.setService(f.service);
  const input=ui.root.querySelector<HTMLInputElement>('.document-search input[type="search"]')!;assert.ok(input);input.value='needle';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  await until(()=>f.pages===1,'first rich page');assert.equal(ui.root.querySelector('.document-search-badge')?.textContent,'9');
  ui.internal.renderSidebar();await ui.workspace.openNote('Note.md');ui.internal.renderSidebar();
  assert.equal(ui.root.querySelector('.document-search input[type="search"]'),input);assert.equal(f.pins.length,1);assert.equal(f.starts,1);
  ui.root.querySelector<HTMLButtonElement>('.document-search-case')!.click();await until(()=>f.starts===2,'case query');assert.equal(f.pins.length,1);
});

test('Workspace refreshes rich search for committed source changes and closes on leaving Search',async t=>{
  const ui=await setup(t),f=richFixture();ui.setService(f.service);await ui.search('needle');await until(()=>f.pages===1,'rich search');
  await ui.workspace.vault.create('New.md','saved');await until(()=>f.pages===2,'committed source refresh');assert.equal(f.pins.length,2);assert.equal(f.pins[0].closed,1);
  ui.internal.treeTab='files';ui.internal.renderSidebar();await until(()=>f.pins[1].closed===1,'close rich sidebar');assert.equal(ui.root.querySelector('.document-search'),null);
});

test('Workspace rich failure never invokes legacy evaluator',async t=>{
  const ui=await setup(t),f=richFixture();Object.assign(f.service,{open:async()=>{throw new Error('SQL raw secret');}});ui.setService(f.service);
  ui.workspace.vault.read=async()=>assert.fail('No frontend fallback');await ui.search('needle');await until(()=>!!ui.root.querySelector('.document-search-status')?.textContent?.includes('unavailable'),'rich error');
  assert.doesNotMatch(ui.root.querySelector('.document-search-status')!.textContent!,/SQL raw secret/);assert.equal(f.queries.length,0);
});

test('Workspace rich bounded catch-up with an older snapshot never admits it as current',async t=>{
  const ui=await setup(t),f=richFixture(),held=heldDocumentFreshness();
  Object.assign(f.service,{maintenance:held.maintenance,status:async()=>({source:{...source,watermark:'11'},snapshot,coveredSource:source,current:false,rebuildRequired:false,coverageComplete:true})});
  ui.setService(f.service);await ui.search('external-marker');
  await freshnessUntil(()=>held.requests.length===1);const request=held.requests[0];held.release(request);held.finish(request);
  await until(()=>!!ui.root.querySelector('.document-search-status')?.textContent?.includes('still updating'),'bounded old generation was incorrectly admitted');
  assert.equal(f.pins.length,0);assert.equal(f.starts,0);assert.equal(ui.root.querySelector('.document-search-total')?.textContent,'');
  assert.doesNotMatch(ui.root.querySelector('.document-search-status')!.textContent!,/No matching files/);
});

function prepareRichNavigation(ui:Awaited<ReturnType<typeof setup>>,options:{path?:string;dirty?:boolean;revision?:string}={}){
  const {workspace,adapter,internal}=ui,path=options.path??'Note.md';const saved=workspace.vault.entries.get('Note.md')!;
  workspace.vault.entries.set(path,{...saved,path,entryId:'note',revision:options.revision??'revision-note'});
  adapter.stat=async()=>workspace.vault.entries.get(path)!;
  const selections:any[]=[];let opens=0,reads=0;
  const pane=workspace.activePane;
  pane.editor={getValue:()=> 'needle',getViewState:()=>({selection:{ranges:[{anchor:0,head:0}],mainIndex:0},scrollTop:0,scrollLeft:0}),restoreViewState:(state:any)=>{selections.push(state);},destroy(){},focus(){},setValue(){},insert(){}};
  workspace.buffers.set(path,{dirty:options.dirty??false,error:null,text:'needle',savedText:'needle',savedDurableWitness:{entryId:'note',revision:options.revision??'revision-note',path},dispose:async()=>{},flush:async()=>{},flushForNavigation:async()=>{}} as any);
  workspace.vault.readDurableTextById=async()=>{reads++;return {entryId:'note',revision:options.revision??'revision-note',path,content:'needle',stat:{ctime:0,mtime:0,size:6}};};
  internal.openNote=async()=>{opens++;internal.current(pane).path=path;internal.navigationIntent.set(pane,(internal.navigationIntent.get(pane)??0)+1);};
  const entry={...hit().entry,path};
  return {entry,selections,get opens(){return opens;},get reads(){return reads;},invoke:(location:any)=>internal.openRichDocumentSearchEntry(entry,location,false,()=>true)};
}

test('rich binary and non-source matches admit stable stat identity without text reads or fabricated selection',async t=>{
  const ui=await setup(t),nav=prepareRichNavigation(ui,{path:'Picture.png'});
  await nav.invoke({index:0,locator:{origin:'filename',range:{bytes:[0,1],utf16:[0,1]}},role:'occurrence',occurrences:1});assert.equal(nav.opens,1);assert.equal(nav.reads,0);assert.equal(nav.selections.length,0);
  ui.adapter.stat=async()=>({...ui.workspace.vault.entries.get('Picture.png')!,entryId:'replacement'});await nav.invoke(undefined);assert.equal(nav.opens,1);
});

test('rich source selection requires exact current saved revision, clean corresponding buffer and editor',async t=>{
  const ui=await setup(t),nav=prepareRichNavigation(ui);const location={index:0,locator:{origin:'source',range:{bytes:[1,3],utf16:[1,3]},kind:'occurrence'},role:'occurrence',occurrences:1};
  await nav.invoke(location);assert.equal(nav.selections.length,1);assert.deepEqual(nav.selections[0].selection.ranges,[{anchor:1,head:3}]);
  ui.workspace.buffers.get('Note.md')!.dirty=true;await nav.invoke(location);assert.equal(nav.selections.length,1);
  ui.workspace.buffers.get('Note.md')!.dirty=false;ui.workspace.vault.readDurableTextById=async()=>({entryId:'note',revision:'newer',path:'Note.md',content:'changed',stat:{ctime:0,mtime:0,size:7}});await nav.invoke(location);assert.equal(nav.selections.length,1);assert.equal(nav.opens,3);
});

test('rich source selection retires a late durable read after a new navigation intent',async t=>{
  const ui=await setup(t),nav=prepareRichNavigation(ui),pending=deferred<any>();let reading=false;ui.workspace.vault.readDurableTextById=()=>{reading=true;return pending.promise;};
  const opening=nav.invoke({locator:{origin:'source',range:{bytes:[0,1],utf16:[0,1]}}});await until(()=>reading,'post-open source read');
  ui.internal.navigationIntent.set(ui.workspace.activePane,99);pending.resolve({entryId:'note',revision:'revision-note',path:'Note.md',content:'needle'});await opening;assert.equal(nav.opens,1);assert.equal(nav.selections.length,0);
});

test('rich result click survives its own dirty-pane committed flush',async t=>{
  const ui=await setup(t),f=richFixture();ui.setService(f.service);await ui.search('needle');await until(()=>f.pages===1,'rich search ready');
  const pane=ui.workspace.activePane;
  ui.workspace.vault.entries.get('Note.md')!.entryId='note';ui.workspace.vault.entries.get('Note.md')!.revision='revision-note';
  ui.adapter.stat=async()=>ui.workspace.vault.entries.get('Note.md')!;
  // Exercise the real openNote post-flush gate. A committed edit to the active
  // note refreshes search while that click is still waiting to open its target.
  ui.internal.flushPane=async()=>{await ui.workspace.vault.modify('Note.md','committed dirty edit');};
  let admitted=false;
  ui.internal.bufferFor=async()=>({});
  const realOpen=ui.workspace.openNote.bind(ui.workspace);
  ui.workspace.openNote=async(...args)=>{await realOpen(...args);admitted=ui.internal.current(pane).path==='Note.md';};
  ui.root.querySelector<HTMLButtonElement>('.document-search-title')!.click();
  await until(()=>admitted,'search result admitted after flush');
  assert.equal(ui.internal.current(pane).path,'Note.md');
});

test('source-only committed refresh preserves a live IME search draft through compositionend',async t=>{
  const ui=await setup(t),f=richFixture();ui.setService(f.service);await ui.search('needle');await until(()=>f.pages===1,'rich search ready');
  const input=ui.root.querySelector<HTMLInputElement>('.document-search input[type="search"]')!;
  input.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));input.value='漢字';input.dispatchEvent(new window.InputEvent('input',{bubbles:true,isComposing:true}));
  await ui.workspace.vault.create('New.md','saved');assert.equal(input.value,'漢字');
  input.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'漢字'}));assert.equal(ui.internal.query,'漢字');
  await until(()=>f.pages===2,'new composed query');assert.equal(input.value,'漢字');
});

test('a later rich result click reserves navigation before an older stat lookup can finish',async t=>{
  const ui=await setup(t),nav=prepareRichNavigation(ui),pending=deferred<any>();let calls=0;
  ui.adapter.stat=async()=>++calls===1?pending.promise:ui.workspace.vault.entries.get('Note.md')!;
  const first=nav.invoke(undefined);await until(()=>calls===1,'first stat pending');await nav.invoke(undefined);assert.equal(nav.opens,1);
  pending.resolve(ui.workspace.vault.entries.get('Note.md'));await first;assert.equal(nav.opens,1);
});

test('post-open source proof cannot select into a same-path replacement editor',async t=>{
  const ui=await setup(t),nav=prepareRichNavigation(ui),pending=deferred<any>();let reading=false;
  ui.workspace.vault.readDurableTextById=()=>{reading=true;return pending.promise;};
  const opening=nav.invoke({locator:{origin:'source',range:{bytes:[0,1],utf16:[0,1]}}});await until(()=>reading,'source proof pending');
  const replacementSelections:any[]=[];ui.workspace.activePane.editor={...ui.workspace.activePane.editor!,restoreViewState:state=>replacementSelections.push(state)};
  pending.resolve({entryId:'note',revision:'revision-note',path:'Note.md',content:'needle'});await opening;
  assert.equal(nav.selections.length,0);assert.equal(replacementSelections.length,0);
});
