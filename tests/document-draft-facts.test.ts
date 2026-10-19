import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDocumentDraftFacts,validateDocumentParseFacts,documentDraftFactsAllocation} from '../src/core/document-draft-facts.ts';
import {noteFromFacts} from '../src/core/metadata.ts';

const text='---\r\nvalue: [true, 1, null]\r\n---\r\n# Hé😀\r\n[[dest]]\r\n';
const source={bytes:Buffer.byteLength(text),utf16:text.length};
function range(a:number,b:number){return {bytes:[Buffer.byteLength(text.slice(0,a)),Buffer.byteLength(text.slice(0,b))],utf16:[a,b]};}
function token(value:string){const start=text.indexOf(value);assert.ok(start>=0);return range(start,start+value.length);}
function facts():any{const body=text.indexOf('# Hé');return {schemaVersion:2,dialectVersion:'zorid-markdown-1',sourceLength:source,frontmatter:{state:'valid',range:range(0,body),bodyStart:{byte:Buffer.byteLength(text.slice(0,body)),utf16:body}},properties:[{key:'value',value:[true,1,null],type:'list',keyRange:token('value')}],aliases:['alias'],tags:['tag'],tagOccurrences:[],headings:[{text:'Hé😀',level:1,line:3,range:token('# Hé😀\r\n')}],links:[{kind:'wiki',embed:false,target:'dest',fragment:'',destination:'dest',range:token('[[dest]]'),targetRange:token('dest'),definitionRange:null}],tasks:[],blocks:[{kind:'heading',range:token('# Hé😀\r\n')}],listItems:[],diagnostics:[]};}

test('identity-free exact-source facts preserve supplied Unicode CRLF and readonly display fields',()=>{
  const decoded=decodeDocumentDraftFacts(JSON.stringify(facts()),source),view=noteFromFacts('Draft.md',decoded);
  assert.equal('entryId'in decoded,false);assert.equal('contentRevision'in decoded,false);
  assert.deepEqual(view.headings,[{heading:'Hé😀',level:1,line:3}]);assert.deepEqual(view.frontmatter.value,[true,1,null]);
  assert.equal(view.links[0]!.start,text.indexOf('dest'));assert.equal(view.links[0]!.end,text.indexOf('dest')+4);
  assert.ok(Object.isFrozen(decoded.links[0]!.targetRange.utf16));assert.ok(Object.isFrozen(view));
});

test('draft facts reject committed identities wrong versions or mismatched exact source lengths',()=>{
  for(const mutate of [(m:any)=>m.entryId='forged',(m:any)=>m.contentRevision='forged',(m:any)=>m.schemaVersion=1,(m:any)=>m.dialectVersion='other',(m:any)=>m.sourceLength={...source,utf16:source.utf16-1},(m:any)=>m.unexpected=true]){
    const m=facts();mutate(m);assert.throws(()=>decodeDocumentDraftFacts(JSON.stringify(m),source));
  }
});

test('shared facts validation retains structural range YAML and block constraints',()=>{
  for(const mutate of [(m:any)=>m.frontmatter.bodyStart.byte--,(m:any)=>m.properties[0].keyRange=range(0,0),(m:any)=>m.links[0].targetRange.bytes[1]--,(m:any)=>m.headings[0].level=0,(m:any)=>m.blocks.push(m.blocks[0]),(m:any)=>m.tasks=[{}],(m:any)=>m.diagnostics=[{code:'unknown',severity:'error',range:range(0,1)}]]){
    const m=facts();mutate(m);assert.throws(()=>decodeDocumentDraftFacts(JSON.stringify(m),source));
  }
});

test('facts reject malformed Unicode and bounded recursive values',()=>{
  const invalid=facts();invalid.aliases=['\ud800'];assert.throws(()=>decodeDocumentDraftFacts(JSON.stringify(invalid),source));
  let value:unknown=null;for(let i=0;i<65;i++)value=[value];const deep=facts();deep.properties[0].value=value;assert.throws(()=>validateDocumentParseFacts(deep,source));
  const wide=facts();wide.properties[0].value=Array(100000).fill(null);assert.throws(()=>validateDocumentParseFacts(wide,source));
});

test('allocation preflight accounts quoted spellings nodes and depth before JSON parsing',()=>{
  assert.ok(documentDraftFactsAllocation('{"a":[1,2]}')>documentDraftFactsAllocation('{"a":1}'));
  assert.ok(documentDraftFactsAllocation('{"a":"\\u0061"}')>documentDraftFactsAllocation('{"a":"a"}'));
  assert.throws(()=>documentDraftFactsAllocation('['.repeat(74)+'0'+']'.repeat(74)));
  assert.throws(()=>documentDraftFactsAllocation('{"unterminated'));
});

test('facts validation never executes property accessors',()=>{
  const value=facts();let called=0;Object.defineProperty(value,'headings',{enumerable:true,get(){called++;return [];}});
  assert.throws(()=>validateDocumentParseFacts(value,source));assert.equal(called,0);
});

test('view mapping preserves repeated reference destinations without invented entry witnesses',()=>{
  const value=facts();value.links.push({...value.links[0]});const view=noteFromFacts('Renamed.md',decodeDocumentDraftFacts(JSON.stringify(value),source));
  assert.equal(view.path,'Renamed.md');assert.equal(view.links.length,2);assert.deepEqual(view.links[0],view.links[1]);assert.equal('entryId'in view,false);
});
