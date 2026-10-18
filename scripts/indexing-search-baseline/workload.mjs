import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,utimes} from 'node:fs/promises';
import path from 'node:path';

export const GENERATOR_VERSION='zorid-s1-workload-v1';
export const CLOCK_MS=1704110400000, CTIME_MS=1704067200000;
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const json=value=>JSON.stringify(value,null,2)+'\n';
export const compare=(a,b)=>a<b?-1:a>b?1:0;
export function checkCount(count){if(!Number.isSafeInteger(count)||count<1||count>100000)throw Error('notes must be an integer in 1..100000');return count;}
const suffix=i=>String(i).padStart(6,'0');
export const notePath=i=>`Notes/G${String(Math.floor(i/1000)).padStart(3,'0')}/Note-${suffix(i)}.md`;
export const noteId=i=>`note-${suffix(i)}`;
export function noteSize(i){const p=i%100;return (p<70?1:p<95?4:p<99?16:64)*1024;}
export function noteSource(i,count){
  checkCount(count);if(!Number.isInteger(i)||i<0||i>=count)throw Error('invalid note index');
  let head=`---\nproject: project-${i%10}\nstatus: ${['todo','doing','done'][i%3]}\nrank: ${i}\n---\n# Note ${suffix(i)}\n\ncommon-marker café 😀\nunique-${suffix(i)}\n`;
  if(i%997===0)head+='rare-marker\n';
  if(i%37===0)head+='prefixSUBSTRsuffix\n';
  if(i%2===0)head+=`[[/${notePath((i+1)%count).slice(0,-3)}]]\n`;
  head+=i%2===0?'- [ ] Task\n':'- [x] Task\n';
  const remaining=noteSize(i)-Buffer.byteLength(head)-1,filler='ordinary filler\n';
  if(remaining<0)throw Error('template exceeds target bytes');
  return head+filler.repeat(Math.floor(remaining/filler.length))+filler.slice(0,remaining%filler.length)+'\n';
}
// Frozen first version: attachment bytes are an opaque binary fixture, never text extraction.
export const extras=Object.freeze([
  {path:'Attachments/pixel.png',logicalId:'attachment-pixel',kind:'binary',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64')},
  {path:'Bases/sparse.base',logicalId:'base-sparse',kind:'text',bytes:Buffer.from('filters: "rank < 100"\nviews:\n  - type: table\n    name: Sparse\n    order: [file.name, rank]\n')},
  {path:'Bases/grouped.base',logicalId:'base-grouped',kind:'text',bytes:Buffer.from('views:\n  - type: table\n    name: Grouped\n    groupBy:\n      property: status\n      direction: ASC\n    order: [file.name, status, rank]\n')},
]);
export const queries=Object.freeze([
  {id:'common',query:'common-marker',membership:'all'},
  {id:'unique42',query:'unique-000042',membership:'index42'},
  {id:'rare',query:'rare-marker',membership:'mod997'},
  {id:'substring',query:'SUBSTR',membership:'mod37'},
  {id:'short-substring',query:'SU',membership:'mod37'},
  {id:'absent',query:'absent-S1-marker-7f3b',membership:'none'},
  {id:'case-sensitive',query:'COMMON-MARKER',membership:'none'},
  {id:'unicode',query:'café 😀',membership:'all'},
]);
export function expectedCount(query,count){checkCount(count);switch(query.membership){case'all':return count;case'index42':return count>42?1:0;case'mod997':return Math.ceil(count/997);case'mod37':return Math.ceil(count/37);case'none':return 0;default:throw Error('unknown oracle');}}
export function* literalOracle(query,count){
  const member=i=>query.membership==='all'||query.membership==='index42'&&i===42||query.membership==='mod997'&&i%997===0||query.membership==='mod37'&&i%37===0;
  for(let i=0;i<checkCount(count);i++)if(member(i)){
    const source=noteSource(i,count),start=source.indexOf(query.query);
    if(start<0)throw Error('frozen template contradicts analytic membership');
    const prefix=source.slice(0,start),byte=Buffer.byteLength(prefix),line=prefix.split('\n').length-1;
    yield {logicalId:noteId(i),path:notePath(i),line,range:{bytes:[byte,byte+Buffer.byteLength(query.query)],utf16:[start,start+query.query.length]}};
  }
}
export function scenarioJournal(count){return {
  schemaVersion:1,clockMs:CLOCK_MS,timezone:'UTC',executed:false,
  scenarios:[{id:'body-edit',index:0,append:'\nbody-change\n'},{id:'metadata-edit',index:0,replace:['status: todo','status: done']},
    {id:'rename',from:notePath(0),to:'Notes/G000/Renamed-000000.md'},
    {id:'burst',indices:Array.from({length:Math.min(100,count)},(_,i)=>i),append:'\nburst-change\n'},
    {id:'foreground',saveCount:20,supersedingQueryCount:10,implemented:false},
    {id:'cold-warm',sourceState:'unchanged',clockMs:CLOCK_MS}],
};}
export async function generate(out,count){
  checkCount(count);out=path.resolve(out);await mkdir(out,{recursive:false});
  const vault=path.join(out,'vault');await mkdir(vault);const entries=[];
  // Sequential file creation bounds memory and disk pressure; this is untimed setup.
  for(let i=0;i<count;i++){
    const relative=notePath(i),bytes=Buffer.from(noteSource(i,count));
    await mkdir(path.dirname(path.join(vault,relative)),{recursive:true});
    await writeFile(path.join(vault,relative),bytes,{flag:'wx'});
    await utimes(path.join(vault,relative),CTIME_MS/1000,(CTIME_MS+1000*i)/1000);
    entries.push({path:relative,logicalId:noteId(i),kind:'text',noteIndex:i,bytes:bytes.length,sha256:sha256(bytes),presentation:{ctimeMs:CTIME_MS,mtimeMs:CTIME_MS+1000*i}});
  }
  for(const item of extras){await mkdir(path.dirname(path.join(vault,item.path)),{recursive:true});await writeFile(path.join(vault,item.path),item.bytes,{flag:'wx'});await utimes(path.join(vault,item.path),CTIME_MS/1000,CTIME_MS/1000);
    entries.push({path:item.path,logicalId:item.logicalId,kind:item.kind,bytes:item.bytes.length,sha256:sha256(item.bytes),presentation:{ctimeMs:CTIME_MS,mtimeMs:CTIME_MS}});}
  entries.sort((a,b)=>compare(a.path,b.path));
  const manifest={schemaVersion:1,generator:GENERATOR_VERSION,noteCount:count,profile:count===10000?'representative':count===100000?'stress':'smoke',noteBytes:entries.filter(e=>e.noteIndex!==undefined).reduce((n,e)=>n+e.bytes,0),entries};
  const fixtureHash=sha256(json(manifest));
  await writeFile(path.join(out,'manifest.json'),json(manifest),{flag:'wx'});
  await writeFile(path.join(out,'queries.json'),json({schemaVersion:1,semantics:'literal-lines-exact-v1',queries:queries.map(q=>({...q,expectedFiles:expectedCount(q,count)}))}),{flag:'wx'});
  await writeFile(path.join(out,'scenarios.json'),json(scenarioJournal(count)),{flag:'wx'});
  await writeFile(path.join(out,'fixture.json'),json({schemaVersion:1,generator:GENERATOR_VERSION,generatorSourceSha256:sha256(await readFile(new URL('./workload.mjs',import.meta.url))),fixtureHash,
    nativePresentation:'manifest ctime is synthetic; filesystem mtime is set; native public admission may choose its own ctime/mtime; runner retains actual read facts',complete:true}),{flag:'wx'});
  return {out,vault,manifest,fixtureHash};
}
