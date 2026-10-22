import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE_FILE_FILTER_OPERATORS,buildFilterCondition,decodeFilterCondition} from '../src/bases/toolbar-config.ts';

test('every File visual operator emits a supported canonical method with literal operands',()=>{
  for(const descriptor of BASE_FILE_FILTER_OPERATORS){
    const values=descriptor.method==='hasTag'?['#one/child','##two "quoted"']:['folder/a "quoted" \\ .md'];
    const source=buildFilterCondition('file.file',descriptor.id,values,'text');
    assert.equal(source,`${descriptor.inverse?'!':''}file.${descriptor.method}(${values.map(value=>JSON.stringify(value)).join(', ')})`);
    assert.deepEqual(decodeFilterCondition(source),{property:'file.file',operator:descriptor.id,text:values[0],type:'text',values});
  }
});
test('file aliases and bare property operands stay separate without resolving or normalizing literals',()=>{
  const source=buildFilterCondition('file','hasProperty','note.a.b "key"','text');
  assert.equal(source,'file.hasProperty("note.a.b \\"key\\"")');
  assert.deepEqual(decodeFilterCondition('file["file"].hasTag("work", "#SECOND", "space tag")')?.values,['work','#SECOND','space tag']);
  const path='../raw#heading|alias';assert.equal(decodeFilterCondition(buildFilterCondition('file.file','hasLink',path,'text'))?.text,path);
});
test('unsupported or dynamic method expressions retain the advanced path',()=>{
  for(const source of ['file.hasLink(note.target)','file.hasLink(link("A", "Alias"))','file.hasTag()','file.hasTag("a", 1)','file.hasProperty("a", "b")','note.author.hasLink("A")','!!file.hasLink("A")','file.HasLink("A")','file == "A"','file.contains("A")'])assert.equal(decodeFilterCondition(source),undefined,source);
  assert.throws(()=>buildFilterCondition('note.author','hasLink','A','text'),/require the file/);
  assert.throws(()=>buildFilterCondition('file.file','inFolder',['A','B'],'text'),/supported file filter/);
  assert.throws(()=>buildFilterCondition('file.file','hasTag',[],'text'),/supported file filter/);
});
