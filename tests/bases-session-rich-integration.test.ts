import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type {DatabaseService,DatabaseCollection,DatabaseEntry,DatabaseRequest,DatabaseResponse,DatabaseValue} from '../src/core/databases.ts';
import type { DocumentBaseResult, DocumentService, DocumentBaseValue } from '../src/core/document-semantics.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { BaseDocument } from '../src/bases/document.ts';
import { createBaseSession } from '../src/bases/session.ts';
import { baseEditablePropertyValue, baseImageSourceValue } from '../src/bases/view-actions.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 8));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await tick(); } assert.ok(await check()); }
class Adapter extends MemoryAdapter {
  documentSemantics?: DocumentService;databases?:DatabaseService;
  revisions = new Map<string, number>();
  fail = false;attempts=0;generation=1;
  identify<T extends { path: string }>(row: T) { return { ...row, entryId: row.path, revision: `r${this.revisions.get(row.path) ?? 1}` }; }
  override async list() { return (await super.list()).map(row => this.identify(row)); }
  override async stat(path: string) { const row = await super.stat(path); return row && this.identify(row); }
  override async write(path: string, text: string) { if(path==='Work.base')this.attempts++;if (this.fail && path === 'Work.base') throw new Error('Summary disk unavailable'); await super.write(path, text); this.revisions.set(path, (this.revisions.get(path) ?? 1) + 1);this.generation++; }
}
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } }, source = { localStoreId: 'store', watermark: '1' };
const collectionId='richcollectn',scoreId='scorevalueid',projectsId='projectsprop';
const scoreKey=`note.${scoreId}`,projectsKey=`note.${projectsId}`;
const optionNames=['[[Projects/A|My alias]]','[[Unknown|Keep me]]','[[Projects/B]]','[[Projects/C]]'];
const optionIds=['projectaaaaa','projectbbbbb','projectccccc','projectddddd'];
const body='Body',unmanaged='unmanaged: keep # not collection-owned\n';
const summaryBase = 'views:\n  - type: table\n    name: Table\n    order: [file.name, score, projects]\n    summaries: {score: Sum}\n  - type: cards\n    name: Cards\n    summaries: {score: Sum}\n';
function summaryDefinitions(document:BaseDocument,index=0):Record<string,string>{return(document.views[index].summaryDefinitions??{}) as Record<string,string>;}
function capturedCollectionConfiguration(source:string):string {
  const parsed=BaseDocument.parse(source),root=parsed.getRoot('summaries');
  const field=(value:unknown):unknown=>{
    if(value==='score')return scoreId;if(value==='projects')return projectsId;
    if(value==='note.score')return scoreKey;if(value==='note.projects')return projectsKey;
    if(Array.isArray(value))return value.map(field);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[String(field(key)),field(item)]));return value;
  };
  for(const[index,view]of parsed.views.entries())parsed.updateView(index,{...field(view) as typeof view,id:index===0?'viewtableaaa':'viewcardsaaa',source:{kind:'collection',id:collectionId},...(root?{summaryDefinitions:structuredClone(root)}:{}),...(view.groupBy&&!view.groupOrder?{groupOrder:[10,20]}:{})});
  if(root!==undefined)parsed.updateRoot({summaries:undefined});return parsed.toString();
}
async function fixture(base = summaryBase, browsingOnly = false, controlPaint = false) {
  base=browsingOnly?base:capturedCollectionConfiguration(base);
  const projected=(values:Readonly<Record<string,DatabaseValue>>)=>[
    '---',unmanaged.trimEnd(),`"_id": "One.md"`,`"_type": "Rich fixture"`,
    `"projects": ${JSON.stringify((values[projectsId] as string[]).map(id=>optionNames[optionIds.indexOf(id)]))}`,
    `"score": ${JSON.stringify(values[scoreId])}`,'---',body,
  ].join('\n');
  let values:Readonly<Record<string,DatabaseValue>>={[scoreId]:10,[projectsId]:optionIds.slice(0,2)},memberRevision=1;
  const initialNote=projected(values),adapter=new Adapter({'Work.base':base,'One.md':initialNote});
  const collection:DatabaseCollection={id:collectionId,name:'Rich fixture',revision:'schema-r1',deleted:false,properties:[
    {id:scoreId,name:'score',datatype:'number',options:[]},
    {id:projectsId,name:'projects',datatype:'multi-select',options:optionIds.map((id,index)=>({id,name:optionNames[index]}))},
  ]};
  let member:DatabaseEntry={entryId:'One.md',collectionId,revision:'member-r1',fileRevision:'r1',path:'One.md',values,deleted:false,pendingProjection:false};
  const operations=new Map<string,{request:DatabaseRequest;response:DatabaseResponse}>(),requests:DatabaseRequest[]=[];
  let getGate:{skip:number;entered:()=>void;release:Promise<void>}|undefined;
  const holdGet=(skip:number)=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
    getGate={skip,entered,release:released};return{started,release};
  };
  const response=():DatabaseResponse=>({collections:[structuredClone(collection)],entries:[structuredClone(member)],projection:{pending:0,issues:[]}});
  adapter.databases={async request(command){
    requests.push(structuredClone(command));
    if(command.op==='list')return response();
    if(command.op==='get'){assert.equal(command.collectionId,collection.id);if(getGate&&getGate.skip--===0){const gate=getGate;getGate=undefined;gate.entered();await gate.release;}return response();}
    if(command.op==='get_entry'){assert.equal(command.entryId,member.entryId);return response();}
    assert.equal(command.op,'set_entry','this fixture accepts only typed member value commands');if(command.op!=='set_entry')throw Error('Unexpected collection command');
    assert.match(command.operationId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const old=operations.get(command.operationId);if(old){assert.deepEqual(command,old.request,'same operation cannot acquire a new semantic request');return structuredClone(old.response);}
    assert.equal(command.entryId,member.entryId);assert.equal(command.expectedRevision,member.revision);assert.equal(command.expectedCollectionRevision,collection.revision);
    const before=await adapter.stat(member.path);assert.equal(before?.entryId,member.entryId);assert.equal(before?.revision,member.fileRevision,'member publication cannot borrow a newer physical source');
    assert.equal(await adapter.read(member.path),projected(values),'managed values, reserved identity, body and unowned bytes still match the original publication');
    const next={...values};for(const[id,value]of Object.entries(command.values)){
      assert.ok(collection.properties.some(field=>field.id===id),'only canonical schema property IDs may be authored');
      if(id===scoreId)assert.ok(typeof value==='number'&&Number.isFinite(value));
      else {assert.ok(Array.isArray(value));assert.equal(new Set(value as string[]).size,(value as string[]).length);for(const selected of value as string[])assert.ok(optionIds.includes(selected),'multi-select values are stable option IDs, not projected labels');}
      next[id]=structuredClone(value);
    }
    const desired=projected(next);await adapter.write(member.path,desired);values=next;
    member={...member,revision:`member-r${++memberRevision}`,fileRevision:(await adapter.stat(member.path))!.revision,values,pendingProjection:false};
    const saved=response();operations.set(command.operationId,{request:structuredClone(command),response:structuredClone(saved)});return saved;
  }};
  const currentSnapshot=()=>({...snapshot,generation:String(adapter.generation)}),currentSource=()=>({...source,watermark:String(adapter.generation)});
  const unused=async():Promise<never>=>{throw Error('Unexpected core operation');};
  // Typed transport simulation: schema/member state and saved bytes determine
  // every response. This does not execute or claim parity with the Rust query
  // evaluator. Native projects IDs through property/option names (Store's
  // projected_properties/rendered); unrelated Markdown remains exact.
  adapter.documentSemantics={
    status:async()=>({source:currentSource(),snapshot:currentSnapshot(),coveredSource:currentSource(),current:true,rebuildRequired:false,coverageComplete:true}),initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>{
      const generation=adapter.generation;
      const [savedBase,savedNote,baseText,noteText]=await Promise.all([adapter.stat('Work.base'),adapter.stat('One.md'),adapter.read('Work.base'),adapter.read('One.md')]);
      const pinnedValues=structuredClone(values),pinnedMember=structuredClone(member);
      assert.equal(adapter.generation,generation,'a read pin cannot combine two metadata generations');assert.ok(savedBase&&savedNote);
      assert.equal(savedNote.revision,pinnedMember.fileRevision);assert.equal(noteText,projected(pinnedValues));
      const snapshot={...currentSnapshot(),generation:String(generation)},source={...currentSource(),watermark:String(generation)},entries=new Map([[savedBase.entryId,savedBase],[savedNote.entryId,savedNote]]);
      const definition={id:savedBase.entryId,revision:savedBase.revision,path:savedBase.path,kind:'file' as const,deleted:false};
      return{pinId:'pin' as never,source,snapshot,coverageComplete:true,close:async()=>{},search:unused,backlinks:unused,
      metadata:async id=>{const row=entries.get(id);assert.ok(row,'metadata stays within its captured actors');return{source,snapshot,coverageComplete:true,value:{entry:{id:row.entryId,revision:row.revision,path:row.path,kind:'file' as const,deleted:false},metadata:null,exclusion:null}};},
      base:async input=>{
        const document=BaseDocument.parse(baseText),view=document.views[input.options?.viewIndex??0],identity=savedNote;
        const raw=parse(noteText.match(/^---\n([\s\S]*?)\n---/)![1]) as {score:number;projects:string[]};
        assert.equal(identity.revision,pinnedMember.fileRevision);assert.deepEqual(raw.projects,(pinnedValues[projectsId] as string[]).map(id=>optionNames[optionIds.indexOf(id)]));assert.equal(raw.score,pinnedValues[scoreId]);
        const score=browsingOnly?'note.score':scoreKey,projects=browsingOnly?'note.projects':projectsKey;
        const display:DocumentBaseValue=browsingOnly?{type:'list',value:raw.projects.map(()=>({type:'link',path:'Projects/A',display:'Rendered label',external:false}))}:{type:'list',value:(pinnedValues[projectsId] as string[]).map(value=>({type:'string',value}))};
        const selections=(view.summaries??{}) as Record<string,string>,selectedProperties=Array.isArray(view.order)?view.order.map(value=>value==='file.name'?value:`note.${String(value).replace(/^note\./,'')}`):['file.name',score,projects];
        const result:DocumentBaseResult={snapshotId:snapshot,view,rows:[{entryId:identity.entryId,revision:identity.revision,path:'One.md',values:{'file.name':{type:'string',value:'One'},[score]:{type:'number',value:raw.score},[projects]:display},...(!browsingOnly?{editValues:{[projects]:{type:'list',value:(pinnedValues[projectsId] as string[]).map(value=>({type:'string' as const,value}))},[score]:{type:'number',value:raw.score}}}:{})}],
          groups:view.groupBy?[{key:{type:'number',value:raw.score},keyId:'ten',entryIds:['One.md'],summaries:{[score]:{type:'number',value:raw.score}}},{key:{type:'number',value:20},keyId:'twenty',entryIds:[],summaries:{[score]:{type:'number',value:0}}}]:[{key:null,keyId:null,entryIds:['One.md']}],groupOptions:[],properties:selectedProperties,availableProperties:['file.name',score,projects],counts:{scanned:1,matched:1,afterGroupOrder:1,afterSearch:1,returned:1},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1,
          summaries:Object.fromEntries(Object.keys(selections).map(key=>[`note.${key.replace(/^note\./,'')}`,{type:'number' as const,value:raw.score}])),summaryPreviews:{Sum:{type:'number',value:raw.score},Empty:{type:'number',value:0}},
        };return{source,snapshot,coverageComplete:true,value:{definition,result}};
      },
    };},
  };
  const vault=new Vault(adapter);await vault.initialize();const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!,buffers=new Map<string,NoteBuffer>(),errors:unknown[]=[],opened:{path:string;witness?:{entryId:string;revision:string}}[]=[];
  const frames=new Map<number,FrameRequestCallback>();let nextFrame=0;
  if(controlPaint){dom.window.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame;};dom.window.cancelAnimationFrame=handle=>{frames.delete(handle);};}
  const session=createBaseSession(host,{vault,basePath:'Work.base',validate(){},openFile(path,_event,witness){opened.push({path,witness});},onError(error){errors.push(error);},buffers:{validate(){},async getBuffer(path){let buffer=buffers.get(path);if(!buffer){buffer=new NoteBuffer(vault,path);Object.defineProperty(buffer,'savedDurableWitness',{get:()=>({path,entryId:path,revision:`r${adapter.revisions.get(path)??1}`})});buffers.set(path,buffer);}await buffer.load();return buffer;}}});await session.ready;assert.ifError(session.state.error);
  const key=(element:Element,key:string,extra={})=>element.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  return{adapter,vault,dom,host,session,errors,opened,key,requests,operations,initialNote,projected,holdGet,get member(){return structuredClone(member);},renameScore(name:string){collection.properties[0]={...collection.properties[0],name};collection.revision='schema-r2';},pendingPaint:()=>frames.size,async paint(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(0);await tick();},async dropGroups(){const document=BaseDocument.parse(await adapter.read('Work.base'));document.updateView(0,{groupBy:undefined,groupOrder:undefined});await vault.modify('Work.base',document.toString());},async cleanup(){adapter.fail=false;for(const input of dom.window.document.querySelectorAll('.bases-property-popover input,[data-base-editing] input'))key(input,'Escape');dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')?.click();await until(()=>!session.hasPendingChanges());await session.close();for(const buffer of buffers.values())await buffer.dispose();dom.window.close();}};
}

test('acknowledged collection cell edits reuse the schema read already loaded for the refreshed query',async()=>{
  const f=await fixture();
  try{
    for(const value of [11,12]){
      const before=f.requests.filter(request=>request.op==='get').length,gate=f.holdGet(1);
      const cell=f.host.querySelector<HTMLElement>(`[data-property="${scoreKey}"][role="gridcell"]`)!;
      f.key(cell,'Enter');const input=cell.querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=String(value);f.key(input,'Enter');
      try{await gate.started;assert.equal(f.session.hasPendingChanges(),true,'the committed edit still awaits current-query schema');assert.equal(input.isConnected,true,'the mounted editor survives the schema read');}finally{gate.release();}
      await f.session.flush();
      assert.equal(f.member.values[scoreId],value);
      assert.equal(f.requests.filter(request=>request.op==='get').length-before,2,'one pre-query schema read and one current-query schema read; no duplicate post-query get');
      await tick();
    }
    const writes=f.requests.filter((request):request is Extract<DatabaseRequest,{op:'set_entry'}>=>request.op==='set_entry');
    assert.deepEqual(writes.map(request=>request.expectedRevision),['member-r1','member-r2']);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('unchanged Base configuration still reloads externally changed collection schema',async()=>{
  const f=await fixture();
  try{
    const saved=await f.vault.read('Work.base');f.renameScore('Updated score');
    await f.vault.create('External.md','external event');
    await until(()=>f.host.querySelector(`[data-property="${scoreKey}"][role="columnheader"]`)?.textContent?.includes('Updated score')===true);
    assert.equal(await f.vault.read('Work.base'),saved);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});

test('raw editing adapter accepts inert values and rejects rich values without saved source', () => {
  const link = { type: 'namespace', name: 'Rendered' } as BaseExpressionValue;
  assert.equal(baseEditablePropertyValue({ path: 'One.md', values: { 'note.x': link } }, 'note.x'), undefined);
  const raw = { type: 'string', value: '[[Target|Alias]]' } as const;
  assert.equal(baseEditablePropertyValue({ path: 'One.md', values: { 'note.x': link }, editValues: { 'note.x': raw } }, 'note.x'), raw);
  assert.deepEqual(baseEditablePropertyValue({ path: 'One.md', values: {} }, 'note.missing'), { type: 'null' });
});

test('managed multi-select chips project option names without losing aliases through repeated acknowledgements', async () => {
  const f = await fixture();
  try {
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.projectsprop"][role="gridcell"]')!; f.key(cell, 'Enter');
    for (const label of ['B', 'C']) {
      const input = f.dom.window.document.querySelector<HTMLInputElement>('.bases-property-popover input')!; assert.ok(input);
      input.value = `[[Projects/${label}]]`; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(input, 'Enter');
      await until(async () => (await f.vault.read('One.md')).includes(`[[Projects/${label}]]`)); await tick();
      assert.ok(f.dom.window.document.querySelector('.bases-property-popover input'), 'own acknowledged refresh keeps the chip editor alive');
      const accepted=f.requests.filter(request=>request.op==='set_entry').at(-1)!;const savedRevision=(await f.adapter.stat('One.md'))!.revision;await f.adapter.databases!.request(structuredClone(accepted));assert.equal((await f.adapter.stat('One.md'))!.revision,savedRevision,'exact operation replay never publishes a second file write');
    }
    const saved = parse((await f.vault.read('One.md')).match(/^---\n([\s\S]*?)\n---/)![1]);
    assert.deepEqual(saved.projects, ['[[Projects/A|My alias]]', '[[Unknown|Keep me]]', '[[Projects/B]]', '[[Projects/C]]']);
    assert.equal(await f.adapter.read('One.md'),'---\nunmanaged: keep # not collection-owned\n"_id": "One.md"\n"_type": "Rich fixture"\n"projects": ["[[Projects/A|My alias]]","[[Unknown|Keep me]]","[[Projects/B]]","[[Projects/C]]"]\n"score": 10\n---\nBody','managed projection preserves the complete original aliases, reserved identity, unrelated frontmatter and body');assert.equal(f.operations.size,2);assert.equal(f.member.revision,'member-r3');assert.equal(f.member.fileRevision,'r3');assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('vault browsing keeps formatted relation values read-only without fabricating edit authority', async () => {
  const f = await fixture(summaryBase, true);
  try {
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.projects"][role="gridcell"]')!; f.key(cell, 'Enter');
    assert.ok(cell.matches('[data-base-edit-unavailable]') || cell.querySelector('[data-base-edit-unavailable]')); assert.equal(f.dom.window.document.querySelector('.bases-property-popover'), null);
    assert.match(await f.vault.read('One.md'), /My alias/);assert.equal(await f.vault.read('One.md'),f.initialNote);assert.equal(f.requests.filter(request=>request.op==='set_entry').length,0);
  } finally { await f.cleanup(); }
});

test('collection summary edits and deletion stay scoped to their selected view and preserve its sibling', async () => {
  const f = await fixture();
  try {
    const sibling=structuredClone(BaseDocument.parse(await f.vault.read('Work.base')).views[1]);
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.scorevalueid"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]') || f.errors.length > 0); assert.deepEqual(f.errors, []);
    assert.deepEqual(summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))), { Sum: 'values.sum().round(2)' });
    const name = f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Summary name"]')!;
    name.value = 'Revenue'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(name, 'Enter');
    await until(async () => Object.hasOwn((summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))) ?? {}) as object, 'Revenue'));
    const renamed=BaseDocument.parse(await f.vault.read('Work.base'));assert.equal((renamed.views[0].summaries as Record<string,string>)[scoreId],'Revenue');assert.deepEqual(renamed.views[1],sibling,'another view never acquires the selected view’s summary rename');
    const expression = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!;
    expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await until(async () => (summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))) as Record<string, string>).Revenue === 'values.length');
    assert.equal(f.dom.window.document.querySelector('.bases-summary-editor button[type="submit"]'), null);
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Summary actions"]')!.click();
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Delete summary')!.click();
    await until(() => !f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const saved = BaseDocument.parse(await f.vault.read('Work.base')); assert.deepEqual(summaryDefinitions(saved), {}); assert.ok(!Object.values(saved.views[0].summaries??{}).includes('Revenue'));assert.deepEqual(saved.views[1],sibling,'deletion preserves the other view’s selection and definitions');assert.equal(saved.getRoot('summaries'),undefined);assert.equal(await f.adapter.read('One.md'),f.initialNote,'summary configuration never authors the note'); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('view keyboard shortcuts wrap and preserve active property drafts', async () => {
  const f = await fixture();
  try {
    const root = f.host.querySelector('.bases-session')!;
    f.key(root, 'PageUp', { ctrlKey: true, shiftKey: true }); await until(() => f.session.state.result?.view.name === 'Cards');
    f.key(root, 'PageDown', { ctrlKey: true, shiftKey: true }); await until(() => f.session.state.result?.view.name === 'Table');
    f.key(root, 'PageUp', { ctrlKey: true, shiftKey: true, isComposing: true }); await tick(); assert.equal(f.session.state.result?.view.name, 'Table');
    const cell = f.host.querySelector<HTMLElement>('[data-property="note.scorevalueid"][role="gridcell"]')!; f.key(cell, 'Enter');
    const input = cell.querySelector<HTMLInputElement>('input')!; input.value = '21';
    f.key(input, 'PageDown', { ctrlKey: true, shiftKey: true }); await tick();
    assert.equal(f.session.state.result?.view.name, 'Table'); assert.equal(input.value, '21'); assert.match(String(f.errors.at(-1)), /Finish or cancel/); f.key(input, 'Escape');
  } finally { await f.cleanup(); }
});

test('Add summary selects a unique empty draft, saves on name blur, and Escape returns to its chooser', async () => {
  const f = await fixture(`summaries: {new summary: values.length}\n${summaryBase}`);
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.scorevalueid"]')!.click(); await until(() => !!f.dom.window.document.querySelector('.zorid-bases-summary-add'));
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('.zorid-bases-summary-add')].find(button => button.textContent === 'Add summary')!.click();
    await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const configured = BaseDocument.parse(await f.vault.read('Work.base'));
    assert.deepEqual(configured.views[0].summaries, { 'note.scorevalueid': 'new summary 2' });
    assert.deepEqual(summaryDefinitions(configured), { 'new summary': 'values.length' }, 'untouched new draft does not invent a scoped expression');
    const name = f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Summary name"]')!;
    assert.equal(name.value, 'new summary 2'); name.value = 'Discarded'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(name, 'Escape'); await tick();
    assert.equal(name.value, 'new summary 2'); assert.equal(f.dom.window.document.querySelector('[aria-label="Summary name"]'), name);
    const expression = f.dom.window.document.querySelector('[aria-label="Summary expression"]')!;
    const consumedEscape = new f.dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}); consumedEscape.preventDefault(); expression.dispatchEvent(consumedEscape);
    assert.equal(f.dom.window.document.querySelector('[aria-label="Summary expression"]'),expression,'completion-consumed Escape keeps its editor');
    f.key(expression, 'Escape');
    await until(() => !!f.dom.window.document.querySelector('[aria-label="Summarize"]'));
    assert.deepEqual(summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))), { 'new summary': 'values.length' }); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('a summary draft rejects an intervening configuration change and can discard its retained edits', async () => {
  const f = await fixture();
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.scorevalueid"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const expression = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!; expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const external = BaseDocument.parse(await f.vault.read('Work.base')); external.updateRoot({ externalSetting: 'kept' }); await f.vault.modify('Work.base', external.toString()); await f.session.refresh();
    await until(() => !!f.dom.window.document.querySelector('.bases-summary-editor [role="alert"]')?.textContent);
    assert.match(f.dom.window.document.querySelector('.bases-summary-editor [role="alert"]')!.textContent!, /Base changed/); assert.equal(expression.value, 'values.length');
    assert.equal((summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))) as Record<string, string>).Sum, 'values.sum().round(2)');
    [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('.bases-summary-editor button')].find(button => button.textContent === 'Cancel changes')!.click(); await until(() => !f.dom.window.document.querySelector('[aria-label="Summary expression"]'));
    assert.equal(BaseDocument.parse(await f.vault.read('Work.base')).getRoot('externalSetting'), 'kept');
  } finally { await f.cleanup(); }
});


