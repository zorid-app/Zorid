import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cases,fixtureFiles,initialConfiguration,roundTripSources} from './fixtures.mjs';
import {assertMembership,assertConfiguration,expectedConfiguration,expectedPaths} from './oracles.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CAMPAIGN_DIRECTORIES,campaignClosure} from '../bases-electron-integration/owned-fixtures.mjs';

test('authored typed inventory keeps array equality, variadic members and exact negation source distinct',()=>{
  assert.equal(cases.length,65);assert.equal(new Set(cases.map(item=>item.id)).size,65);
  for(const item of cases){assert.ok(item.expression.length);expectedPaths(item.members);}
  const byId=id=>cases.find(item=>item.id===id);
  assert.equal(byId('list-typed-exact').expression,'note["mixed"] == [1, true, "1", null]');
  assert.deepEqual(byId('list-typed-exact').values,[1,true,'1',null]);
  assert.equal(byId('string-any').expression,'note["text"].containsAny("beta", "gamma")');
  assert.equal(byId('string-not-all').expression,'!note["text"].containsAll("Alpha", "beta")');
  assert.equal(byId('date-before').expression,'note["due"] < "2026-10-22"');
  assert.equal(byId('datetime-on').expression,'note["moment"] == "2026-10-22T12:30"');
  assert.equal(roundTripSources['list-exact'],'note["items"] == ["red"]');
  assert.equal(roundTripSources['list-any'],'note["items"].containsAny("red")');
  assert.equal(roundTripSources['list-typed-exact'],'note["mixed"] == [1, true, "1"]');
});
test('membership oracle rejects duplicates, omissions, reordered paths and null-as-zero membership',()=>{
  assertMembership(['Items/A.md','Items/B.md'],['A','B']);
  for(const paths of [['Items/A.md'],['Items/A.md','Items/A.md'],['Items/B.md','Items/A.md'],['Items/A.md','Items/B.md','Items/E.md']])assert.throws(()=>assertMembership(paths,['A','B']));
  assert.deepEqual(expectedPaths(cases.find(item=>item.id==='number-lte').members),['Items/A.md','Items/Deep/C.md','Items/D.md']);
});
test('whole-source oracle rejects argument-shape coercion and unknown view/extension loss',()=>{
  const expression='note["mixed"] == [1, true, "1", null]',prefix='# Typed filter acceptance: retain this comment and unknown fields.\n';
  const yaml={parse:source=>JSON.parse(source.slice(prefix.length))};
  assertConfiguration(yaml,prefix+JSON.stringify(expectedConfiguration(expression)),expression);
  for(const change of [value=>{value.views[0].filters={and:['note["mixed"] == ["1", "true", "1", "null"]']};},value=>{value.views[1].filters='note.amount > 2';},value=>{delete value.pluginRoot;},value=>{value.views[0].filters={and:['note["mixed"].containsAll(1, true, "1", null)']};}]){const altered=expectedConfiguration(expression);change(altered);assert.throws(()=>assertConfiguration(yaml,prefix+JSON.stringify(altered),expression));}
  assert.deepEqual(initialConfiguration.views[1].filters,'note.amount > max(1, 2)');
});
test('prelaunch fixture distinguishes text case, empty lists, nulls and immutable note bodies',()=>{
  const files=fixtureFiles();assert.equal(files.size,8);assert.match(files.get('Items/A.md'),/"mixed": \[\n    1,\n    true,\n    "1",\n    null/);
  assert.match(files.get('Items/D.md'),/"amount": 0/);assert.match(files.get('Items/E.md'),/"amount": null/);
  for(const [name,source]of files)if(name.startsWith('Items/'))assert.match(source,/Exact body [A-E] stays unchanged\./);
});
test('the exact typed-filter canonical campaign is admitted and its changed source alters frozen provenance',async t=>{
  const name='bases-electron-filter-integration';assert.equal(CAMPAIGN_DIRECTORIES.filter(item=>item===name).length,1);
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-filter-admission-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const hashTree=async directory=>Promise.all((await fs.readdir(directory)).sort().map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(directory,file))).digest('hex')]));
  const absent=await campaignClosure(root,hashTree);assert.equal(absent[name],null);
  const directory=path.join(root,name);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'campaign.mjs'),'before');const before=await campaignClosure(root,hashTree);
  await fs.writeFile(path.join(directory,'campaign.mjs'),'after');const after=await campaignClosure(root,hashTree);
  assert.notDeepEqual(before[name],after[name]);assert.deepEqual(Object.keys(before),CAMPAIGN_DIRECTORIES);
});
