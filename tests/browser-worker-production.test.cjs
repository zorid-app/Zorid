const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const webpack=require('webpack');
test('production worker supports source TS imports and a same-origin dynamic WASM import',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-production-worker-'));
  let compiler;
  try{
    await fs.writeFile(path.join(directory,'entry.ts'),"globalThis.worker = new Worker(new URL('./worker.ts',import.meta.url));");
    await fs.writeFile(path.join(directory,'worker.ts'),"import {suffix} from './dep.ts'; self.onmessage=async(event:MessageEvent)=>{const moduleUrl=new URL(event.data,self.location.href);const wasm=await import(/* webpackIgnore: true */ moduleUrl.href);await wasm.default();self.postMessage(suffix);};");
    await fs.writeFile(path.join(directory,'dep.ts'),"export const suffix='done';");
    const configFile=path.join(directory,'tsconfig.json');
    await fs.writeFile(configFile,JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',lib:['ES2022','DOM'],strict:true,noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true},include:['*.ts']}));
    const configured=require('../webpack.config.cjs')({target:'desktop'});
    const sourceRule=configured.module.rules.find(rule=>rule.test.test('worker.ts'));
    compiler=webpack({mode:'production',context:directory,entry:'./entry.ts',devtool:false,output:{path:path.join(directory,'out'),filename:'main.js',chunkFilename:'[name].js'},resolve:configured.resolve,
      module:{rules:[{...sourceRule,use:{loader:require.resolve('ts-loader'),options:{...sourceRule.use.options,configFile}}}]}});
    const stats=await new Promise((resolve,reject)=>compiler.run((error,stats)=>error?reject(error):resolve(stats)));
    assert.equal(stats.hasErrors(),false,stats.toString({all:false,errors:true}));
    const files=(await fs.readdir(path.join(directory,'out'))).filter(name=>name.endsWith('.js'));
    assert.ok(files.length>=2,'the real entry and worker are both emitted');
    for(const name of files)new vm.Script(await fs.readFile(path.join(directory,'out',name),'utf8'),{filename:name});
  }finally{if(compiler)await new Promise((resolve,reject)=>compiler.close(error=>error?reject(error):resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