test('file title opening forwards its captured row identity and image acquisition preserves target namespaces', async () => {
  const f = await fixture();
  try {
    const title = f.host.querySelector<HTMLElement>('[data-property="file.name"][role="gridcell"] a')!; assert.ok(title); title.click();
    assert.deepEqual(f.opened, [{path:'One.md',witness:{entryId:'One.md',revision:'r1'}}]);
    const image = {type:'namespace',name:'image',presentation:{kind:'image',value:'Cover.png',target:{entryId:'cover',revision:'r4'}},get(){return {type:'null'};}} as BaseExpressionValue;
    assert.equal(baseImageSourceValue({type:'list',value:[{type:'string',value:'Other.png'},image]},'Cover.png'),image);
    assert.deepEqual(baseImageSourceValue(image,'Different.png'),{type:'string',value:'Different.png'});
  } finally {await f.cleanup();}
});


test('terminal live summary saves retain editable input and ordinary Save settles the exact accepted draft', async () => {
  const f = await fixture();
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.scorevalueid"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(() => !!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    const before = await f.vault.read('Work.base'); f.adapter.fail = true;
    const expression = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Summary expression"]')!; expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await until(() => !!f.dom.window.document.querySelector('.bases-summary-editor [role="alert"]')?.textContent);
    assert.equal(await f.vault.read('Work.base'), before); assert.equal(expression.closest('fieldset')!.disabled, false); assert.equal(expression.disabled, false); assert.equal(expression.value, 'values.length'); assert.equal(f.session.hasPendingChanges(), true);
    const accepted=BaseDocument.parse(before);accepted.editViewSummary(0,'Sum','Sum','values.length');const desired=accepted.toString(),attempts=f.adapter.attempts;f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();await tick();assert.equal(f.adapter.attempts,attempts,'Back cannot dispatch a persistence retry');assert.equal(f.dom.window.document.querySelector('.bases-configuration-review'),null);assert.equal(await f.vault.read('Work.base'),before);f.adapter.fail=false;await f.session.flush();
    await until(async () => (BaseDocument.parse(await f.vault.read('Work.base')).views[0].summaryDefinitions as Record<string,string>).Sum === 'values.length'); await until(() => !f.session.hasPendingChanges());
    assert.equal(expression.closest('fieldset')!.disabled, false); assert.equal(expression.disabled, false); assert.equal(expression.value, 'values.length'); assert.equal(f.adapter.revisions.get('Work.base'), 3, 'one builtin seed and one accepted summary write');
  } finally { await f.cleanup(); }
});


