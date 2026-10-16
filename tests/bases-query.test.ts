import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseDocument } from '../src/bases/document.ts';
import { BaseExpressionError, BaseFunctionRegistry, BASE_NULL, baseExpressionValue, baseValueToString } from '../src/bases/expression.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';
import { BaseQueryError, executeBaseQuery, normalizeBaseProperty } from '../src/bases/query.ts';
import type { BaseQueryFile } from '../src/bases/query.ts';
function document(root: Record<string, unknown> = {}, view: Record<string, unknown> = {}) {
  return BaseDocument.parse(JSON.stringify({ ...root, views: [{ type: 'table', name: 'Table', ...view }] }));
}
const execute = (files: readonly BaseQueryFile[], root: Record<string, unknown> = {}, view: Record<string, unknown> = {}) => executeBaseQuery(document(root, view), { version: 'fixture', files });
const paths = (result: ReturnType<typeof execute>) => result.rows.map(row => row.path);
const text = (value: BaseExpressionValue) => baseValueToString(value);

test('all file extensions participate and the default sort uses short file names with path ties', () => {
  const result = execute([{ path: 'z/A.md' }, { path: 'a/A.md' }, { path: 'B10.png' }, { path: 'B2.png' }]);
  assert.deepEqual(paths(result), ['a/A.md', 'z/A.md', 'B2.png', 'B10.png']);
  assert.deepEqual(result.properties, ['file.name']);
  assert.deepEqual(result.counts, { scanned: 4, matched: 4, afterGroupOrder: 4, afterSearch: 4, returned: 4 });
  assert.equal(result.rows[0].values['file.name'].type, 'string');
  assert.equal(text(result.rows[0].values['file.folder']), 'a');
  assert.equal(result.version, 'fixture'); assert.deepEqual(result.diagnostics, []);
});

test('global and view filters compose with short-circuit evaluation and NOR semantics', () => {
  const files = [{ path: 'a.md', properties: { score: 2, done: false } }, { path: 'b.md', properties: { score: 9, done: true } }, { path: 'c.md', properties: { score: 4 } }];
  assert.deepEqual(paths(execute(files, { filters: { or: ['score > 3', 'done'] } }, { filters: { not: ['done', 'score > 8'] } })), ['c.md']);
  assert.deepEqual(execute(files, { filters: { and: ['false', 'unsupported()'] } }).diagnostics, []);
  assert.deepEqual(paths(execute(files, { filters: { or: ['true', 'unsupported()'] } })), ['a.md', 'b.md', 'c.md']);
});

test('lone empty groups preserve raw semantics while combined groups undergo optimization', () => {
  const files = [{ path: 'a.md' }];
  assert.equal(execute(files, { filters: { or: [] } }).rows.length, 0);
  assert.equal(execute(files, { filters: { and: [] } }).rows.length, 1);
  assert.equal(execute(files, { filters: { not: [] } }).rows.length, 1);
  assert.equal(execute(files, { filters: { or: [] } }, { filters: 'true' }).rows.length, 1);
  assert.equal(execute(files, { filters: 'true' }, { filters: { or: [] } }).rows.length, 1);
  // Optimizing NOT(NOT(a,b)) follows the observed AND rewrite, not Boolean DNF.
  assert.equal(execute(files, { filters: { not: [{ not: ['true', 'false'] }] } }, { filters: 'true' }).rows.length, 0);
});

test('formula results memoize per row and remain bound to their row inside list operations', () => {
  const functions = new BaseFunctionRegistry(); let calls = 0;
  functions.register('counted', { parameters: [], invoke: () => { calls++; return baseExpressionValue(3); } });
  const doc = document({ formulas: { base: 'counted() + score', twice: 'formula.base * 2', scoped: '[1,2].map(formula.base)' }, filters: 'formula.twice > 0' }, { order: ['formula.base', 'formula.twice', 'formula.scoped'] });
  const result = executeBaseQuery(doc, { version: 7, files: [{ path: 'a.md', properties: { score: 1 } }, { path: 'b.md', properties: { score: 2 } }] }, { functions });
  assert.equal(calls, 2); assert.equal(text(result.rows[0].values['formula.twice']), '8');
  assert.equal(text(result.rows[0].values['formula.scoped']), '4, 4');
  executeBaseQuery(doc, { version: 8, files: [{ path: 'a.md', properties: { score: 2 } }] }, { functions });
  assert.equal(calls, 3, 'new snapshots use new formula caches');
});

