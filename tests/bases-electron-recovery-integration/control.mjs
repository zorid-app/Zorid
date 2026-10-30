import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateArm} from './protocol.mjs';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function createNativeRelay({native,directory}) {
  assert.ok(path.isAbsolute(native)&&path.isAbsolute(directory));
  await fs.mkdir(directory,{mode:0o700});
  const module=fileURLToPath(new URL('./relay.mjs',import.meta.url)),executable=path.join(directory,'native-relay');
  const source=`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(module)} --relay-native ${quote(native)} --relay-directory ${quote(directory)} -- "$@"\n`;
  await fs.writeFile(executable,source,{mode:0o700,flag:'wx'});
  const atomic=async(name,value)=>{const temporary=path.join(directory,name+'.'+randomBytes(8).toString('hex'));await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(temporary,path.join(directory,name));};
  return {
    executable, directory,
    processIdentity:{executable:process.execPath,args:[module,'--relay-native',native,'--relay-directory',directory,'--']},
    provenanceFiles:[module,fileURLToPath(new URL('./protocol.mjs',import.meta.url)),fileURLToPath(import.meta.url),executable],
    async arm(input){const arm=validateArm({...input,token:randomBytes(16).toString('hex')});await fs.rm(path.join(directory,'release.json'),{force:true});await atomic('arm.json',arm);return arm.token;},
    async release(token){assert.match(token,/^[a-f0-9]{32}$/);await atomic('release.json',{token});},
    async events(){try{const source=await fs.readFile(path.join(directory,'events.jsonl'),'utf8');assert.ok(source.length<8*1024*1024);return source.slice(0,source.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return[];throw error;}},
    async dispose(){
      const events=await this.events(),held=events.findLast(value=>value.kind==='held');
      if(held&&!events.some(value=>['released','watchdog-released','held-child-closed'].includes(value.kind)&&value.token===held.token))await this.release(held.token);
      await fs.rm(path.join(directory,'arm.json'),{force:true});
    },
  };
}
