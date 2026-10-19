import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {notePath,noteId,noteSize,extras,sha256,json} from './workload.mjs';
import {generatedPlan,expectedGenerated,CLOCK_ORACLE,SOURCE,SNAPSHOT} from './generated-bases-oracle.mjs';
const manifest=count=>({noteCount:count,entries:[...Array.from({length:count},(_,i)=>({path:notePath(i),logicalId:noteId(i),noteIndex:i,sha256:sha256(`unit-witness-${i}`),bytes:noteSize(i)})),...extras.map(e=>({path:e.path,logicalId:e.logicalId,sha256:sha256(e.bytes),bytes:e.bytes.length}))]});
test('generated Base requests freeze five programs/eight invocations without changing workload sources',()=>{
  const plan=generatedPlan();assert.equal(plan.programs.length,5);assert.equal(plan.invocations.length,8);assert.equal(plan.programs[0].source,extras[1].bytes.toString('utf8'));
  assert.equal(new Set(plan.invocations.map(c=>c.id)).size,8);for(const c of plan.invocations){assert.equal(c.options.maxSteps,2000000);assert.equal(c.options.maxScanned,50000);}
});
test('sparse output and repeat have independent exact arithmetic membership/counts',()=>{
  const m=manifest(100),first=expectedGenerated('sparse-first',m),again=expectedGenerated('sparse-repeat',m);assert.deepEqual(first,again);
  assert.equal(first.rows.length,100);assert.equal(first.rows[0].path,notePath(0));assert.equal(first.rows[99].path,notePath(99));assert.equal(first.counts.scanned,103);
});
test('formula sorting and group membership preserve independent typed keys and order',()=>{
  const r=expectedGenerated('formula-sort-group',manifest(100));assert.equal(r.rows[0].entryId,noteId(99));assert.equal(r.rows[99].entryId,noteId(0));assert.deepEqual(r.rows[0].values['formula.doubleRank'],{type:'number',value:198});
  assert.deepEqual(r.groups.map(g=>[g.key.value,g.entryIds.length]),[['doing',33],['done',33],['todo',34]]);assert.equal(r.groups[0].entryIds[0],noteId(97));assert.equal(r.groups[1].entryIds[0],noteId(98));assert.equal(r.groups[2].entryIds[0],noteId(99));
});
test('relationship oracle checks actual target identity/revision and rooted link spelling',()=>{
  const m=manifest(100),r=expectedGenerated('relationship-filter',m);assert.equal(r.rows.length,50);assert.equal(r.rows[49].entryId,noteId(98));const link=r.rows[49].values['formula.target'];assert.equal(link.path,'/Notes/G000/Note-000099');assert.equal(link.target.entryId,noteId(99));assert.equal(link.target.revision,`source-${m.entries[99].sha256}`);
});
test('context and view changes affect only their declared arithmetic results',()=>{
  const m=manifest(100);const a=expectedGenerated('current0-ascending',m),b=expectedGenerated('current1-ascending',m),c=expectedGenerated('current1-descending',m);
  assert.deepEqual(a.rows.map(r=>r.path),b.rows.map(r=>r.path));assert.deepEqual(c.rows.map(r=>r.path),b.rows.map(r=>r.path).reverse());assert.equal(a.rows[0].values['formula.contextRank'].value,0);assert.equal(b.rows[0].values['formula.contextRank'].value,1);assert.equal(c.viewName,'Descending');
});
test('fixed clock is copied from the pinned accepted expression, not ambient time',async()=>{
  const bytes=await readFile(new URL(`../../tests/fixtures/document-semantics/bases/${CLOCK_ORACLE.file}`,import.meta.url));assert.equal(sha256(bytes),CLOCK_ORACLE.sha256);const c=JSON.parse(bytes).cases.find(c=>c.id===CLOCK_ORACLE.id);
  assert.equal(c.request.expression,CLOCK_ORACLE.expression);assert.equal(c.request.options.clockMs,CLOCK_ORACLE.clockMs);assert.equal(c.request.options.timezone,CLOCK_ORACLE.timezone);assert.equal(c.expected.value,CLOCK_ORACLE.expected);
  const r=expectedGenerated('fixed-clock',manifest(100));assert.equal(r.rows.length,3);assert.ok(r.rows.every(r=>r.values['formula.today'].value==='2024-01-15'));
});
test('future10k success oracle keeps all input rows and linked witnesses',()=>{
  const m=manifest(10000);const r=expectedGenerated('relationship-filter',m);assert.equal(r.counts.scanned,10003);assert.equal(r.rows.length,50);assert.equal(r.relationshipsAvailable,true);assert.equal(r.metadataIssues[0].exclusion,'binary');
  assert.throws(()=>expectedGenerated('unknown',m));assert.throws(()=>expectedGenerated('sparse-first',{...m,noteCount:100000}));
});