test('formula cycles and parse errors stay explicit; failing filters exclude only their row', () => {
  const result = execute([{ path: 'a.md', properties: { enabled: true } }, { path: 'b.md', properties: { enabled: false } }], {
    formulas: { A: 'formula.b', b: 'formula.A', invalid: '1 +', good: '2' }, filters: 'enabled || formula.A',
  }, { order: ['formula.A', 'formula.invalid', 'formula.good'] });
  assert.deepEqual(paths(result), ['a.md']);
  assert.equal(result.rows[0].values['formula.A'].type, 'error');
  assert.equal(result.rows[0].values['formula.invalid'].type, 'error');
  assert.equal(text(result.rows[0].values['formula.good']), '2');
  assert.ok(result.diagnostics.some(item => item.phase === 'filter' && item.path === 'b.md' && item.code === 'cycle'));
  assert.ok(result.diagnostics.some(item => item.phase === 'value' && item.code === 'parse'));
});

test('this resolves the selected local file entry, including its note, file and formulas', () => {
  const result = executeBaseQuery(document({ formulas: { owner: 'this.name', localScore: 'this.formula.score', score: 'score + 1' }, filters: 'file == this.file || score > this.score' }, { order: ['name', 'formula.owner', 'formula.localScore'] }), {
    version: 'local', files: [{ path: 'local.md', properties: { name: 'Local', score: 3 } }, { path: 'small.md', properties: { score: 2 } }, { path: 'big.md', properties: { score: 5 } }],
  }, { currentFilePath: 'local.md' });
  assert.deepEqual(paths(result), ['big.md', 'local.md']);
  assert.equal(text(result.rows[0].values['formula.owner']), 'Local');
  assert.equal(text(result.rows[0].values['formula.localScore']), '4');
  assert.equal(execute([{ path: 'a.md' }], { filters: 'this == null' }).rows.length, 1);
});

test('file snapshot methods use path boundaries, hierarchical tags and exact property membership', () => {
  const files = [{ path: 'Notes/a.md', properties: { Status: 'x' }, tags: ['#Work/Today'] }, { path: 'NotesOld/b.md', properties: { status: 'x' }, tags: ['#workshop'] }];
  assert.deepEqual(paths(execute(files, { filters: 'file.inFolder("Notes") && file.hasTag("work") && file.hasProperty("Status") && status == "x"' })), ['Notes/a.md']);
  assert.equal(execute(files, { filters: 'file.inFolder("/")' }).rows.length, 2);
  const unsupported = execute(files, { filters: 'file.links.length > 0' });
  assert.equal(unsupported.rows.length, 0); assert.ok(unsupported.diagnostics.every(item => item.code === 'unsupported'));
});

test('property IDs preserve literal names and namespace spelling; absent note columns remain visible', () => {
  assert.equal(normalizeBaseProperty('file'), 'file.file');
  assert.equal(normalizeBaseProperty('File.name'), 'note.File.name');
  const properties = Object.fromEntries([['__proto__', 9], ['a.b', 4], ['Title', 'Name']]);
  const result = execute([{ path: 'a.md', properties }], {}, { order: ['__proto__', 'a.b', 'title', 'missing', 'formula.absent'] });
  assert.deepEqual(result.properties, ['note.__proto__', 'note.a.b', 'note.title', 'note.missing']);
  assert.equal(text(result.rows[0].values['note.__proto__']), '9');
  assert.equal(text(result.rows[0].values['note.a.b']), '4');
  assert.equal(text(result.rows[0].values['note.title']), 'Name');
  assert.equal(result.rows[0].values['note.missing'].type, 'null');
});

