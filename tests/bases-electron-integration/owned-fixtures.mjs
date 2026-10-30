import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export const CAMPAIGN_DIRECTORIES=Object.freeze(['bases-visual-reference','bases-electron-safety-integration','bases-electron-config-integration','bases-electron-properties-integration','bases-electron-clipboard-integration','bases-electron-layouts-integration','bases-electron-recovery-integration','bases-electron-native-select-integration','bases-electron-filter-integration','bases-electron-sidebar-race-integration','bases-electron-selection-integration','bases-electron-sidebar-pin-integration','bases-electron-auto-recovery-integration']);

/** Logical fixture names are literal vault-relative files, never host paths. */
export function validateFixtureName(file){
  assert.ok(typeof file==='string'&&file.length&&!file.includes('\0')&&!file.includes('\\')&&!path.isAbsolute(file)&&!path.win32.isAbsolute(file),'Fixture must be a relative logical path');
  assert.ok(file.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Fixture cannot traverse or alias directories');
  return file;
}
/** Reject every existing symlink, including an owned symlink to another owned
 * location. Negative fixtures may replace normal files but cannot redirect IO. */
export async function fixturePath(vault,file){
  validateFixtureName(file);
  const root=path.resolve(vault),stat=await fs.lstat(root);
  assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Owned vault must be a real directory');
  assert.equal(await fs.realpath(root),root,'Owned vault ancestors cannot be symlinks');
  let current=root;
  const parts=file.split('/');
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]);
    let entry;try{entry=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    assert.ok(!entry.isSymbolicLink(),'Fixture path cannot contain symlinks');
    assert.ok(i===parts.length-1?entry.isFile():entry.isDirectory(),'Fixture path has an unexpected file kind');
  }
  return current;
}
export async function readFixture(vault,file){
  const target=await fixturePath(vault,file),handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{return await handle.readFile('utf8');}finally{await handle.close();}
}
export async function writeFixture(vault,file,source,{createParents=false}={}){
  assert.ok(typeof source==='string'||Buffer.isBuffer(source),'Fixture source is text or bytes');
  let target=await fixturePath(vault,file);
  if(createParents){await fs.mkdir(path.dirname(target),{recursive:true});target=await fixturePath(vault,file);}
  const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(source);}finally{await handle.close();}
}
/** Hash all admitted siblings so cross-campaign helper imports have the same
 * frozen closure as their caller. Absence is explicit and changes are detected. */
export async function campaignClosure(testsRoot,hashTree){
  const root=await fs.realpath(testsRoot),result={};
  for(const name of CAMPAIGN_DIRECTORIES){
    const directory=path.join(root,name);
    let stat;try{stat=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT'){result[name]=null;continue;}throw error;}
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Campaign source directory cannot be a symlink');
    assert.equal(await fs.realpath(directory),directory,'Campaign source stays in its owned directory');
    result[name]=await hashTree(directory);
  }
  return result;
}
