#!/usr/bin/env node
// Preparation harness: verifies recorded TypeScript baseline only. It does not
// execute MDBASE or assert pending Stage4 dialect changes against old code.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf('--source-root');
const root = flag < 0 ? resolve(here, '../../../..') : resolve(process.argv[flag + 1]);
assert.equal(new Date('2024-01-15T00:00:00').getTime(), 1705276800000, 'Run with TZ=UTC to pin current JS calendar semantics');
const expression = await import(pathToFileURL(resolve(root, 'src/bases/expression.ts')));
const {BaseDocument} = await import(pathToFileURL(resolve(root, 'src/bases/document.ts')));
const {executeBaseQuery} = await import(pathToFileURL(resolve(root, 'src/bases/query.ts')));
function typed(value) {
  switch (value.type) {
    case 'error': return {type:'error', code:value.error.code};
    case 'list': return {type:'list', value:value.value.map(typed)};
    case 'object': return {type:'object', value:Object.fromEntries(Object.entries(value.value).map(([key,item]) => [key,typed(item)]))};
    case 'number': return {type:'number', value:Number.isFinite(value.value) ? value.value : String(value.value)};
    case 'namespace': return {type:'namespace', name:value.name};
    case 'regexp': return {type:'regexp', source:value.value.source, flags:value.value.flags};
    default: return value;
  }
}
let passed = 0;
const failures = [];
function check(id, run) { try {run(); passed++;} catch (error) {failures.push(id); console.error(id, error.message);} }
for (const item of JSON.parse(await readFile(resolve(here,'expressions.json'),'utf8')).cases) {
  check(`expression/${item.id}`, () => {
    const {now, ...settings} = item.context ?? {};
    const context = expression.createBaseExpressionContext({...settings, now:() => new Date(now ?? '2024-01-15T10:20:30Z')});
    let ast;
    try {ast = expression.parseBaseExpression(item.expression);} catch (error) {
      assert.deepEqual({type:'error',code:error.code},item.current); return;
    }
    const results = Array.from({length:item.repeat ?? 1}, () => typed(expression.evaluateBaseExpression(ast,context)));
    assert.deepEqual(item.repeat ? results : results[0], item.current);
  });
}
for (const item of JSON.parse(await readFile(resolve(here,'queries.json'),'utf8')).cases) {
  check(`query/${item.id}`, () => {
    const before = JSON.stringify(item.snapshot);
    const document = BaseDocument.parse(JSON.stringify(item.document)), source = document.toString();
    const result = executeBaseQuery(document,item.snapshot,{...item.options,now:() => new Date('2024-01-15T10:20:30Z')});
    assert.equal(result.version,item.snapshot.version);
    assert.equal(JSON.stringify(item.snapshot),before);
    assert.equal(document.toString(),source);
    const actual = {
      paths:result.rows.map(row => row.path), properties:result.properties, counts:result.counts,
      groups:result.groups.map(group => ({key:group.key === null ? null : typed(group.key), paths:group.rows.map(row => row.path)})),
      groupOptions:result.groupOptions.map(group => ({...group,key:typed(group.key)})),
    };
    for (const [key, expected] of Object.entries(item.current)) {
      if (key === 'diagnostics') {
        for (const diagnostic of expected) assert.ok(result.diagnostics.some(actual => Object.entries(diagnostic).every(([key,value]) => actual[key] === value)), JSON.stringify(diagnostic));
      } else if (key === 'values') {
        for (const [path, values] of Object.entries(expected)) {
          const row = result.rows.find(row => row.path === path); assert.ok(row,path);
          for (const [property,value] of Object.entries(values)) assert.deepEqual(typed(row.values[property]),value,property);
        }
      } else assert.deepEqual(actual[key], expected, key);
    }
  });
}
for (const item of JSON.parse(await readFile(resolve(here,'documents.json'),'utf8')).cases) {
  check(`document/${item.id}`, () => {
    let document;
    try {document = BaseDocument.parse(item.source);} catch (error) {if (item.current.valid) throw error; return;}
    assert.equal(item.current.valid,true,'Expected rejected configuration');
    assert.equal(document.toString() === item.source,item.current.unchanged);
    assert.deepEqual(document.views.map(view => view.type),item.current.viewTypes);
  });
}
console.log(JSON.stringify({scope:'current-typescript-baseline-only',passed,failed:failures.length,failures}));
if (failures.length) process.exitCode = 1;
