import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/ui/workspace.ts';
import {JSDOM} from 'jsdom';
import {renderProperties} from '../src/ui/properties.ts';
import type {DatabaseCollection,DatabaseEntry,DatabaseRequest} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Work',revision:'schema-r1',deleted:false,properties:[{id:'mnopqrstuvwx',name:'Status',datatype:'status',options:[{id:'111111111111',name:'Started',category:'working'},{id:'222222222222',name:'Done',category:'done'},{id:'333333333333',name:'Paused',category:'working'}]}]};
const source=(status:string)=>`---\n_id: entry-1\n_type: Work\nStatus: ${status}\n---\nBody`;
function fixture(authoritative:string,selectedCollection:DatabaseCollection=collection,options:{failFinalRefresh?:boolean;failCanonicalRefresh?:boolean}={}){
  let preparations=0,invalidations=0;
  const requests:DatabaseRequest[]=[],sequence:string[]=[];let member:DatabaseEntry={entryId:'entry-1',collectionId:collection.id,revision:'entry-r2',fileRevision:'file-r2',path:'Note.md',values:{mnopqrstuvwx:authoritative},deleted:false,pendingProjection:false};
  const vault={adapter:{databases:{async request(command:DatabaseRequest){sequence.push('set');requests.push(command);member={...member,revision:'entry-r3',values:{mnopqrstuvwx:'333333333333'}};buffer.text+='\nLater body';return{collections:[selectedCollection],entries:[member],projection:{pending:0,issues:[]}};}}}};
  const owner={vault,vaultGeneration:0,collectionPropertyRequests:new WeakMap()},buffer={text:source('Started'),async flush(){sequence.push('flush');},async refreshManagedProjection(){sequence.push('refresh');if(options.failCanonicalRefresh)throw new Error('Canonical refresh failed');buffer.text=buffer.text.replace('Status: Started','Status: Paused');}},targets={async prepareCollection(){if(++preparations===2&&options.failFinalRefresh)throw new Error('Membership refresh temporarily unavailable');return{collection:selectedCollection,entry:member};},invalidate(){invalidations++;}};
  const change=(Workspace.prototype as unknown as {changeManagedNoteProperties:Function}).changeManagedNoteProperties;
  return{requests,sequence,buffer,get invalidations(){return invalidations;},change:()=>change.call(owner,buffer,source('Paused'),targets,()=>{}) as Promise<boolean>};
}
test('a stale visible managed value cannot acquire the latest revision and overwrite another view',async()=>{
  const f=fixture('222222222222');await assert.rejects(f.change(),/saved Status value changed/);assert.equal(f.requests.length,0);assert.deepEqual(f.sequence,[]);assert.equal(f.buffer.text,source('Started'));
});
test('managed note value edit flushes body then sends option identities and refreshes without replacing later typing',async()=>{
  const f=fixture('111111111111');assert.equal(await f.change(),true);assert.deepEqual(f.sequence,['flush','set','refresh']);assert.equal(f.requests[0].op,'set_entry');if(f.requests[0].op==='set_entry')assert.deepEqual(f.requests[0].values,{mnopqrstuvwx:'333333333333'});assert.ok(f.buffer.text.endsWith('Later body'));assert.match(f.buffer.text,/Status: Paused/);
});

test('a field rename cannot reinterpret an old managed frontmatter key as an ordinary edit',async()=>{
  const renamed={...collection,properties:[{...collection.properties[0],name:'Progress'}]},f=fixture('111111111111',renamed);
  await assert.rejects(f.change(),/schema changed/);assert.equal(f.requests.length,0);assert.equal(f.buffer.text,source('Started'));
});

test('an option rename fences a draft rendered under the earlier readable label',async()=>{
  const renamed={...collection,properties:[{...collection.properties[0],options:collection.properties[0].options.map(option=>option.name==='Started'?{...option,name:'Initiated'}:option)}]},f=fixture('111111111111',renamed);
  await assert.rejects(f.change(),/saved Status value changed/);assert.equal(f.requests.length,0);assert.equal(f.buffer.text,source('Started'));
});

