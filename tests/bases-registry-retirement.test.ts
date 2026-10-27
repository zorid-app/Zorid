import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import { queryPropertyTargets } from '../src/bases/property-targets.ts';
import { SharedBaseQueryRunner } from '../src/bases/shared-query.ts';
import type { DocumentService } from '../src/core/document-semantics.ts';

const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{schema:1,extraction:'md1',resolver:'r1',query:'q1'}};
const source={localStoreId:'store',watermark:'1'};
const note={path:'Note.md',type:'file' as const,entryId:'note',revision:'r1'};
const base={path:'Notes.base',type:'file' as const,entryId:'base',revision:'r1'};
const entry=(file:typeof note)=>({id:file.entryId,revision:file.revision,path:file.path,kind:'file' as const,deleted:false});
const report=<T>(value:T)=>({snapshot,source,coverageComplete:true,value});
function fixture(){
  const calls:any[]=[],read:string[]=[];let closed=0;
  const unused=async():Promise<never>=>{throw new Error('Unexpected operation');};
  const service={status:async()=>({snapshot,source,coveredSource:source,current:true,rebuildRequired:false,coverageComplete:true}),propertyTargetsAvailable:true,
    initialize:unused,rebuild:unused,begin:unused,pump:unused,publish:unused,discard:unused,
    open:async()=>({pinId:'pin',snapshot,source,coverageComplete:true,close:async()=>{closed++;},search:unused,backlinks:unused,
      metadata:async(id:string)=>report({entry:entry(id==='base'?base:note),metadata:null,exclusion:null}),
      propertyTargets:async(input:unknown)=>{calls.push(input);return report({definition:null,relationTargets:{},propertyDefinitionDiagnostics:[]});},
      base:async(input:unknown)=>{calls.push(input);return report({definition:entry(base),result:{snapshotId:snapshot,view:{type:'list',name:'Notes'},rows:[],groups:[],groupOptions:[],properties:['file.name'],availableProperties:['file.name'],counts:{scanned:3,matched:0,afterGroupOrder:0,afterSearch:0,returned:0},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:[],stepsUsed:1}});},
    }),
  } as unknown as DocumentService;
  class IdentityAdapter extends MemoryAdapter { override async list(){return (await super.list()).map(file=>({...file,...(file.path===note.path?note:file.path===base.path?base:{})}));} }
  const adapter=new IdentityAdapter({'Note.md':'body','Notes.base':'views: [{type: list, name: Notes}]','Properties.yaml':'properties: [not a valid registry]'});
  Object.defineProperty(adapter,'documentSemantics',{value:service});
  const vault=new Vault(adapter);
  const readFile=async(path:string)=>{read.push(path);throw new Error('The retired registry must not be read');};
  return {service,vault,readFile,calls,read,closed:()=>closed};
}
test('retired registry does not trigger a note-property source read or attach global definitions',async()=>{
  const f=fixture();await f.vault.initialize();
  const actual=await queryPropertyTargets({service:f.service,vault:f.vault,current:note,isCurrent:()=>true,readFile:f.readFile,clock:{capture:()=>({clockMs:0,timezone:'UTC'}),scheduleAt:()=>()=>{},subscribeWake:()=>()=>{},isVisible:()=>true}});
  assert.equal(actual.settings,null);assert.deepEqual(actual.relationTargets,{});assert.deepEqual(f.read,[]);
  assert.equal(f.calls[0].options.propertyDefinitionsSource,undefined);assert.equal(f.closed(),1);
});
test('retired registry does not trigger a Base source read or grant definitions even without file identity',async()=>{
  const f=fixture(),runner=new SharedBaseQueryRunner();
  try {
    const result=await runner.query({service:f.service,definition:base,current:null,entries:[note,base,{path:'Properties.yaml',type:'file'}],readFile:f.readFile,query:{now:()=>new Date(0),timezone:'UTC'},viewIndex:0,version:1,isCurrent:()=>true});
    assert.equal(result.rows.length,0);assert.deepEqual(f.read,[]);assert.equal(f.calls[0].options.propertyDefinitionsSource,undefined);assert.equal(f.closed(),1);
  } finally {runner.dispose();}
});
