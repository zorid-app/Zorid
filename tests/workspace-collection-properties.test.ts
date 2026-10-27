import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/ui/workspace.ts';
import type {DatabaseCollection,DatabaseEntry,DatabaseRequest} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Work',revision:'schema-r1',deleted:false,properties:[{id:'mnopqrstuvwx',name:'Status',datatype:'status',options:[{id:'111111111111',name:'Started',category:'working'},{id:'222222222222',name:'Done',category:'done'},{id:'333333333333',name:'Paused',category:'working'}]}]};
const source=(status:string)=>`---\n_id: entry-1\n_type: Work\nStatus: ${status}\n---\nBody`;
function fixture(authoritative:string){
  const requests:DatabaseRequest[]=[],sequence:string[]=[];let member:DatabaseEntry={entryId:'entry-1',collectionId:collection.id,revision:'entry-r2',fileRevision:'file-r2',path:'Note.md',values:{mnopqrstuvwx:authoritative},deleted:false,pendingProjection:false};
  const vault={adapter:{databases:{async request(command:DatabaseRequest){sequence.push('set');requests.push(command);member={...member,revision:'entry-r3',values:{mnopqrstuvwx:'333333333333'}};buffer.text+='\nLater body';return{collections:[collection],entries:[member],projection:{pending:0,issues:[]}};}}}};
  const owner={vault,vaultGeneration:0,collectionPropertyRequests:new WeakMap()},buffer={text:source('Started'),async flush(){sequence.push('flush');},async refreshManagedProjection(){sequence.push('refresh');buffer.text=buffer.text.replace('Status: Started','Status: Paused');}},targets={async prepareCollection(){return{collection,entry:member};}};
  const change=(Workspace.prototype as unknown as {changeManagedNoteProperties:Function}).changeManagedNoteProperties;
  return{requests,sequence,buffer,change:()=>change.call(owner,buffer,source('Paused'),targets,()=>{}) as Promise<boolean>};
}
test('a stale visible managed value cannot acquire the latest revision and overwrite another view',async()=>{
  const f=fixture('222222222222');await assert.rejects(f.change(),/saved Status value changed/);assert.equal(f.requests.length,0);assert.deepEqual(f.sequence,[]);assert.equal(f.buffer.text,source('Started'));
});
test('managed note value edit flushes body then sends option identities and refreshes without replacing later typing',async()=>{
  const f=fixture('111111111111');assert.equal(await f.change(),true);assert.deepEqual(f.sequence,['flush','set','refresh']);assert.equal(f.requests[0].op,'set_entry');if(f.requests[0].op==='set_entry')assert.deepEqual(f.requests[0].values,{mnopqrstuvwx:'333333333333'});assert.ok(f.buffer.text.endsWith('Later body'));assert.match(f.buffer.text,/Status: Paused/);
});