function preservedNumberFixture(nextValue:number|null,options:{visible?:string;saved?:string;witness?:{entryId:string;path:string;revision:string}|null;pending?:boolean;receipt?:Partial<{content:string;currentSource:string;currentFileRevision:string;entryRevision:string;collectionRevision:string}>;changedBaselineDuringCompose?:boolean;loseSetReply?:boolean}={}){
  const schema:DatabaseCollection={...collection,revision:'schema-after-conversion',properties:[{id:'mnopqrstuvwx',name:'Status',datatype:'number',options:[]},{id:'abcdefghijkl',name:'Other',datatype:'number',options:[]}]};
  const readable=(status:string)=>`---\n_id: entry-1\n_type: Work\nStatus: ${status}\nOther: Retained other value\n---\nBody`;
  let member:DatabaseEntry={entryId:'entry-1',collectionId:collection.id,revision:'member-after-conversion',fileRevision:'file-after-conversion',path:'Note.md',values:{mnopqrstuvwx:'111111111111',abcdefghijkl:'old-other-option-id'},deleted:false,pendingProjection:options.pending??false,problems:{mnopqrstuvwx:'Value retained from the earlier datatype',abcdefghijkl:'Unrelated retained value'}};
  const requests:DatabaseRequest[]=[],sequence:string[]=[];let appliedOperation:string|undefined;
  const buffer={path:'Note.md',text:readable(options.visible??'Started')+'\nUnsaved body',savedText:readable(options.saved??'Started'),savedDurableWitness:options.witness===null?undefined:options.witness??{entryId:'entry-1',path:'Note.md',revision:'file-after-conversion'},async flush(){sequence.push('flush');buffer.savedText=buffer.text;if(buffer.savedDurableWitness)buffer.savedDurableWitness={...buffer.savedDurableWitness,revision:'body-save-file'};},async refreshManagedProjection(){sequence.push('refresh');buffer.text=buffer.text.replace(/^Status: .*$/m,`Status: ${nextValue===null?'null':nextValue}`);}};
  const vault={adapter:{databases:{async request(command:DatabaseRequest){requests.push(command);sequence.push(command.op);
    if(command.op==='compose'){
      if(options.changedBaselineDuringCompose)buffer.savedText+='\nA different saved baseline';
      return{collections:[],entries:[],projection:{pending:0,issues:[]},composition:{content:readable('Started'),currentSource:readable('Started'),currentFileRevision:'file-after-conversion',entryRevision:member.revision,collectionRevision:schema.revision,...options.receipt}};
    }
    assert.equal(command.op,'set_entry');if(command.op!=='set_entry')throw new Error('unexpected request');
    assert.deepEqual(command.values,{mnopqrstuvwx:nextValue});assert.equal(command.expectedRevision,'member-after-conversion');assert.equal(command.expectedCollectionRevision,'schema-after-conversion');
    if(!appliedOperation){appliedOperation=command.operationId;member={...member,revision:'member-corrected',values:{...member.values,...command.values},problems:{abcdefghijkl:'Unrelated retained value'},pendingProjection:false};buffer.text+='\nLater typing';if(options.loseSetReply)throw Object.assign(new Error('Setter acknowledgement lost'),{source:'host',commitUncertain:true});}
    else assert.equal(command.operationId,appliedOperation,'retry must retain the original operation identity');
    return{collections:[schema],entries:[member],projection:{pending:0,issues:[]}};
  }}}};
  const owner={vault,vaultGeneration:0,collectionPropertyRequests:new WeakMap()},targets={async prepareCollection(){return{collection:schema,entry:member};}};
  const change=(Workspace.prototype as unknown as {changeManagedNoteProperties:Function}).changeManagedNoteProperties;
  const next=buffer.text.replace(/^Status: .*$/m,`Status: ${nextValue===null?'null':nextValue}`);
  return{requests,sequence,buffer,member:()=>member,change:(proposed=next)=>change.call(owner,buffer,proposed,targets,()=>{}) as Promise<boolean>};
}

test('reopened retained Select/Status label can be corrected to Number using its canonical readable projection',async()=>{
  const f=preservedNumberFixture(5);assert.equal(await f.change(),true);
  assert.deepEqual(f.sequence,['compose','flush','set_entry','refresh']);const compose=f.requests[0];assert.equal(compose.op,'compose');if(compose.op==='compose'){assert.equal(compose.baseline,compose.proposed);assert.ok(!compose.baseline.includes('Unsaved body'));assert.equal(compose.expectedRevision,'file-after-conversion');}
  assert.equal(f.member().values.mnopqrstuvwx,5);assert.equal(f.member().problems?.mnopqrstuvwx,undefined);assert.equal(f.member().values.abcdefghijkl,'old-other-option-id');assert.ok(f.member().problems?.abcdefghijkl);assert.ok(f.buffer.text.endsWith('Unsaved body\nLater typing'));assert.match(f.buffer.text,/Status: 5/);
});

test('reopened retained option label can be explicitly cleared after an incompatible datatype change',async()=>{
  const f=preservedNumberFixture(null);assert.equal(await f.change(),true);assert.equal(f.member().values.mnopqrstuvwx,null);assert.equal(f.member().problems?.mnopqrstuvwx,undefined);assert.match(f.buffer.text,/Status: null/);assert.ok(f.buffer.text.endsWith('Unsaved body\nLater typing'));
});