test('returning from a vanished group summary never silently switches to the overall chooser', async () => {
  const f=await fixture(summaryBase.replace('    summaries: {score: Sum}','    groupBy: {property: score, direction: ASC}\n    summaries: {score: Sum}'));
  try {
    f.host.querySelector<HTMLButtonElement>('[data-summary-property="note.scorevalueid"][data-summary-group="0"]')!.click(); await until(()=>!!f.dom.window.document.querySelector('[aria-label="Edit Sum"]'));
    f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click(); await until(()=>!!f.dom.window.document.querySelector('[aria-label="Summary name"]'));
    await f.dropGroups(); await f.session.refresh(); f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click(); await tick();
    assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]'),null); assert.match(String(f.errors.at(-1)),/result group changed/);
  } finally {await f.cleanup();}
});


for (const origin of ['header', 'footer']) test(`${origin}-created summary returns to a usable chooser across an already queued ordinary table paint`, async () => {
  const f = await fixture(origin === 'header' ? 'views:\n  - type: table\n    name: Table\n    order: [file.name, score, projects]\n' : summaryBase, false, true);
  try {
    const doc = f.dom.window.document;
    assert.equal(f.host.querySelector<HTMLElement>('.zorid-bases-table-footer')!.hidden, origin === 'header');
    const originalAnchor = f.host.querySelector<HTMLElement>(origin === 'header' ? '[role="columnheader"][data-property="note.scorevalueid"]' : '[data-summary-property="note.scorevalueid"]')!;
    if (origin === 'header') {
      originalAnchor.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      [...doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Summarize...')!.click();
    } else originalAnchor.click();
    await until(() => !!doc.querySelector('.zorid-bases-summary-add'));
    const search = doc.querySelector<HTMLInputElement>('[aria-label="Find or create summary"]')!;
    search.value = 'C1 lifecycle'; search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    [...doc.querySelectorAll<HTMLButtonElement>('.zorid-bases-summary-add')].find(button => button.textContent === 'Add summary: C1 lifecycle')!.click();
    await until(() => !!doc.querySelector('[aria-label="Summary expression"]'));
    const expression = doc.querySelector<HTMLTextAreaElement>('textarea[aria-label="Summary expression"]')!;
    expression.focus(); expression.value = 'values.length'; expression.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.key(expression, 'Tab');
    await until(async () => (summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))) as Record<string, string>)['C1 lifecycle'] === 'values.length' && !f.session.hasPendingChanges());
    assert.equal(originalAnchor.isConnected, false, 'The original picker anchor has been replaced by accepted configuration');
    const beforeBack = await f.vault.read('Work.base');
    f.host.querySelector('.zorid-bases-table')!.dispatchEvent(new f.dom.window.Event('scroll'));
    assert.ok(f.pendingPaint() > 0, 'Ordinary table scroll queues its existing paint callback');
    doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();
    await until(() => !doc.querySelector('.bases-summary-editor') && !!doc.querySelector('[aria-label="Summarize"]'));
    await f.paint();
    assert.ok(doc.querySelector('[aria-label="Summarize"]'), 'Returning from the editor survives the already queued table paint');
    assert.equal(await f.vault.read('Work.base'), beforeBack, 'Back and paint do not write configuration');
    await until(() => !!doc.querySelector('[data-summary-id="Sum"]'));
    doc.querySelector<HTMLElement>('[data-summary-id="Sum"]')!.click();
    await until(async () => (BaseDocument.parse(await f.vault.read('Work.base')).views[0].summaries as Record<string, string>)['note.scorevalueid'] === 'Sum');
    assert.equal((summaryDefinitions(BaseDocument.parse(await f.vault.read('Work.base'))) as Record<string, string>)['C1 lifecycle'], 'values.length', 'The returned chooser remains actionable and preserves the custom definition');
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});


