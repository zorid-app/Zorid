import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generate,noteSource,noteSize,notePath,noteId,queries,literalOracle,expectedCount,sha256,json} from './workload.mjs';
import {validateSearch,invoke} from './cli.mjs';

test('v1 exact template, UTF8 byte budgets and fixed source digest remain reproducible',()=>{
  const expected='---\nproject: project-0\nstatus: todo\nrank: 0\n---\n# Note 000000\n\ncommon-marker café 😀\nunique-000000\nrare-marker\nprefixSUBSTRsuffix\n[[/Notes/G000/Note-000001]]\n- [ ] Task\n';
  const source=noteSource(0,100);assert.ok(source.startsWith(expected));
  assert.equal(sha256(source),'deea4370c5f650bc985aaf7ddccfa44905849655cd34c6bf78a8236e632c9076');
  for(const i of [0,69,70,94,95,98,99,100,999,1000]){const text=noteSource(i,1001);assert.equal(Buffer.byteLength(text),noteSize(i));assert.equal(text.at(-1),'\n');assert.ok(!text.includes('\r'));}
  assert.equal(notePath(1000),'Notes/G001/Note-001000.md');assert.equal(noteId(1000),'note-001000');
  assert.equal(Array.from({length:100000},(_,i)=>noteSize(i)).reduce((a,b)=>a+b,0),305152000);
});
test('analytic membership and manually checked Unicode ranges retain current literal semantics',()=>{
  assert.equal(expectedCount(queries[2],100000),101);assert.equal(expectedCount(queries[3],100000),2703);
  assert.equal(expectedCount(queries[5],100),0);assert.equal(expectedCount(queries[6],100),0);
  // Header is63 ASCII units; café+space+emoji is10 UTF8 bytes /7 UTF16 units.
  assert.deepEqual(literalOracle(queries[7],100).next().value,{logicalId:'note-000000',path:notePath(0),line:7,range:{bytes:[77,87],utf16:[77,84]}});
  assert.deepEqual(literalOracle(queries[1],100).next().value,{logicalId:'note-000042',path:notePath(42),line:8,range:{bytes:[89,102],utf16:[86,99]}});
  for(const q of queries)assert.equal([...literalOracle(q,100)].length,expectedCount(q,100));
});
test('fresh fixture generation is byte-identical across directories and refuses replacement',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'zorid-s1-generator-test-'));
  try{const a=await generate(path.join(root,'a'),100),b=await generate(path.join(root,'b'),100);
    assert.equal(a.fixtureHash,b.fixtureHash);assert.equal(json(a.manifest),json(b.manifest));assert.equal(a.manifest.entries.length,103);
    for(const entry of a.manifest.entries){const bytes=await readFile(path.join(a.vault,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha256(bytes),entry.sha256);}
    for(const file of ['manifest.json','queries.json','scenarios.json','fixture.json'])assert.equal(await readFile(path.join(a.out,file),'utf8'),await readFile(path.join(b.out,file),'utf8'));
    await assert.rejects(generate(a.out,100),{code:'EEXIST'});
  }finally{await rm(root,{recursive:true,force:true});}
});
function sampleReply(){const query=queries[1],expected=literalOracle(query,100).next().value,entry={id:'physical42',revision:'revision42',path:expected.path,kind:'file',deleted:false},snapshot={localStoreId:'local',generationEpoch:'epoch',generation:'1',versions:{schema:1}};
  const reply={snapshot,source:{localStoreId:'local',watermark:'1'},coverageComplete:true,scanComplete:true,complete:true,truncated:false,value:{hasNext:false,hits:[{entry,line:expected.line,range:expected.range}],pages:4,documents:100,sourceBytes:305152}};
  return {query,entry,snapshot,reply,byPath:new Map([[entry.path,entry]])};}
test('CLI oracle verifies physical revision and generation, rejecting forged ranges or omissions',()=>{
  const f=sampleReply();assert.equal(validateSearch(f.reply,f.query,100,f.byPath,f.snapshot).correctness,'complete-oracle');
  for(const mutate of [r=>r.value.hits[0].entry.revision='wrong',r=>r.value.hits[0].range.utf16[0]++,r=>r.value.hits=[],r=>r.snapshot.generation='2']){
    const reply=structuredClone(f.reply);mutate(reply);assert.throws(()=>validateSearch(reply,f.query,100,f.byPath,f.snapshot));}
});
test('CLI oracle labels bounded prefix honestly and rejects false completeness',()=>{
  const f=sampleReply();f.reply.value.hits=[];f.reply.scanComplete=false;f.reply.complete=false;f.reply.truncated=true;f.reply.value.hasNext=true;
  assert.equal(validateSearch(f.reply,f.query,100,f.byPath,f.snapshot).correctness,'ordered-prefix-only');
  f.reply.complete=true;assert.throws(()=>validateSearch(f.reply,f.query,100,f.byPath,f.snapshot));
});
test('subprocess wrapper records output and bounds only its exact owned child',async()=>{
  const good=await invoke(process.execPath,['-e','process.stdout.write(JSON.stringify({ok:true}))'],{environment:process.env,timeoutMs:1000});assert.equal(good.exitCode,0);assert.equal(good.stdout,'{"ok":true}');
  const slow=await invoke(process.execPath,['-e','setInterval(()=>{},1000)'],{environment:process.env,timeoutMs:100});assert.equal(slow.timedOut,true);assert.notEqual(slow.signal,null);
});