test('a retained-value marker cannot authorize stale displayed values or mismatched saved file identity',async()=>{
  const cases=[{visible:'Done'},{saved:'Done'},{witness:null},{witness:{entryId:'another-entry',path:'Note.md',revision:'file-after-conversion'}},{witness:{entryId:'entry-1',path:'Other.md',revision:'file-after-conversion'}},{witness:{entryId:'entry-1',path:'Note.md',revision:'older-file'}},{pending:true}];
  for(const options of cases){const f=preservedNumberFixture(5,options);const before=f.buffer.text;await assert.rejects(f.change(),/saved .*changed|saved collection projection changed/);assert.ok(!f.requests.some(request=>request.op==='set_entry'));assert.equal(f.buffer.text,before);assert.ok(!f.sequence.includes('flush'));}
});

test('retained-value correction rejects mismatched canonical receipts and a changed saved baseline',async()=>{
  const cases=[{receipt:{entryRevision:'different-member'}},{receipt:{collectionRevision:'different-schema'}},{receipt:{currentFileRevision:'different-file'}},{receipt:{content:source('Done')}},{receipt:{content:source('Started').replace('_id: entry-1','_id: another-entry')}},{changedBaselineDuringCompose:true}];
  for(const options of cases){const f=preservedNumberFixture(5,options),before=f.buffer.text;await assert.rejects(f.change(),/projection changed|saved Status value changed|different identity/);assert.deepEqual(f.requests.map(request=>request.op),['compose']);assert.equal(f.buffer.text,before);assert.ok(!f.sequence.includes('flush'));}
});

test('rendered Number property retains the old option label and accepts correction or clear after reopen',async()=>{
  for(const value of [5,null]){
    const f=preservedNumberFixture(value),dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main')!;
    const properties=renderProperties(host,{path:'Note.md',getSource:()=>f.buffer.text,isManaged:()=>true,getDefinitions:()=>({Status:{type:'number'},Other:{type:'number'}}),onChange:async next=>{assert.equal(await f.change(next),true);}});
    const cell=host.querySelector<HTMLElement>('[data-property-key="Status"] .metadata-property-value')!;assert.ok(cell);cell.click();
    const input=cell.querySelector<HTMLInputElement>('input[aria-label="Status"]')!;assert.ok(input);assert.equal(input.value,'Started','the incompatible readable label stays available for correction');assert.equal(input.type,'text');
    input.value=value===null?'':String(value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await properties.flush();
    assert.equal(f.member().values.mnopqrstuvwx,value);assert.equal(f.member().problems?.mnopqrstuvwx,undefined);assert.deepEqual(f.requests.filter(request=>request.op==='set_entry').map(request=>request.values),[{mnopqrstuvwx:value}]);assert.ok(f.buffer.text.endsWith('Unsaved body\nLater typing'));properties.destroy();dom.window.close();
  }
});

test('uncertain retained-value setter retries its original operation without reinterpreting the cleared problem marker',async()=>{
  const f=preservedNumberFixture(5,{loseSetReply:true});await assert.rejects(f.change(),/acknowledgement lost/);assert.match(f.buffer.text,/Status: Started/);assert.equal(f.member().values.mnopqrstuvwx,5);assert.equal(f.member().problems?.mnopqrstuvwx,undefined);
  assert.equal(await f.change(),true);const setters=f.requests.filter(request=>request.op==='set_entry');assert.equal(setters.length,2);assert.deepEqual(setters[0],setters[1]);assert.equal(f.requests.filter(request=>request.op==='compose').length,1);assert.deepEqual(f.sequence,['compose','flush','set_entry','flush','set_entry','refresh']);assert.equal((f.buffer.text.match(/Later typing/g)??[]).length,1);assert.ok(f.buffer.text.endsWith('Unsaved body\nLater typing'));assert.match(f.buffer.text,/Status: 5/);
});


test('confirmed canonical collection save acknowledges success when only its final membership refresh fails',async()=>{
  const f=fixture('111111111111',collection,{failFinalRefresh:true});assert.equal(await f.change(),true);
  assert.deepEqual(f.sequence,['flush','set','refresh']);assert.equal(f.requests.length,1);assert.equal(f.requests[0].op,'set_entry');assert.equal(f.invalidations,1,'one normal refresh invalidation follows an ancillary read failure');assert.match(f.buffer.text,/Status: Paused/);assert.ok(f.buffer.text.endsWith('Later body'));
});


test('canonical buffer refresh failure remains a retained save error and never becomes ancillary success',async()=>{
  const f=fixture('111111111111',collection,{failCanonicalRefresh:true});await assert.rejects(f.change(),/Canonical refresh failed/);assert.deepEqual(f.sequence,['flush','set','refresh']);assert.equal(f.requests.length,1);assert.equal(f.invalidations,0);assert.match(f.buffer.text,/Status: Started/);assert.ok(f.buffer.text.endsWith('Later body'));
});
