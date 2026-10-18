import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stringify, parseDocument } from 'yaml';
import { TypesDocument, inspectTypeDocument } from '../src/tasks/types-document.ts';
import { createTaskPreset, planTaskPreset } from '../src/tasks/presets.ts';
import { BaseDocument } from '../src/bases/document.ts';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tasks/task-type.json',import.meta.url),'utf8'));
const ids = {type:'type-task',status:'field-status',planned:'field-planned',deadline:'field-deadline',todo:'todo',working:'active',done:'done'};
test('exact-key mappings and unknown AST survive stable ID label/default edits', () => {
  const source = '# Keep me\r\n' + stringify(fixture()).replace(/\n/g,'\r\n');
  const doc = TypesDocument.parse(source);
  doc.rename('Assignment'); doc.renameProperty('field-status','Progress'); doc.renameOption('field-status','todo','Ready'); doc.setDefault('field-status','active');
  assert.match(doc.toString(),/^# Keep me\r\n/);
  assert.deepEqual((doc.configuration as any).futureRoot,{retain:['001',true]});
  assert.equal((doc.configuration as any).properties[0].options[0].futureOption,'keep');
  assert.equal(doc.model.id,'type-task'); assert.equal(doc.model.properties[0].key,'state');
  assert.equal(doc.model.properties[0].options?.[0].id,'todo');
  assert.equal(doc.model.properties[0].default,'active');
  assert.equal(doc.model.capabilities?.task?.status,'field-status');
  assert.equal(doc.model.properties[3].default,null);
  assert.equal(doc.model.label,'Assignment');
});
test('invalid edits are atomic and unknown/invalid source is returned untouched', () => {
  const doc = TypesDocument.parse(stringify(fixture())); const before = doc.toString();
  assert.throws(() => doc.setDefault('field-status','missing'));
  assert.throws(() => doc.setDefault('field-status',undefined));
  assert.throws(() => doc.setDefault('field-planned','2026-02-30'));
  assert.throws(() => doc.renameOption('field-status','missing','New'));
  assert.equal(doc.toString(),before);
  for (const source of ['version: 2\nfuture: true\n','version: 1\nversion: 1\n','root: &a [*a]\n','!!unknown {}','x: '.repeat(100000)]) {
    const result = inspectTypeDocument(source); assert.equal(result.source,source); assert.equal(result.document,null); assert.ok(result.error);
  }
});
test('duplicate IDs/options, invalid mappings and type versions fail typed edits', () => {
  const cases = [
    (v:any) => v.properties[1].id = 'field-status',
    (v:any) => v.properties[1].key = 'state',
    (v:any) => v.properties[0].options[1].id = 'todo',
    (v:any) => v.capabilities.task.plannedDay = 'field-status',
    (v:any) => v.properties[0].options[0].category = 'waiting',
    (v:any) => v.version = 3,
  ];
  for (const mutate of cases) { const v=fixture(); mutate(v); assert.throws(() => TypesDocument.parse(stringify(v))); }
});
test('preset is ordinary Type/Base data with explicit persisted capture defaults', () => {
  const preset = createTaskPreset(ids);
  assert.equal(preset.type.path,'Types/Task.yaml'); assert.equal(preset.base.path,'Bases/Tasks.base');
  assert.equal(TypesDocument.parse(preset.type.source).model.id,ids.type);
  const base = BaseDocument.parse(preset.base.source);
  assert.equal(base.views.length,2); assert.deepEqual(base.getRoot('creation'),{type:ids.type,properties:{status:ids.todo}});
  assert.deepEqual(preset.captureProperties,{type:ids.type,status:ids.todo});
  assert.deepEqual(parseDocument(preset.base.source).toJS().filters.and,['file.ext == "md"','note.type == "type-task"']);
  assert.equal(base.getRoot('newItemFolder'),'Tasks');
});
test('nonoverwrite planning permits existing folders and blocks files, parents and case aliases', () => {
  const preset=createTaskPreset(ids);
  assert.equal(planTaskPreset(preset,[{path:'Types',kind:'folder'},{path:'Bases',kind:'folder'},{path:'Tasks',kind:'folder'}]).ready,true);
  for (const entry of [{path:'Types/Task.yaml',kind:'file'},{path:'types/task.YAML',kind:'file'},{path:'Types',kind:'file'},{path:'Types/Task.yaml/child',kind:'file'},{path:'Tasks',kind:'file'}] as const) {
    const plan=planTaskPreset(preset,[entry]); assert.equal(plan.ready,false); assert.ok(plan.conflicts.length);
  }
  assert.throws(() => createTaskPreset(ids,{type:'.zorid/types/Task.yaml'}));
  assert.throws(() => createTaskPreset(ids,{destination:'a//b'}));
  assert.throws(() => createTaskPreset({...ids,todo:ids.type}));
});
test('harmless aliases and all explicit YAML tags are rejected without losing source', () => {
  for (const extra of ['x: &x hello\ny: *x\n','x: !!str hello\n','x: !!int 1\n']) {
    const source = 'version: 1\nid: t\nlabel: Task\nproperties: []\n' + extra;
    assert.throws(() => TypesDocument.parse(source));
    assert.equal(inspectTypeDocument(source).source,source);
  }
});
test('surgical scalar/default edits leave unrelated bytes and comments exact', () => {
  const source = '\uFEFF# top\r\n' + stringify(fixture()).replace(/\n/g,'\r\n') + 'x: {a: 1,b: 2} # untouched\r\n';
  const doc = TypesDocument.parse(source);
  doc.rename('Changed'); doc.renameProperty('field-status','Progress'); doc.renameOption('field-status','todo','Ready');
  doc.setDefault('field-planned','2024-02-29');
  assert.equal(doc.model.properties[1].default,'2024-02-29');
  doc.setDefault('field-planned',undefined);
  assert.equal(doc.model.properties[1].default,undefined);
  assert.ok(doc.toString().startsWith('\uFEFF# top\r\n'));
  assert.ok(doc.toString().endsWith('x: {a: 1,b: 2} # untouched\r\n'));
  assert.equal(doc.toString().replace(/label: "Changed"/,'label: Task').replace(/label: "Progress"/,'label: Status').replace(/label: "Ready"/,'label: To do'),source);
  const flow = TypesDocument.parse('version: 1\nid: t\nlabel: Task\nproperties: [{id: p, key: p, label: P, datatype: text}]\nx: {a: 1,b: 2} # untouched\n');
  flow.setDefault('p','hello'); assert.equal(flow.model.properties[0].default,'hello');
  flow.setDefault('p',undefined); assert.equal(flow.model.properties[0].default,undefined);
  assert.ok(flow.toString().endsWith('x: {a: 1,b: 2} # untouched\n'));
});
test('preset rejects conflicts between its own planned files and capture folder', () => {
  for (const locations of [{destination:'Types/Task.yaml'},{destination:'types/task.YAML/Notes'},{type:'Bases/Tasks.base/Task.yaml'},{base:'Types/Task.yaml/Tasks.base'}]) {
    assert.throws(() => createTaskPreset(ids,locations));
  }
});
test('datetime defaults reject normalized invalid calendar dates', () => {
  for (const datetime of ['2026-02-30T00:00:00Z','2026-02-28T24:00:00Z','2026-02-28T01:00:00+24:00']) {
    const value=fixture(); value.properties.push({id:'datetime',key:'when',label:'When',datatype:'datetime',default:datetime});
    assert.throws(() => TypesDocument.parse(stringify(value)));
  }
});
test('surgical default boundaries support block values, implicit null and flow trailing commas', () => {
  const suffix='future: {a: 1,b: 2} # untouched\n';
  const text = (defaultSource:string) => 'version: 1\nid: t\nlabel: Task\nproperties:\n  - id: p\n    key: p\n    label: P\n    datatype: text\n' + defaultSource + suffix;
  for (const defaultSource of ['    default: |\n      before\n','    default:\n','    default: # own comment\n']) {
    const doc=TypesDocument.parse(text(defaultSource)); doc.setDefault('p','after');
    assert.equal(doc.model.properties[0].default,'after'); assert.ok(doc.toString().endsWith(suffix));
    doc.setDefault('p',undefined); assert.equal(doc.model.properties[0].default,undefined); assert.ok(doc.toString().endsWith(suffix));
  }
  const multi=TypesDocument.parse('version: 1\nid: t\nlabel: Task\nproperties:\n  - id: p\n    key: p\n    label: P\n    datatype: multi-select\n    options: [{id: a, label: A}, {id: b, label: B}]\n    default:\n      - a\n' + suffix);
  multi.setDefault('p',['b']); assert.deepEqual(multi.model.properties[0].default,['b']); assert.ok(multi.toString().endsWith(suffix));
  multi.setDefault('p',undefined); assert.ok(multi.toString().endsWith(suffix));
  for (const tail of [',}',', # own comment\n  }']) {
    const doc=TypesDocument.parse('version: 1\nid: t\nlabel: Task\nproperties: [{id: p, key: p, label: P, datatype: text' + tail + ']\n' + suffix);
    doc.setDefault('p','new'); assert.equal(doc.model.properties[0].default,'new'); assert.ok(doc.toString().endsWith(suffix));
  }
});
test('removing first compact mapping default retains its sequence container', () => {
  const suffix='future: {a: 1,b: 2} # untouched\n';
  const doc=TypesDocument.parse('version: 1\nid: t\nlabel: Task\nproperties:\n  - default: old\n    id: p\n    key: p\n    label: P\n    datatype: text\n' + suffix);
  doc.setDefault('p',undefined);
  assert.equal(doc.model.properties[0].id,'p'); assert.equal(doc.model.properties[0].default,undefined);
  assert.match(doc.toString(),/properties:\n  - id: p/); assert.ok(doc.toString().endsWith(suffix));
});
