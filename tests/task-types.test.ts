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
