import test from 'node:test';
import assert from 'node:assert/strict';
import {q3Files,q3Groups} from '../fixtures/bases-q3-semantics.mjs';
import {files,q3LegacyDiagnostics} from './fixtures.mjs';
import {assertQ3Result,q3CommandCount} from './q3-oracles.mjs';

// These assertion-layer tests use inert authored DTOs, never the product engine
// or a captured query as the expected result. They prove no diagnostic is lost
// when the original deletion fixture is carried into a filtered Q3 query.
function fixture(){
  const group=q3Groups[0],states=new Map([...files,...q3Files].map(file=>[file.id,{id:file.id,path:file.path,revision:'authored-'+file.id}]));
  const typed=value=>Array.isArray(value)?value.map(typed):value&&typeof value==='object'
    ?{...Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typed(item)])),...(value.type==='error'?{message:'Authored diagnostic message'}:{})}:value;
  const result={view:{name:group.view},counts:{returned:1},rows:group.rows.map(row=>({path:row.path,entryId:'q3-source',revision:states.get('q3-source').revision,values:typed(row.values)})),summaries:{},diagnostics:[
    ...group.diagnostics.map(issue=>({...issue,phase:'value',entryId:'q3-source'})),
    ...q3LegacyDiagnostics.map(issue=>({...issue})),
  ]};
  return{group,states,result};
}

test('exact original Delta diagnostic joins the Q3 diagnostic multiset without changing the command plan',()=>{
  const{group,states,result}=fixture();assertQ3Result(result,group,states);
  assert.equal(q3CommandCount,40);assert.equal(85+q3CommandCount,125);
  assert.equal(q3Groups.reduce((sum,item)=>sum+item.diagnostics.length,0),16);
  assert.deepEqual(q3LegacyDiagnostics,[{phase:'property',entryId:'delta',path:'Books/Delta.md',property:'note.author',code:'unresolved_relation'}]);
});

test('missing, duplicate, extra and changed legacy diagnostics are rejected',()=>{
  for(const mutate of [
    issues=>issues.pop(),
    issues=>issues.push({...q3LegacyDiagnostics[0]}),
    issues=>issues.push({phase:'property',entryId:'ada',path:'Authors/Ada.md',property:'note.author',code:'unresolved_relation'}),
    ...['phase','entryId','path','property','code'].map(key=>issues=>{issues.at(-1)[key]='changed';}),
  ]){const{group,states,result}=fixture();mutate(result.diagnostics);assert.throws(()=>assertQ3Result(result,group,states));}
});

test('Q3 diagnostics and authoritative diagnostic receipts remain exact',()=>{
  for(const key of ['phase','entryId','path','property','code']){
    const{group,states,result}=fixture();result.diagnostics[0][key]='changed';assert.throws(()=>assertQ3Result(result,group,states));
  }
  for(const key of ['id','path','revision']){
    const{group,states,result}=fixture();states.get('delta')[key]=key==='revision'?'':'changed';assert.throws(()=>assertQ3Result(result,group,states));
  }
  const{group,states,result}=fixture();states.delete('delta');assert.throws(()=>assertQ3Result(result,group,states));
});
