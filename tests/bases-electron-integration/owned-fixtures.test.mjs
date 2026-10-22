import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateFixtureName,fixturePath,readFixture,writeFixture,campaignClosure} from './owned-fixtures.mjs';
const setup=async t=>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-fixture-guard-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const vault=path.join(root,'vault');await fs.mkdir(vault);return{root,vault};};
test('read and external-write boundaries reject escape/alias names without changing outside files',async t=>{
  const{root,vault}=await setup(t),outside=path.join(root,'outside.md');await fs.writeFile(outside,'retain outside');
  for(const name of ['../outside.md','a/../../outside.md','/private/tmp/outside.md','C:\\outside.md','C:/outside.md','a\\outside.md','bad\0name','a/./b','a//b','a/','']){
    assert.throws(()=>validateFixtureName(name));await assert.rejects(readFixture(vault,name));await assert.rejects(writeFixture(vault,name,'clobber',{createParents:true}));
  }
  assert.equal(await fs.readFile(outside,'utf8'),'retain outside');assert.deepEqual(await fs.readdir(vault),[]);
});
test('ordinary nested fixture creation/read/replacement preserves exact bytes',async t=>{
  const{vault}=await setup(t);const name='Items/Notes #100% [draft] 空.md';
  await writeFixture(vault,name,'before\r\n😀',{createParents:true});assert.equal(await readFixture(vault,name),'before\r\n😀');
  await writeFixture(vault,name,'external\n');assert.equal(await readFixture(vault,name),'external\n');
});
test('symlink file, directory, dangling target, and vault aliases are rejected before IO',async t=>{
  const{root,vault}=await setup(t),outside=path.join(root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'note.md'),'outside bytes');
  await fs.symlink(outside,path.join(vault,'redirect'));await fs.symlink(path.join(outside,'note.md'),path.join(vault,'linked.md'));await fs.symlink(path.join(outside,'absent.md'),path.join(vault,'dangling.md'));await fs.symlink(vault,path.join(root,'vault-alias'));
  for(const name of ['redirect/note.md','redirect/new.md','linked.md','dangling.md']){await assert.rejects(readFixture(vault,name));await assert.rejects(writeFixture(vault,name,'bad',{createParents:true}));}
  await assert.rejects(fixturePath(path.join(root,'vault-alias'),'note.md'));assert.equal(await fs.readFile(path.join(outside,'note.md'),'utf8'),'outside bytes');assert.deepEqual(await fs.readdir(outside),['note.md']);
});
test('sibling campaign dependency changes and newly appearing folders alter provenance',async t=>{
  const{root}=await setup(t),tests=path.join(root,'tests');await fs.mkdir(tests);const clipboard=path.join(tests,'bases-electron-clipboard-integration');await fs.mkdir(clipboard);await fs.writeFile(path.join(clipboard,'clipboard.mjs'),'first guard');
  const hashTree=async directory=>{const names=(await fs.readdir(directory)).sort();return Promise.all(names.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex')]));};
  const before=await campaignClosure(tests,hashTree);await fs.writeFile(path.join(clipboard,'clipboard.mjs'),'changed guard');const after=await campaignClosure(tests,hashTree);assert.notDeepEqual(after,before);assert.notDeepEqual(after['bases-electron-clipboard-integration'],before['bases-electron-clipboard-integration']);
  await fs.mkdir(path.join(tests,'bases-electron-config-integration'));assert.notDeepEqual(await campaignClosure(tests,hashTree),after);
  await fs.symlink(clipboard,path.join(tests,'bases-electron-layouts-integration'));await assert.rejects(campaignClosure(tests,hashTree));
});
