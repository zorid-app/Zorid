import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountSourceChooser,mountCollectionEditor,collectionPropertyDefinitions} from '../src/databases/collection-ui.ts';
import {renderProperties} from '../src/ui/properties.ts';
import type {DatabaseCollection,DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';

const collection:DatabaseCollection={id:'abcdefghijkl',name:'Work tasks',revision:'schema-r1',deleted:false,properties:[{id:'mnopqrstuvwx',name:'Status',datatype:'status',options:[{id:'123456789abc',name:'Started',category:'working'}]}]};
const response=(collections:readonly DatabaseCollection[]=[]):DatabaseResponse=>({collections,entries:[],projection:{pending:0,issues:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate:()=>boolean){for(let index=0;index<50;index++){if(predicate())return;await tick();}assert.ok(predicate(),'condition did not settle');}
function fixture(){const dom=new JSDOM('<!doctype html><main></main>');return{dom,doc:dom.window.document,host:dom.window.document.querySelector('main')!};}
function click(host:Element,label:string){const button=[...host.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(button,`missing ${label}`);button.click();}

test('first view offers notes or a collection and does not create a global registry',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],selected:unknown[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return response();}},isCurrent:()=>true,choose:async source=>{selected.push(source);}});
  click(f.host,'Notes in your vaultBrowse note titles, previews and file information.');await tick();
  assert.deepEqual(selected,[{kind:'untyped'}]);assert.deepEqual(requests,[]);chooser.destroy();f.dom.window.close();
});

test('collection creation retries the identical operation after uncertainty and retains its form',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[],selected:unknown[]=[];let failed=false;
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);if(command.op==='create'){if(!failed){failed=true;throw new Error('Reply lost');}return response([collection]);}return response();}},isCurrent:()=>true,choose:async source=>{selected.push(source);}});
  click(f.host,'A collection of thingsOrganize entries with your own properties.');await tick();click(f.host,'Create a collection');
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='Work tasks';click(f.host,'Create collection');await until(()=>f.host.querySelector('[role="alert"]')?.textContent==='Reply lost');
  assert.equal(name.value,'Work tasks');click(f.host,'Create collection');await until(()=>selected.length===1);
  const creates=requests.filter(request=>request.op==='create');assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);assert.deepEqual(selected,[{kind:'collection',id:collection.id}]);chooser.destroy();f.dom.window.close();
});

test('source save failure retains the selected collection and creation identity',async()=>{
  const f=fixture();let saves=0;const requests:DatabaseRequest[]=[];
  const chooser=mountSourceChooser(f.host,{service:{async request(command){requests.push(command);return command.op==='list'?response([collection]):response([collection]);}},isCurrent:()=>true,choose:async()=>{saves++;throw new Error('Base save failed');}});
  click(f.host,'A collection of thingsOrganize entries with your own properties.');await until(()=>!![...f.host.querySelectorAll('button')].find(button=>button.textContent==='Work tasks'));
  click(f.host,'Work tasks');await until(()=>saves===1);await tick();assert.equal(chooser.element.isConnected,true);assert.equal(f.host.querySelector('[role="alert"]')?.textContent,'Base save failed');chooser.destroy();f.dom.window.close();
});

test('schema edits preserve stable identities and failed Apply retains draft and exact operation',async()=>{
  const f=fixture(),requests:DatabaseRequest[]=[];let fail=true,closed=false;
  const editor=mountCollectionEditor(f.host,{service:{async request(command){requests.push(command);if(fail){fail=false;throw new Error('Try again');}return response([{...collection,name:'Progress tasks'}]);}},collection,entries:[],isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{closed=true;}});
  const name=f.host.querySelector<HTMLInputElement>('[aria-label="Collection name"]')!;name.value='Progress tasks';name.dispatchEvent(new f.dom.window.Event('input'));
  const field=f.host.querySelector<HTMLInputElement>('[aria-label="Status name"]')!;field.value='Progress';field.dispatchEvent(new f.dom.window.Event('input'));
  click(f.host,'Apply');await until(()=>f.host.querySelector('[role="alert"]')?.textContent==='Try again');assert.equal(field.value,'Progress');assert.equal(closed,false);
  click(f.host,'Apply');await until(()=>closed);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].op,'update');if(requests[0].op==='update'){assert.equal(requests[0].properties[0].id,collection.properties[0].id);assert.equal(requests[0].properties[0].options?.[0].id,collection.properties[0].options[0].id);}editor.destroy();f.dom.window.close();
});

test('collection property controls use option identities and scoped display labels',()=>{
  const definitions=collectionPropertyDefinitions(collection);assert.deepEqual(definitions[collection.properties[0].id],{type:'status',options:[{id:'123456789abc',value:'123456789abc',label:'Started',category:'in-progress'}]});
});

test('ordinary note properties ignore Properties.yaml entirely',async()=>{
  const f=fixture();let reads=0;const source='---\nscore: 3\n---\nBody';
  const vault={entries:new Map([['Properties.yaml',{path:'Properties.yaml',type:'file'}]]),read:async()=>{reads++;throw new Error('must not read');},on:()=>()=>{}};
  const view=renderProperties(f.host,{vault:vault as never,getSource:()=>source,onChange:()=>{throw new Error('no write');}});await tick();
  assert.equal(reads,0);assert.equal(f.host.querySelector('[data-property-key="score"] [aria-label="score type"]')?.getAttribute('aria-label'),'score type');view.destroy();f.dom.window.close();
});