test('sorts numbers and dates, keeps null last in both directions, and falls back on unavailable keys', () => {
  const files = [{ path: 'a.md', properties: { n: null }, mtime: 30 }, { path: 'b.md', properties: { n: 2 }, mtime: 10 }, { path: 'c.md', properties: { n: 10 }, mtime: 20 }];
  assert.deepEqual(paths(execute(files, {}, { sort: [{ property: 'n', direction: 'ASC' }] })), ['b.md', 'c.md', 'a.md']);
  assert.deepEqual(paths(execute(files, {}, { sort: [{ property: 'n', direction: 'DESC' }] })), ['c.md', 'b.md', 'a.md']);
  assert.deepEqual(paths(execute(files, {}, { sort: [{ property: 'file.mtime', direction: 'ASC' }] })), ['b.md', 'c.md', 'a.md']);
  assert.deepEqual(paths(execute(files, {}, { sort: [{ property: 'absent', direction: 'DESC' }] })), ['a.md', 'b.md', 'c.md']);
});

test('Boolean comparison precedes null placement and tied sort keys use the next criterion', () => {
  const result = execute([{ path: 'a.md', properties: { done: null, n: 2 } }, { path: 'b.md', properties: { done: false, n: 1 } }, { path: 'c.md', properties: { done: true, n: 0 } }], {}, { sort: [{ property: 'done', direction: 'DESC' }, { property: 'n', direction: 'ASC' }] });
  assert.deepEqual(paths(result), ['c.md', 'b.md', 'a.md']);
});

test('sort errors are diagnosed as ties without filtering entries or executing arbitrary members', () => {
  const result = execute([{ path: 'b.md' }, { path: 'a.md' }], { formulas: { bad: 'noSuchFunction()' } }, { sort: [{ property: 'formula.bad', direction: 'DESC' }] });
  assert.deepEqual(paths(result), ['a.md', 'b.md']);
  assert.ok(result.diagnostics.some(item => item.phase === 'sort' && item.code === 'unknown-function'));
});

test('explicit group order filters first, counts before limits, preserves empty options and omits empty displayed groups', () => {
  const result = execute([{ path: 'a.md', properties: { state: 'todo', n: 2 } }, { path: 'b.md', properties: { state: 'done', n: 1 } }, { path: 'c.md', properties: { state: 'hidden', n: 0 } }], {}, {
    groupBy: { property: 'state', direction: 'ASC' }, groupOrder: ['empty', 'done', 'todo'], sort: [{ property: 'n', direction: 'ASC' }], limit: 1,
  });
  assert.deepEqual(paths(result), ['b.md']);
  assert.deepEqual(result.groupOptions.map(item => [text(item.key), item.count, item.listed]), [['empty', 0, true], ['done', 1, true], ['todo', 1, true], ['hidden', 1, false]]);
  assert.deepEqual(result.groups.map(group => text(group.key!)), ['done']);
  assert.equal(result.counts.matched, 3); assert.equal(result.counts.afterGroupOrder, 2); assert.equal(result.counts.returned, 1);
  assert.equal(execute([{ path: 'a.md' }], {}, { groupBy: { property: 'state', direction: 'ASC' }, groupOrder: [] }).rows.length, 0);
});

test('natural groups use loose equality, retain whole list keys and keep null last when descending', () => {
  const result = execute([{ path: 'a.md', properties: { key: 2 } }, { path: 'b.md', properties: { key: '2' } }, { path: 'c.md', properties: { key: [1, 2] } }, { path: 'd.md' }], {}, { groupBy: { property: 'key', direction: 'DESC' } });
  assert.equal(result.groups.length, 3);
  assert.deepEqual(result.groups.find(group => group.rows.length === 2)?.rows.map(row => row.path), ['a.md', 'b.md']);
  assert.equal(result.groups.find(group => group.key?.type === 'list')!.rows.length, 1);
  assert.equal(result.groups.at(-1)!.key!.type, 'null');
});

