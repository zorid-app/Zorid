'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// Execute the normal exported startup against controlled platform boundaries.
// Runtime/Worker transport behavior is covered separately by browser-core-runtime.
function fixture({openError}={}){
  const calls=[],listeners=new Map();
  const service={maintenance:{},drafts:{}};
  const runtime={documentIndex:{maintenance:{},draftsAvailable:true,drafts:{}},close(){calls.push('close');}};
  const consumer={scope:{vaultId:'authority',clientId:'client'},documentIndex:runtime.documentIndex,workBlocks:{},durableWrites:{},fileCommand(){},async recoverCommands(){calls.push('recover');},async release(){calls.push('consumer-release');}};
  const slot={clientId:'client',async release(input){calls.push(['slot-release',input]);},retire(){calls.push('slot-retire');}};
  const filename=path.resolve(__dirname,'../src/platform/browser-default.ts');
  const module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,__ZORID_CORE_MODULE_PATH__:'/assets/core.js',URL,crypto:globalThis.crypto,structuredClone,
    document:{baseURI:'https://zorid.test/'},window:{addEventListener(name,callback){listeners.set(name,callback);},removeEventListener(name,callback){assert.equal(listeners.get(name),callback);listeners.delete(name);}},
    require(name){
      if(name==='./browser-core-runtime.ts')return {BrowserCoreRuntime:{async open(options){calls.push(['open',options]);if(openError)throw openError;return runtime;}}};
      if(name==='./browser-client-slots.ts')return {openBrowserClientSlot:async()=>slot};
      if(name==='./browser-client-admission.ts')return {admitBrowserClient(received){assert.equal(received,runtime);calls.push('admit');return consumer;}};
      if(name==='./browser-core.ts')return {BrowserCoreAdapter:class {}};
      if(name==='../core/document-semantics.ts')return {createDocumentService(provider){assert.equal(provider,runtime.documentIndex);return service;}};
      if(name==='./browser-legacy-export.ts')return {legacyBrowserExport:()=>undefined};
      if(name==='../core/browser-vault.ts')return {BrowserVaultError:class extends Error{}};
      return {};
    }});
  return {open:module.exports.openDefaultBrowserVault,calls,listeners,service};
}

test('normal browser requests core scheduling and exposes the admitted service through clean release',async()=>{
  const f=fixture(),opened=await f.open();
  const options=f.calls[0][1];
  assert.equal(options.initializeLocal,true);assert.equal(options.documentMaintenance,true);
  assert.equal(options.wasmModuleUrl,'https://zorid.test/assets/core.js');
  assert.equal(opened.documentSemantics,f.service);assert.equal(opened.adapter.documentSemantics,f.service);
  assert.equal(f.listeners.size,1);
  await opened.release();await opened.release();
  assert.deepEqual(structuredClone(f.calls.slice(1)),['admit','recover','consumer-release',['slot-release',{restore:false}]]);
  assert.equal(f.listeners.size,0);
});

test('normal browser keeps the retained client identity when required core startup fails',async()=>{
  const error=new Error('required runtime unavailable'),f=fixture({openError:error});
  await assert.rejects(f.open(),value=>value===error);
  assert.deepEqual(f.calls.slice(1),['slot-retire']);
  assert.equal(f.listeners.size,0);
});