// These synthetic protocol objects exercise validators, not the Rust engine.
import {GeneratedBasesValidator,validateGeneratedResult} from './generated-bases.mjs';
function syntheticResult(id,m){const e=expectedGenerated(id,m);return {snapshotId:structuredClone(SNAPSHOT),view:{name:e.viewName},rows:structuredClone(e.rows),properties:e.properties,counts:e.counts,groups:e.groups,groupOptions:e.groupOptions,diagnostics:[],relationshipsAvailable:true,metadataComplete:true,metadataIssues:e.metadataIssues,stepsUsed:1};}
function prepared(count){const m=manifest(count),plan=generatedPlan(),v=new GeneratedBasesValidator({manifest:m},plan);
  v.accept({type:'setup',noteCount:count,entries:m.entries.length,sourceBytes:m.entries.reduce((n,e)=>n+e.bytes,0),manifestBytes:Buffer.byteLength(json(m)),planBytes:Buffer.byteLength(json(plan)),debugAssertions:false,setupMs:0,sourceReadMs:0,sourceDecodeMs:0});
  v.accept({type:'generation',source:SOURCE,snapshot:SNAPSHOT,records:count+3,fileFacts:count+3,parseInvocations:count,coverageComplete:true,metadataBytes:1,pumpResets:0,generationBuildMs:0});
  for(const p of plan.programs)v.accept({type:'program',programId:p.id,sourceBytes:Buffer.byteLength(p.source),yamlAndConfigurationMs:0});return {m,plan,v};}
function finishSynthetic(count,outcome='rejected',code='budget'){const {m,plan,v}=prepared(count);for(const i of plan.invocations){v.accept({type:'result',caseId:i.id,programId:i.programId,options:i.options,source:SOURCE,snapshot:SNAPSHOT,queryMs:0,outcome,...(outcome==='ok'?{result:syntheticResult(i.id,m)}:{error:{code,message:'synthetic limitation'}})});v.accept({type:'measurement',caseId:i.id,resultOutputMs:0});}v.accept({type:'done',source:SOURCE,snapshot:SNAPSHOT,invocations:8,successes:outcome==='ok'?8:0,rejections:outcome==='rejected'?8:0});return v;}
test('a100-note rejection fails;10k budget rejection remains explicitly limited/incomplete',()=>{
  assert.equal(finishSynthetic(100).status(),'failed-or-incomplete');assert.equal(finishSynthetic(10000).status(),'limited-incomplete');assert.equal(finishSynthetic(10000,'rejected','unknown-function').status(),'failed-or-incomplete');assert.equal(finishSynthetic(100,'ok').status(),'passed');
});
test('independent result checks reject altered order, values, groups, counts and witnesses',()=>{
  const m=manifest(100),check=(id,change)=>{const r=syntheticResult(id,m);change(r);assert.throws(()=>validateGeneratedResult(r,id,m));};
  check('sparse-first',r=>r.rows.reverse());check('sparse-first',r=>r.rows[0].revision='changed');check('sparse-first',r=>r.rows[0].values['note.rank'].value=9);check('formula-sort-group',r=>r.groups[0].entryIds.pop());check('formula-sort-group',r=>r.rows[0].values['formula.doubleRank'].value=199);check('relationship-filter',r=>r.rows[0].values['formula.target'].target.revision='foreign');check('fixed-clock',r=>r.rows[0].values['formula.today'].value='2024-01-16');check('current1-descending',r=>r.rows[0].values['formula.contextRank'].value=0);check('sparse-first',r=>r.counts.scanned--);check('sparse-first',r=>r.metadataIssues[0].witness.revision='wrong');
});
test('source, request capture and final ordering must remain exact',()=>{
  const {plan,v}=prepared(100),i=plan.invocations[0];assert.throws(()=>v.accept({type:'done',source:SOURCE,snapshot:SNAPSHOT,invocations:8,successes:0,rejections:8}));
  const event={type:'result',caseId:i.id,programId:i.programId,options:i.options,source:SOURCE,snapshot:SNAPSHOT,queryMs:0,outcome:'rejected',error:{code:'budget',message:'synthetic'}};
  assert.throws(()=>v.accept({...event,source:{...SOURCE,watermark:'2'}}));assert.throws(()=>v.accept({...event,options:{...i.options,viewIndex:1}}));assert.throws(()=>v.accept({...event,result:{}}));v.accept(event);assert.throws(()=>v.accept(event));v.accept({type:'measurement',caseId:i.id,resultOutputMs:0});assert.equal(v.results[0].correctness,'semantic oracle unestablished; no result returned');
});