test('search terms match across visible properties before sort and limit; empty visible order is retained', () => {
  const doc = document({}, { order: ['title', 'description'], limit: 1 });
  const result = executeBaseQuery(doc, { version: 1, files: [{ path: 'a.md', properties: { title: 'BLUE', description: 'Moon' } }, { path: 'b.md', properties: { title: 'Blue', description: 'Sky' } }] }, { searchTerms: ['blue', 'moon'] });
  assert.deepEqual(paths(result), ['a.md']); assert.equal(result.counts.afterSearch, 1);
  assert.deepEqual(execute([{ path: 'a.md' }], {}, { order: [] }).properties, []);
});

test('all four view configurations and unknown options stay intact; image values need not be visible', () => {
  for (const type of ['table', 'cards', 'list', 'kanban']) {
    const doc = document({}, { type, image: 'cover', order: ['file.name'], customOption: { nested: [1] }, columnWidth: 320 });
    const before = doc.toString(), result = executeBaseQuery(doc, { version: 1, files: [{ path: 'a.md', properties: { cover: 'image.png' } }] });
    assert.equal(result.view, doc.views[0]); assert.equal(result.view.type, type);
    assert.equal(text(result.rows[0].values['note.cover']), 'image.png'); assert.equal(doc.toString(), before);
    assert.deepEqual(result.view.customOption, { nested: [1] });
  }
});

test('results detach nested metadata, dates, error objects, file namespace fields and configured data', () => {
  const properties = { nested: { x: [1] }, date: new Date(100) };
  const result = execute([{ path: 'a.md', properties }], { formulas: { bad: 'missing()' } });
  properties.nested.x.push(2); properties.date.setTime(200);
  const nested = result.rows[0].values['note.nested']; assert.equal(text(nested), '{"x":"1"}');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.rows)); assert.ok(Object.isFrozen(result.rows[0].values));
  assert.throws(() => (result.rows as unknown[]).push({}), TypeError);
  const file = result.rows[0].values['file.file']; assert.equal(file.type, 'namespace');
  if (file.type === 'namespace') {
    const props = file.get('properties', null as never)!; assert.ok(Object.isFrozen(props));
    assert.equal(file.get('file', null as never), file);
  }
  const error = result.rows[0].values['formula.bad']; if (error.type === 'error') assert.ok(Object.isFrozen(error.error));
});

test('invalid configurations fail explicitly, invalid input rows are diagnosed, duplicate paths fail', () => {
  for (const root of [{ filters: { and: 'x' } }, { filters: { and: [], or: [] } }, { formulas: { a: 1 } }]) assert.throws(() => execute([], root), BaseQueryError);
  assert.throws(() => execute([], {}, { order: [1] }), BaseQueryError);
  assert.throws(() => execute([], {}, { groupBy: { property: 'x' } }), BaseQueryError);
  assert.throws(() => execute([{ path: '../bad.md' }]), BaseQueryError);
  assert.throws(() => execute([{ path: 'a.md' }, { path: 'a.md' }]), /Duplicate/);
  const result = execute([{ path: 'bad.md', properties: { get sideEffect() { throw Error('must not run'); } } }, { path: 'good.md' }]);
  assert.deepEqual(paths(result), ['good.md']); assert.equal(result.diagnostics[0].phase, 'input');
});

test('ignored files stay out of results; per-expression budget failures are explicit and snapshots recompute', () => {
  const doc = document({ filters: '1 + 2 > 1' });
  const snapshot = { version: 'old', files: [{ path: 'a.md' }, { path: 'b.md' }] };
  const result = executeBaseQuery(doc, snapshot, { ignore: path => path === 'b.md', maxSteps: 1 });
  assert.equal(result.rows.length, 0); assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].code, 'budget');
  assert.throws(() => executeBaseQuery(doc, snapshot, { maxSteps: NaN }), /maxSteps/);
  assert.deepEqual(paths(executeBaseQuery(doc, { ...snapshot, version: 'new' }, { ignore: path => path === 'b.md' })), ['a.md']);
});

