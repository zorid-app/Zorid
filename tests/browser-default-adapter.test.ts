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
