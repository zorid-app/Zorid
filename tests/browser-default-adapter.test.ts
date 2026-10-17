import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBrowserAdapter} from '../src/platform/browser-default.ts';
import {BrowserVaultError} from '../src/core/browser-vault.ts';
import type {BrowserCoreRuntime} from '../src/platform/browser-core-runtime.ts';
import type {BrowserClientContext} from '../src/platform/browser-client-admission.ts';
test('normal adapter installs admitted durable save and retains exact uncertain command identities',async()=>{
  const calls:any[]=[];let fail=true;
  const writes={} as BrowserClientContext['durableWrites'];
  const context={durableWrites:writes,recoverCommands:async()=>false,fileCommand:async(input:any)=>{calls.push(structuredClone(input));if(fail)throw new BrowserVaultError('outcome_unknown','unknown');}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context);
  assert.equal(adapter.durableWrites,writes);assert.equal(adapter.durableNamespace,true);
  await assert.rejects(adapter.createText!('One.md','draft'),{code:'outcome_unknown'});
  await assert.rejects(adapter.createText!('One.md','different'),{code:'command_pending'});assert.equal(calls.length,1);
  fail=false;await adapter.createText!('One.md','draft');assert.deepEqual(calls[0],calls[1]);
  await adapter.createText!('One.md','different');assert.notEqual(calls[2].operationId,calls[0].operationId);
});
test('normal adapter snapshots binary bytes before asynchronous command dispatch',async()=>{
  let request:any;
  const context={durableWrites:{},recoverCommands:async()=>false,fileCommand:async(input:any)=>{await Promise.resolve();request=structuredClone(input);}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context),bytes=new Uint8Array([0,255,7]);
  const operation=adapter.writeBinary!('blob.bin',bytes);bytes.fill(9);await operation;
  assert.deepEqual([...request.data],[0,255,7]);
});

test('ordinary browser selection requires Rust assets rather than falling back to the preview vault',async()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'window');
  try{
    Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
    const {createPlatformAdapter}=await import('../src/platform/index.ts');
    await assert.rejects(createPlatformAdapter(),{code:'core_assets_missing'});
  }finally{if(saved)Object.defineProperty(globalThis,'window',saved);else Reflect.deleteProperty(globalThis,'window');}
});

test('uncertain consumer release retries only release and does not recover commands again',async()=>{
  const {createBrowserRelease}=await import('../src/platform/browser-default.ts');
  let commands=0,releases=0,slots=0,completed=0;
  const release=createBrowserRelease({recoverCommands:async()=>{commands++;return false;},release:async()=>{releases++;if(releases===1)throw new Error('release response lost');}}, {release:async()=>{slots++;}},()=>{completed++;});
  await assert.rejects(release(),/response lost/);await release();await release();
  assert.equal(commands,1);assert.equal(releases,2);assert.equal(slots,1);assert.equal(completed,1);
});
test('registry release retry after consumer release never invokes the closed consumer',async()=>{
  const {createBrowserRelease}=await import('../src/platform/browser-default.ts');
  let commands=0,releases=0,slots=0;
  const release=createBrowserRelease({recoverCommands:async()=>{assert.equal(releases,0);commands++;return false;},release:async()=>{releases++;}}, {release:async()=>{slots++;if(slots===1)throw new Error('registry write failed');}},()=>{});
  await assert.rejects(release(),/registry write/);await release();
  assert.equal(commands,1);assert.equal(releases,1);assert.equal(slots,2);
});
