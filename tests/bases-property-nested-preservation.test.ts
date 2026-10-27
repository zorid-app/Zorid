import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {parseDocument} from 'yaml';
import {parseBasePropertyDefinitions,updateBasePropertyDefinition} from '../src/bases/property-definitions.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';
import {createBasePropertySettingsPanel} from '../src/bases/property-settings-panel.ts';

const source=`# Shared property registry
version: 1
properties:
  author:
    type: relation # author value type
    futureDefinition: top-level-keep
    relation:
      # keep relation map comment
      # keep relation extension comment
      futureSetting: 'keep-author' # opaque relation field
      multiple: true # editable cardinality
      targetFilter: 'kind == "author"' # editable filter
      tailSetting:
        nested: 'opaque' # keep nested quote and comment
  reviewer:
    type: relation
  books:
    type: reverseRelation
    reverseRelation:
      # keep reverse map comment
      futureSetting: 'keep-reverse' # opaque reverse field
      property: author # editable forward property
      afterProperty: keep-after-reverse
  total:
    type: rollup
    rollup:
      # keep rollup map comment
      futureSetting: 'keep-rollup' # opaque rollup field
      relation: author # editable relation
      property: amount # editable related property
      aggregation: sum # editable aggregation
      afterAggregation: keep-after-rollup
  amount:
    type: number

# Registry trailing comment
`;
const definitions=()=>parseBasePropertyDefinitions(source);
const settings=[['author','relation'],['books','reverseRelation'],['total','rollup']] as const;
const expectedFuture={author:'keep-author',books:'keep-reverse',total:'keep-rollup'};

for(const[property,key]of settings)test(`unchanged ${key} targeted mutation retains exact nested AST comments, unknown data and order`,()=>{
  const definition=definitions().properties[property];
  assert.equal(updateBasePropertyDefinition(source,property,definition),source);
});

test('known relation edits and cleared optional filter preserve every untouched nested node',()=>{
  const changed=updateBasePropertyDefinition(source,'author',{type:'relation',relation:{multiple:false}});
  assert.equal(changed,source.replace('multiple: true # editable cardinality','multiple: false # editable cardinality').replace('      targetFilter: \'kind == "author"\' # editable filter\n',''));
  const filtered=updateBasePropertyDefinition(source,'author',{type:'relation',relation:{multiple:true,targetFilter:'kind == "reviewer"'}});
  assert.equal(filtered,source.replace('targetFilter: \'kind == "author"\'','targetFilter: \'kind == "reviewer"\''));
});

test('reverse and rollup known-field patches retain unknown fields and inline comments',()=>{
  const reverse=updateBasePropertyDefinition(source,'books',{type:'reverseRelation',reverseRelation:{property:'reviewer'}});
  assert.equal(reverse,source.replace('property: author # editable forward property','property: reviewer # editable forward property'));
  const rollup=updateBasePropertyDefinition(source,'total',{type:'rollup',rollup:{relation:'reviewer',property:'score',aggregation:'average'}});
  assert.equal(rollup,source.replace('relation: author # editable relation','relation: reviewer # editable relation').replace('property: amount # editable related property','property: score # editable related property').replace('aggregation: sum # editable aggregation','aggregation: average # editable aggregation'));
  const count=updateBasePropertyDefinition(source,'total',{type:'rollup',rollup:{relation:'author',aggregation:'count'}});
  assert.equal(count,source.replace('      property: amount # editable related property\n','').replace('aggregation: sum # editable aggregation','aggregation: count # editable aggregation'));
});

