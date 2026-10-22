import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'yaml';
import {fixtureFiles,vaultName} from './campaign.mjs';
import {CAMPAIGN_DIRECTORIES,campaignClosure,validateFixtureName} from '../bases-electron-integration/owned-fixtures.mjs';

test('bounded probe uses one ordinary book and the exact original three option definitions',()=>{
  const files=fixtureFiles();assert.equal(vaultName,'Native select probe');assert.equal(files.size,3);for(const name of files.keys())validateFixtureName(name);
  assert.deepEqual(parse(files.get('Properties.yaml')),{properties:{topics:{type:'multiselect',options:[{value:'Rust',color:'orange'},{value:'Design',color:'blue'},{value:'Writing',color:'green'}]}}});
  assert.match(files.get('Book 001.md'),/^---\ntype: book\ntopics: \[Design\]/);assert.deepEqual(parse(files.get('Library.base')).views[0].order,['file.name','note.topics']);
});

test('native-select campaign has canonical path admission and source closure witnesses',async t=>{
  const name='bases-electron-native-select-integration';assert.ok(CAMPAIGN_DIRECTORIES.includes(name));
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-select-closure-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const before=await campaignClosure(root,async directory=>(await fs.readdir(directory)).sort());assert.equal(before[name],null);
  await fs.mkdir(path.join(root,name));await fs.writeFile(path.join(root,name,'campaign.mjs'),'read-only source fixture');
  const after=await campaignClosure(root,async directory=>(await fs.readdir(directory)).sort());assert.deepEqual(after[name],['campaign.mjs']);assert.notDeepEqual(after,before);
});
