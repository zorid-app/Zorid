import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { AttachmentImporter } from '../src/core/attachment-import.ts';
import { transferFiles } from '../src/editor/transfers.ts';
import type { BinaryStreams, BinaryStageRequest, BinaryStageRef } from '../src/core/binary-streams.ts';
import type { VaultAdapter, VaultEntry } from '../src/core/types.ts';

// A metadata-only backend fake consumes and discards one chunk at a time. It
// establishes importer call-site behavior, not storage/transport durability.
async function fixture() {
  const memory=new MemoryAdapter({'Before/Active.md':'','After/Active.md':'','Receiving/Owner.md':''});
  const published=new Map<string,VaultEntry>(),calls:string[]=[],chunks:number[]=[];
  let original:BinaryStageRequest|undefined,total=0;
  const ref:BinaryStageRef={localStoreId:'store',clientId:'client',operationId:'',stageId:'stage'};
  const streams:BinaryStreams={limits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'1048576'},
    async begin(input){calls.push('begin');original=structuredClone(input);return {...ref,operationId:input.operationId};},
    async append(_ref,input){calls.push('append');assert.equal(input.offset,String(total));assert.equal(input.sequence,chunks.length);assert.ok(input.bytes.length<=131072);chunks.push(input.bytes.length);total+=input.bytes.length;return {sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:'a'.repeat(64),acceptedLength:String(total)};},
    async seal(_ref,input){calls.push('seal');assert.equal(input.finalLength,String(total));return {length:String(total),sha256:'b'.repeat(64)};},
    async commit(){calls.push('commit');assert.equal(original!.target.kind,'create');if(original!.target.kind!=='create')throw new Error('explicit create required');published.set(original!.target.path,{path:original!.target.path,type:'file',entryId:original!.target.entryId,revision:'committed',mtime:1,size:total});return 'original-receipt';},
    async abort(){calls.push('abort');},async query(){throw new Error('unused');},async openRead(){throw new Error('unused');},async read(){throw new Error('unused');},async closeRead(){throw new Error('unused');},
  };
  const adapter:VaultAdapter={binaryStreams:streams,
    async list(){return [...await memory.list(),...published.values()];},async stat(path){return published.get(path)??memory.stat(path);},
    read:path=>memory.read(path),write:(path,text)=>memory.write(path,text),mkdir:path=>memory.mkdir(path),rename:(from,to)=>memory.rename(from,to),trash:path=>memory.trash(path),
    async readBinary(){throw new Error('whole-file read forbidden');},async writeBinary(){throw new Error('legacy whole-file write forbidden');},async createBinary(){throw new Error('legacy create forbidden');},
  };
  const vault=new Vault(adapter);await vault.initialize();return {vault,adapter,memory,calls,chunks,published,importer:new AttachmentImporter(vault),total:()=>total};
}
function fileHandle(length:number,readSlice:(index:number)=>Promise<void>=async()=>{}) {
  const slices:{start:number;end:number}[]=[];let whole=0;
  const file={name:'asset.bin',type:'application/octet-stream',size:length,
    async arrayBuffer(){whole++;throw new Error('whole File.arrayBuffer forbidden');},
    slice(start:number,end:number){const index=slices.length;slices.push({start,end});return {async arrayBuffer(){await readSlice(index);return new Uint8Array(end-start).fill(index%251).buffer;}};},
  } as unknown as File;
  const files=[file],items=[{kind:'file',getAsFile:()=>file}],captured=transferFiles({files,items} as unknown as DataTransfer)[0];
  files.length=0;items.length=0; // Native event transfer store is no longer available.
  return {captured,slices,whole:()=>whole};
}
function gate(){let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});return {started,release,async pause(){entered();await wait;}};}

test('captured >16MiB File streams bounded slices and samples destination after its first bytes',async()=>{
  const f=await fixture(),first=gate(),size=20*1024*1024+17,file=fileHandle(size,async index=>{if(index===0)await first.pause();});
  let active='Before/Active.md',samples=0;
  const work=f.importer.import(file.captured,'Receiving/Owner.md',()=>{samples++;return active;},{attachmentFolderPath:'./Images',newLinkFormat:'relative'});
  await first.started;assert.equal(samples,0);assert.equal(f.calls.length,0);assert.equal(file.whole(),0);active='After/Active.md';first.release();
  assert.deepEqual(await work,{path:'After/Images/asset.bin',embed:'![[../After/Images/asset.bin]]'});
  assert.equal(f.total(),size);assert.equal(file.whole(),0);assert.equal(f.published.get('After/Images/asset.bin')!.size,size);
  assert.ok(file.slices.every(slice=>slice.end-slice.start<=131072));assert.equal(file.slices[0].start,0);assert.equal(file.slices.at(-1)!.end,size);assert.equal(f.chunks.length,Math.ceil(size/131072));assert.equal(f.calls.filter(value=>value==='commit').length,1);
});
test('generation cancellation after first pull creates no folders or stage, and later pull cancellation retains an inert stage',async()=>{
  for(const when of ['first','later']as const){const f=await fixture(),waiting=gate();let current=true;
    const file=fileHandle(3*131072,async index=>{if(index===(when==='first'?0:1))await waiting.pause();});
    const work=f.importer.import(file.captured,'Receiving/Owner.md',()=>{if(!current)throw new Error('The destination vault is no longer open.');return 'After/Active.md';},{attachmentFolderPath:'./Images'});
    await waiting.started;current=false;waiting.release();await assert.rejects(work,error=>{assert.match(String(error),/no longer open/);if(when==='later')assert.equal((error as any).binaryStage.stageId,'stage');return true;});
    assert.equal(file.whole(),0);assert.equal(f.calls.includes('commit'),false);assert.equal(f.calls.includes('abort'),false);assert.equal(f.published.size,0);
    if(when==='first'){assert.equal(f.calls.length,0);assert.equal(await f.memory.stat('After/Images'),null);}else{assert.deepEqual(f.calls,['begin','append']);assert.equal(file.slices.length,2);}
  }
});
test('invalid configured folder rejects before invoking a source factory or legacy read',async()=>{
  const f=await fixture();let opened=0,read=0;
  await assert.rejects(f.importer.import({name:'asset.bin',source(){opened++;throw new Error('must not open');},async read(){read++;throw new Error('must not read');}},'',null,{attachmentFolderPath:'../escape'}),/escape/);
  assert.equal(opened,0);assert.equal(read,0);assert.equal(f.calls.length,0);
});
test('cancellation at successful publication retains the committed attachment witness',async()=>{
  const f=await fixture(),file=fileHandle(3);let current=true;
  f.vault.on('create',change=>{if(change.path==='After/Images/asset.bin')current=false;});
  await assert.rejects(f.importer.import(file.captured,'Receiving/Owner.md',()=>{if(!current)throw Object.assign(new Error('The destination vault is no longer open.'),{code:'destination_closed'});return 'After/Active.md';},{attachmentFolderPath:'./Images'}),error=>{
    assert.equal((error as any).code,'destination_closed');const witness=(error as any).committedAttachment;assert.equal(witness.path,'After/Images/asset.bin');assert.equal(witness.revision,'committed');assert.equal(witness.entryId,f.published.get(witness.path)!.entryId);assert.equal(Object.isFrozen(witness),true);return true;
  });
  assert.equal(f.published.get('After/Images/asset.bin')!.size,3);assert.equal(f.calls.filter(value=>value==='commit').length,1);assert.equal(f.calls.includes('abort'),false);assert.equal(file.whole(),0);
});
