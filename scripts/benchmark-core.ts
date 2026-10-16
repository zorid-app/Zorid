import { performance } from 'node:perf_hooks';
import { Vault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';

// A reproducible core-only workload. No filesystem, UI or reference-app claims.
class MeasuredAdapter extends MemoryAdapter {
  reads=0; stats=0; lists=0;
  override async read(path:string){this.reads++;return super.read(path);}
  override async stat(path:string){this.stats++;return super.stat(path);}
  override async list(){this.lists++;return super.list();}
  reset(){this.reads=0;this.stats=0;this.lists=0;}
}
const requested=process.argv.slice(2).map(Number);
const sizes=requested.length?requested:[1000,10000];
if(sizes.some(size=>!Number.isSafeInteger(size)||size<1||size>100000))throw new Error('Use note counts between 1 and 100000');
const rows=[];
for(const size of sizes){
  const seed:Record<string,string>={};
  for(let index=0;index<size;index++)seed[`Note ${index}.md`]=`---\ntags: [benchmark]\n---\n# Note ${index}\n\n[[Note ${(index+1)%size}]]\n\n${'Some note content. '.repeat(30)}`;
  const adapter=new MeasuredAdapter(seed),vault=new Vault(adapter);
  const started=performance.now();await vault.initialize();const initMs=performance.now()-started;
  const samples:number[]=[];adapter.reset();
  let previous=seed['Note 0.md'];
  for(let i=0;i<100;i++){
    const next=`${previous}\nEdit ${i}`;const start=performance.now();
    await vault.modify('Note 0.md',next,{expectedContent:previous});
    await vault.reload(['Note 0.md']);
    samples.push(performance.now()-start);previous=next;
  }
  samples.sort((a,b)=>a-b);
  const startBacklinks=performance.now();const backlinks=vault.metadata.backlinks('Note 0.md').length;
  rows.push({notes:size,initMs:+initMs.toFixed(2),saveAndWatcherMedianMs:+samples[50].toFixed(3),saveAndWatcherP95Ms:+samples[95].toFixed(3),readsPerSave:adapter.reads/100,statsPerSave:adapter.stats/100,listsPerSave:adapter.lists/100,backlinks,backlinksMs:+(performance.now()-startBacklinks).toFixed(2)});
}
console.log(JSON.stringify({scope:'Synthetic in-memory core only; not paired Obsidian measurements',node:process.version,platform:process.platform,arch:process.arch,rows},null,2));