test('a summary editor from another mounted view cannot reopen a chooser in its replacement table', async () => {
  const f = await fixture(summaryBase.replace('type: cards', 'type: table'), false, true);
  try {
    const doc = f.dom.window.document;
    f.host.querySelector<HTMLElement>('[data-summary-property="note.scorevalueid"]')!.click();
    await until(() => !!doc.querySelector('[aria-label="Edit Sum"]'));
    doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();
    await until(() => !!doc.querySelector('[aria-label="Summary name"]') && !f.session.hasPendingChanges());
    const before = await f.vault.read('Work.base');
    await f.session.selectView(1);
    assert.equal(f.session.state.result?.view.name, 'Cards');
    doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();
    await tick(); await f.paint();
    assert.equal(doc.querySelector('.bases-summary-editor'), null);
    assert.equal(doc.querySelector('[aria-label="Summarize"]'), null, 'A replaced table owner cannot adopt an old editor anchor');
    assert.equal(await f.vault.read('Work.base'), before);
    f.host.querySelector<HTMLElement>('[data-summary-property="note.scorevalueid"]')!.click();
    await until(() => !!doc.querySelector('[aria-label="Summarize"]'));
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});


test('a disconnected table owner cannot reopen its summary editor chooser portal', async () => {
  const f = await fixture();
  try {
    const doc = f.dom.window.document;
    f.host.querySelector<HTMLElement>('[data-summary-property="note.scorevalueid"]')!.click();
    await until(() => !!doc.querySelector('[aria-label="Edit Sum"]'));
    doc.querySelector<HTMLButtonElement>('[aria-label="Edit Sum"]')!.click();
    await until(() => !!doc.querySelector('[aria-label="Summary name"]') && !f.session.hasPendingChanges());
    const before = await f.vault.read('Work.base');
    f.host.remove();
    doc.querySelector<HTMLButtonElement>('[aria-label="Back to summaries"]')!.click();
    await tick();
    assert.equal(doc.querySelector('[aria-label="Summarize"]'), null, 'Detached owners cannot leave an inert body-level picker');
    assert.equal(await f.vault.read('Work.base'), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('sequential keyboard cell edits retain focus through queued table paints and schema refresh',async()=>{
  const f=await fixture(undefined,false,true);
  try{
    for(const value of [11,12,13,14,15]){
      const cell=f.host.querySelector<HTMLElement>(`[data-property="${scoreKey}"][role="gridcell"]`)!;
      if(value===11)cell.focus();else assert.equal(f.dom.window.document.activeElement,cell,'the next keyboard edit starts from the retained cell');
      f.key(cell,'Enter');const input=cell.querySelector<HTMLInputElement>('input')!;assert.ok(input);input.value=String(value);
      f.host.querySelector('.zorid-bases-table')!.dispatchEvent(new f.dom.window.Event('scroll'));
      f.key(input,'Enter');await f.session.flush();await tick();
      await f.paint();await f.paint();
      const current=f.host.querySelector<HTMLElement>(`[data-property="${scoreKey}"][role="gridcell"]`)!;
      assert.equal(f.member.values[scoreId],value);assert.equal(current.textContent,String(value));assert.equal(current.hasAttribute('data-base-editing'),false);
      assert.equal(f.dom.window.document.activeElement,current,`acknowledged ${value} must retain its keyboard cell after two paints`);
      const before=f.requests.filter(request=>request.op==='get').length;
      await f.vault.create(`Outside${value}.md`,'external refresh');
      await until(()=>f.requests.filter(request=>request.op==='get').length>before&&!f.session.state.updating&&!f.session.hasPendingChanges()&&f.host.querySelector(`[data-property="${scoreKey}"][role="gridcell"]`)?.getAttribute('aria-disabled')==='false');
      await f.paint();await f.paint();
      assert.equal(f.dom.window.document.activeElement,f.host.querySelector(`[data-property="${scoreKey}"][role="gridcell"]`),`later schema/query refresh after ${value} must preserve keyboard focus`);
    }
    assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}
});
