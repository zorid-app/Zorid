const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {buildCoreWasm}=require('../scripts/build-core-wasm.cjs');
async function setup(callback) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-build-core-'));
  try {
    await fs.mkdir(path.join(root,'crates/zorid-wasm/src'),{recursive:true});await fs.mkdir(path.join(root,'scripts'));
    for(const file of ['Cargo.toml','Cargo.lock','scripts/build-core-wasm.cjs','crates/zorid-wasm/Cargo.toml','crates/zorid-wasm/src/lib.rs'])await fs.writeFile(path.join(root,file),'initial');
    const calls=[];
    const run=async(command,args,options)=>{
      calls.push({command,args,options});
      if(args[0]==='--version')return 'wasm-bindgen 0.2.129';
      if(args[0]==='--target') {
        const directory=args[args.indexOf('--out-dir')+1];
        await fs.writeFile(path.join(directory,'zorid_wasm.js'),'generated JS');
        await fs.writeFile(path.join(directory,'zorid_wasm_bg.wasm'),'generated WASM');
      }
      return '';
    };
    await callback({root,calls,run,directory:path.join(root,'target/browser-wasm/generated')});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('browser build locks dependencies, pins bindgen, bounds Cargo jobs and rebuilds changed source/output',async()=>{
  await setup(async({root,calls,run,directory})=>{
    assert.equal(await buildCoreWasm({root,run}),directory);assert.equal(calls.length,3);
    assert.ok(calls[1].args.includes('--locked'));
    assert.equal(calls[1].args.at(-1),'1');assert.equal(calls[1].args.at(-2),'-j');
    assert.equal(calls[2].args[1],'web');
    await buildCoreWasm({root,run});assert.equal(calls.length,3);
    await fs.appendFile(path.join(root,'crates/zorid-wasm/src/lib.rs'),'changed');
    await buildCoreWasm({root,run});assert.equal(calls.length,6);
    await fs.writeFile(path.join(directory,'zorid_wasm.js'),'corrupt output');
    await buildCoreWasm({root,run});assert.equal(calls.length,9);
    await fs.writeFile(path.join(root,'crates/zorid-wasm/src/new.rs'),'new source');
    await buildCoreWasm({root,run});assert.equal(calls.length,12);
  });
});
test('mismatched bindgen fails before Cargo or artifact generation',async()=>{
  await setup(async({root,directory})=>{
    let count=0;
    await assert.rejects(buildCoreWasm({root,run:async()=>{count++;return 'wasm-bindgen 0.2.128';}}),/requires wasm-bindgen-cli 0.2.129/);
    assert.equal(count,1);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
  });
});
test('changing source during generation rejects the build without publishing a current cache',async()=>{
  await setup(async({root,run,directory})=>{
    await assert.rejects(buildCoreWasm({root,run:async(...args)=>{
      const result=await run(...args);
      if(args[1][0]==='--target')await fs.appendFile(path.join(root,'Cargo.lock'),'changed');
      return result;
    }}),/sources changed during/);
    await assert.rejects(fs.stat(path.join(directory,'build.json')),{code:'ENOENT'});
  });
});