test('managed note identities are hidden and schema fields cannot be renamed or removed as YAML',()=>{
  const f=fixture(),source='---\n_id: entry-1\n_type: Work tasks\nStatus: Started\n---\nBody';
  const view=renderProperties(f.host,{getSource:()=>source,onChange:()=>{throw new Error('no write');},isManaged:()=>true,collectionName:()=>collection.name,getDefinitions:()=>({Status:{type:'status',options:[{value:'Started',label:'Started',category:'in-progress'}]}})});
  assert.equal(f.host.querySelector<HTMLElement>('[data-property-key="_id"]')?.hidden,true);assert.equal(f.host.querySelector<HTMLInputElement>('[aria-label="Status name"]')?.readOnly,true);assert.equal(f.host.querySelector<HTMLButtonElement>('[aria-label="Remove Status"]')?.hidden,true);assert.equal(f.host.querySelector('.metadata-properties-heading')?.textContent,'Work tasks properties');view.destroy();f.dom.window.close();
});

test('Duplicate retries its captured new identity and path after pending publication',async()=>{
  const {mountCollectionBrowser}=await import('../src/databases/collection-ui.ts');
  const f=fixture(),entry={entryId:'entry-1',collectionId:collection.id,revision:'entry-r1',fileRevision:'file-r1',path:'Original.md',values:{},deleted:false,pendingProjection:false};
  const requests:DatabaseRequest[]=[];let failed=false,pathCalls=0;
  const browser=mountCollectionBrowser(f.host,{service:{async request(command){requests.push(command);if(command.op==='duplicate_entry'&&!failed){failed=true;return{...response([collection]),entries:[entry],projection:{pending:1,issues:[]}};}return{...response([collection]),entries:[entry]};}},isCurrent:()=>true,open:async()=>{},openEntry:async()=>{},duplicatePath:()=>{pathCalls++;return`Copy ${pathCalls}.md`;},onMutation:async()=>{}});
  await until(()=>!![...f.host.querySelectorAll('button')].find(button=>button.textContent==='Work tasks'));click(f.host,'Work tasks');await until(()=>!![...f.host.querySelectorAll('button')].find(button=>button.textContent==='Duplicate'));
  click(f.host,'Duplicate');await until(()=>!f.host.querySelector<HTMLButtonElement>('button')?.disabled&&requests.some(request=>request.op==='duplicate_entry'));
  await tick();click(f.host,'Duplicate');await until(()=>requests.filter(request=>request.op==='duplicate_entry').length===2);
  const duplicates=requests.filter(request=>request.op==='duplicate_entry');assert.deepEqual(duplicates[0],duplicates[1]);assert.equal(pathCalls,1);browser.destroy();f.dom.window.close();
});

test('deleting a default option clears its default while retaining stable option identities',async()=>{
  const f=fixture();let request:DatabaseRequest|undefined;
  const withDefault={...collection,properties:[{...collection.properties[0],default:'123456789abc',options:[...collection.properties[0].options,{id:'abcdefghijkl',name:'Done',category:'done' as const}]}]};
  const editor=mountCollectionEditor(f.host,{service:{async request(command){request=command;return response([withDefault]);}},collection:withDefault,entries:[],isCurrent:()=>true,onSaved:async()=>{},onClose:()=>{}});
  click(f.host,'Remove option');click(f.host,'Remove');click(f.host,'Apply');await until(()=>!!request);
  assert.equal(request!.op,'update');if(request!.op==='update'){assert.equal(request!.properties[0].default,undefined);assert.equal(request!.properties[0].options?.[0].id,'abcdefghijkl');assert.equal(request!.confirmDestructive,true);}editor.destroy();f.dom.window.close();
});

test('collection creation hints drop incompatible values and retain feasible schema values',async()=>{
  const {collectionInitialValues}=await import('../src/databases/collection-ui.ts');
  const schema:DatabaseCollection={...collection,properties:[...collection.properties,{id:'texttexttext',name:'Title',datatype:'text',options:[]},{id:'datedatedate',name:'Due',datatype:'date',options:[]},{id:'checkchecked',name:'Ready',datatype:'checkbox',options:[]}]};
  assert.deepEqual(collectionInitialValues(schema,{texttexttext:5,datedatedate:'2026-02-30',checkchecked:'true',mnopqrstuvwx:'123456789abc'}),{mnopqrstuvwx:'123456789abc'});
  assert.deepEqual(collectionInitialValues(schema,{texttexttext:'Book',datedatedate:'2026-10-30',checkchecked:true}),{texttexttext:'Book',datedatedate:'2026-10-30',checkchecked:true});
});

test('creation hints distinguish hidden field identities from readable template names',async()=>{
  const {collectionInitialValues}=await import('../src/databases/collection-ui.ts');
  const schema:DatabaseCollection={...collection,properties:[{id:'aaaaaaaaaaaa',name:'bbbbbbbbbbbb',datatype:'text',options:[]},{id:'bbbbbbbbbbbb',name:'Amount',datatype:'number',options:[]}]};
  assert.deepEqual(collectionInitialValues(schema,{bbbbbbbbbbbb:5}),{bbbbbbbbbbbb:5});
  assert.deepEqual(collectionInitialValues(schema,{bbbbbbbbbbbb:'Readable template value'},'names'),{aaaaaaaaaaaa:'Readable template value'});
  assert.deepEqual(collectionInitialValues(schema,{aaaaaaaaaaaa:'Unknown template metadata'},'names'),{});
});