test('typed function errors remain explicit filter failures and group error keys never impersonate null', () => {
  const functions = new BaseFunctionRegistry();
  functions.register('badValue', { parameters: [], invoke: () => ({ type: 'error', error: new BaseExpressionError('unsupported', 'Host failure') }) });
  const filtered = executeBaseQuery(document({filters: 'badValue()'}), { version: 1, files: [{ path: 'a.md' }] }, { functions });
  assert.equal(filtered.rows.length, 0); assert.equal(filtered.diagnostics[0].message, 'Host failure');
  const result = execute([{ path: 'a.md' }], { formulas: { broken: 'noSuchFunction()' } }, { groupBy: { property: 'formula.broken', direction: 'ASC' } });
  assert.equal(result.groups[0].key?.type, 'error'); assert.ok(result.diagnostics.some(item => item.phase === 'group'));
});

test('duration sorting uses calendar scalar values and positive fractional limits truncate', () => {
 const result = execute([{ path: 'a.md', properties: { value: 2 } }, { path: 'b.md', properties: { value: 1 } }, { path: 'c.md', properties: { value: 3 } }], { formulas: { elapsed: 'duration("1d") * value' } }, { sort: [{ property: 'formula.elapsed', direction: 'DESC' }], limit: 1.9 });
 assert.deepEqual(paths(result), ['c.md']);
 assert.equal(execute([{path:'a.md'}], {}, {limit:0.5}).rows.length,0);
});
test('unrecognized callback namespaces and cyclic callback values become explicit frozen errors',()=>{
 const functions = new BaseFunctionRegistry();
 functions.register('scope', {parameters:[],invoke:()=>({type:'namespace',name:'external',get:()=>BASE_NULL})});
 const cycle: any = {type:'list',value:[]}; cycle.value.push(cycle);
 functions.register('cycle', {parameters:[],invoke:()=>cycle});
 const result=executeBaseQuery(document({formulas:{scope:'scope()',cycle:'cycle()'}}), {version:1,files:[{path:'a.md'}]}, {functions});
 const scope=result.rows[0].values['formula.scope']; assert.equal(scope.type,'error'); if(scope.type==='error')assert.ok(Object.isFrozen(scope.error));
 const list=result.rows[0].values['formula.cycle']; assert.equal(list.type,'error');
});

test('cyclic typed outputs cannot crash natural or explicit-order grouping before result freezing',()=>{
 const functions=new BaseFunctionRegistry();functions.register('cyclic',{parameters:[],invoke:()=>{const value:any={type:'list',value:[]};value.value.push(value);return value;}});
 for(const groupOrder of [undefined, ['valid']]) {
 const result=executeBaseQuery(document({formulas:{key:'cyclic()'}},{groupBy:{property:'formula.key',direction:'ASC'},...(groupOrder?{groupOrder}:{})}),{version:1,files:[{path:'a.md'},{path:'b.md'}]},{functions});
 assert.ok(result.diagnostics.some(item=>item.code==='unsupported'&&item.phase==='group'));
 if(!groupOrder)assert.equal(result.groups[0].key?.type,'error');
 }
});
test('snapshot version and scan count are captured before host callbacks can mutate their container',()=>{
 const snapshot={version:'before',files:[{path:'a.md'}]}, functions=new BaseFunctionRegistry();
 functions.register('mutate',{parameters:[],invoke:()=>{snapshot.version='after';snapshot.files.push({path:'late.md'});return baseExpressionValue(true);}});
 const result=executeBaseQuery(document({filters:'mutate()'}),snapshot,{functions});
 assert.equal(result.version,'before');assert.equal(result.counts.scanned,1);assert.deepEqual(paths(result),['a.md']);
});