test('type conversion still removes incompatible known settings without changing unrelated definitions',()=>{
  const converted=updateBasePropertyDefinition(source,'author',{type:'number'}),raw=parseDocument(converted).toJS();
  assert.equal(raw.properties.author.type,'number');assert.equal(raw.properties.author.relation,undefined);
  assert.equal(raw.properties.author.futureDefinition,'top-level-keep');
  assert.deepEqual(raw.properties.books,parseDocument(source).toJS().properties.books);
  assert.deepEqual(raw.properties.total,parseDocument(source).toJS().properties.total);
  assert.match(converted,/# keep reverse map comment/);assert.match(converted,/# keep rollup map comment/);
});

async function panelFixture(property:string,inputSource=source) {
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
  const original=parseBasePropertyDefinitions(inputSource),errors:unknown[]=[];let savedSource=inputSource,received:BasePropertyDefinition|null|undefined;
  const before=JSON.stringify(original);
  const panel=createBasePropertySettingsPanel(doc.querySelector('main')!,{definitions:()=>original,properties:()=>Object.keys(original.properties).map(name=>'note.'+name),preflight(){},onDraftChange(){},onError(error){errors.push(error);},
    async save(name,definition,expected){assert.equal(expected,original.properties[property]);received=definition;savedSource=updateBasePropertyDefinition(savedSource,name,definition);},
  });
  panel.open(property);
  const input=(label:string,value:string|boolean)=>{const field=doc.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label=${JSON.stringify(label)}]`)!;assert.ok(field);if(typeof value==='boolean')(field as HTMLInputElement).checked=value;else field.value=value;field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  const submit=()=>{doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
  const apply=async()=>{submit();for(let n=0;n<20&&doc.querySelector('.bases-property-settings')&&!errors.length;n++)await new Promise(done=>setTimeout(done,0));assert.deepEqual(errors,[]);assert.equal(doc.querySelector('.bases-property-settings'),null);assert.equal(JSON.stringify(original),before,'settings drafts never mutate their original definition baseline');};
  return{dom,doc,panel,input,apply,submit,errors,original,get savedSource(){return savedSource;},get received(){return received;},cleanup(){panel.destroy();dom.window.close();}};
}

for(const[property,key]of settings)test(`actual unchanged ${key} Apply retains unknown draft data and whole source`,async()=>{
  const f=await panelFixture(property);try{
    await f.apply();
    assert.equal((f.received?.[key] as unknown as Record<string,unknown>)?.futureSetting,expectedFuture[property]);
    assert.equal(f.savedSource,source);
  }finally{f.cleanup();}
});

test('actual relation Apply patches cardinality and removes an emptied filter without dropping future metadata',async()=>{
  const f=await panelFixture('author');try{
    f.input('Allow multiple',false);f.input('Target filter','');await f.apply();
    assert.equal((f.received!.relation as unknown as Record<string,unknown>).futureSetting,'keep-author');
    assert.equal(f.received!.relation!.targetFilter,undefined);
    assert.equal(f.savedSource,source.replace('multiple: true # editable cardinality','multiple: false # editable cardinality').replace('      targetFilter: \'kind == "author"\' # editable filter\n',''));
  }finally{f.cleanup();}
});

test('actual rollup Apply clears an optional target only when count is selected and retains opaque metadata',async()=>{
  const f=await panelFixture('total');try{
    f.input('Aggregation','count');f.input('Related property','');await f.apply();
    assert.equal((f.received!.rollup as unknown as Record<string,unknown>).futureSetting,'keep-rollup');
    assert.equal(f.received!.rollup!.property,undefined);
    assert.equal(f.savedSource,source.replace('      property: amount # editable related property\n','').replace('aggregation: sum # editable aggregation','aggregation: count # editable aggregation'));
  }finally{f.cleanup();}
});

test('switching relation controls away and back retains its nested extension draft and original source',async()=>{
  const f=await panelFixture('author');try{
    const type=f.doc.querySelector<HTMLSelectElement>('[aria-label="Property type"]')!;
    type.value='number';type.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
    type.value='relation';type.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
    await f.apply();assert.equal((f.received!.relation as unknown as Record<string,unknown>).futureSetting,'keep-author');assert.equal(f.savedSource,source);
  }finally{f.cleanup();}
});

test('omitting optional known relation fields removes only those pairs and keeps its extension map',()=>{
  const changed=updateBasePropertyDefinition(source,'author',{type:'relation',relation:{}});
  assert.equal(changed,source.replace('      multiple: true # editable cardinality\n','').replace('      targetFilter: \'kind == "author"\' # editable filter\n',''));
});

test('a selected nested settings alias is detached with opaque data while its shared template stays unchanged',()=>{
  const original=`settings: &shared
  futureSetting: 'keep' # shared extension comment
  multiple: true
  targetFilter: 'kind == "author"'
properties:
  author:
    type: relation
    relation: *shared
  reviewer:
    type: relation
    relation: *shared
`;
  const changed=updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}}),raw=parseDocument(changed).toJS();
  assert.equal(raw.properties.author.relation.futureSetting,'keep');assert.equal(raw.properties.author.relation.multiple,false);assert.equal(raw.properties.author.relation.targetFilter,undefined);
  assert.deepEqual(raw.settings,parseDocument(original).toJS().settings);assert.deepEqual(raw.properties.reviewer,parseDocument(original).toJS().properties.reviewer);
  assert.match(changed,/settings: &shared/);assert.match(changed,/# shared extension comment/);assert.match(changed,/reviewer:\n    type: relation\n    relation: \*shared/);
});

test('a selected aliased definition preserves unknown definition and nested data without editing another owner',()=>{
  const original=`shared: &definition
  type: relation
  futureDefinition: keep-top
  relation:
    futureSetting: keep-nested
    multiple: true
properties:
  author: *definition
  reviewer: *definition
`;
  const changed=updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}}),raw=parseDocument(changed).toJS();
  assert.equal(raw.properties.author.futureDefinition,'keep-top');assert.equal(raw.properties.author.relation.futureSetting,'keep-nested');assert.equal(raw.properties.author.relation.multiple,false);
  assert.deepEqual(raw.shared,parseDocument(original).toJS().shared);assert.deepEqual(raw.properties.reviewer,parseDocument(original).toJS().properties.reviewer);assert.match(changed,/reviewer: \*definition/);
  const converted=parseDocument(updateBasePropertyDefinition(original,'author',{type:'text'})).toJS();
  assert.equal(converted.properties.author.type,'text');assert.equal(converted.properties.author.relation,undefined);assert.equal(converted.properties.author.futureDefinition,'keep-top');assert.deepEqual(converted.properties.reviewer,raw.properties.reviewer);
});


const anchoredRelation=`properties:
  author:
    type: relation
    relation: &shared
      futureSetting: keep
      multiple: true
  reviewer:
    type: relation
    relation: *shared
`;
const anchoredDefinition=`properties:
  author: &sharedDefinition
    type: relation
    futureDefinition: keep-top
    relation:
      futureSetting: keep-nested
      multiple: true
  reviewer: *sharedDefinition
`;
for(const[name,original]of [['nested settings owner',anchoredRelation],['whole definition owner',anchoredDefinition]])test(`changing an anchored ${name} refuses unrelated alias changes atomically while no-op edits stay valid`,()=>{
  assert.equal(updateBasePropertyDefinition(original,'author',parseBasePropertyDefinitions(original).properties.author),original);
  assert.throws(()=>updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}}),/share YAML values/);
  assert.equal(parseDocument(original).toJS().properties.reviewer.relation.multiple,true);
});

test('alias-driven changes to unfamiliar root and selected nested fields are refused',()=>{
  const rootConsumer=`properties:
  author:
    type: relation
    relation: &shared
      futureSetting: keep
      multiple: true
futureBinding: *shared
`;
  assert.throws(()=>updateBasePropertyDefinition(rootConsumer,'author',{type:'relation',relation:{multiple:false}}),/share YAML values/);
  const nestedConsumer=`properties:
  author:
    type: relation
    relation:
      multiple: &many true
      futureSetting: *many
`;
  assert.throws(()=>updateBasePropertyDefinition(nestedConsumer,'author',{type:'relation',relation:{multiple:false}}),/share YAML values/);
});

for(const[name,original]of [['nested settings owner',anchoredRelation],['whole definition owner',anchoredDefinition]])test(`actual Apply on an anchored ${name} retains source and draft when another owner would change`,async()=>{
  const f=await panelFixture('author',original);try{
    f.input('Allow multiple',false);f.submit();
    for(let n=0;n<20&&!f.errors.length;n++)await new Promise(done=>setTimeout(done,0));
    assert.equal(f.errors.length,1);assert.match((f.errors[0] as Error).message,/share YAML values/);
    assert.equal(f.savedSource,original);assert.equal(f.panel.hasDraft(),true);assert.ok(f.doc.querySelector('.bases-property-settings'));
    assert.equal(f.doc.querySelector<HTMLInputElement>('[aria-label="Allow multiple"]')!.checked,false);
    assert.equal(f.original.properties.author.relation!.multiple,true);assert.equal(f.original.properties.reviewer.relation!.multiple,true);
    assert.equal(f.doc.querySelector<HTMLFieldSetElement>('fieldset')!.disabled,false);
  }finally{f.cleanup();}
});

const rootCollision=`properties:
  author:
    type: relation
    relation:
      multiple: &many true
1: *many
"1": untouched
`;
const nestedCollision=`properties:
  author:
    type: relation
    relation:
      multiple: &many true
future:
  1: *many
  "1": untouched
`;
const nullCollision=`properties:
  author:
    type: relation
    relation:
      multiple: &many true
null: *many
"": untouched
`;
const aliasKeyCollision=`properties:
  author:
    type: relation
    relation:
      multiple: &many true
numberKey: &numberKey 1
? *numberKey
: *many
"1": untouched
`;
for(const[name,original]of [['root numeric/string',rootCollision],['nested numeric/string',nestedCollision],['null/empty-string',nullCollision],['aliased scalar key/string',aliasKeyCollision]])test(`ambiguous ${name} YAML key projection refuses update without narrowing the reader contract`,()=>{
  assert.equal(parseBasePropertyDefinitions(original).properties.author.relation!.multiple,true,'reading existing settings remains supported');
  assert.throws(()=>updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}}),/overlapping|complex/);
  const full=parseDocument(original).toJS({mapAsMap:true}) as Map<unknown,unknown>;
  const consumer=name.startsWith('nested')?full.get('future') as Map<unknown,unknown>:full;
  assert.equal(consumer.get(name.startsWith('null')?null:1),true);assert.equal(consumer.get(name.startsWith('null')?'':'1'),'untouched');
});

test('actual Apply keeps the exact source and draft for an ambiguous YAML key projection',async()=>{
  const f=await panelFixture('author',rootCollision);try{
    f.input('Allow multiple',false);f.submit();
    for(let n=0;n<20&&!f.errors.length;n++)await new Promise(done=>setTimeout(done,0));
    assert.equal(f.errors.length,1);assert.match((f.errors[0] as Error).message,/overlapping|complex/);
    assert.equal(f.savedSource,rootCollision);assert.equal(f.panel.hasDraft(),true);
    assert.equal(f.doc.querySelector<HTMLInputElement>('[aria-label="Allow multiple"]')!.checked,false);
    assert.equal(f.doc.querySelector<HTMLFieldSetElement>('fieldset')!.disabled,false);
  }finally{f.cleanup();}
});

test('complex YAML keys require source editing while the existing reader stays permissive',()=>{
  const original=`properties:
  author:
    type: relation
    relation:
      multiple: true
future:
  ? [1, 2]
  : untouched
`;
  assert.equal(parseBasePropertyDefinitions(original).properties.author.type,'relation');
  assert.throws(()=>updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}}),/complex YAML keys/);
});

test('unambiguous primitive keys and safe scalar key aliases do not block ordinary edits',()=>{
  const original=`numberKey: &key 1
properties:
  author:
    type: relation
    relation:
      multiple: true
future:
  ? *key
  : untouched
`;
  const changed=updateBasePropertyDefinition(original,'author',{type:'relation',relation:{multiple:false}});
  const raw=parseDocument(changed).toJS({mapAsMap:true}) as Map<unknown,unknown>;
  assert.equal((raw.get('future') as Map<unknown,unknown>).get(1),'untouched');
  assert.equal(parseBasePropertyDefinitions(changed).properties.author.relation!.multiple,false);
});
