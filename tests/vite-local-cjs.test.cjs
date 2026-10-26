'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {parse}=require('acorn');

// Real app config and Vite import analysis/optimizer, without Chrome, Rust/WASM,
// a production build, or replacement boundary modules. Native mode skips WASM;
// the local CJS optimizer setting is common to normal web/native development.
test('normal Vite dev rewrites all local CommonJS platform imports and executes their real validators',{timeout:30000},async()=>{
 const {createServer}=await import('vite'),root=path.resolve(__dirname,'..');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zorid-vite-local-cjs-'));
 let server;
 try{
  server=await createServer({root,configFile:path.join(root,'vite.config.mjs'),mode:'native',cacheDir:path.join(directory,'cache'),logLevel:'silent',clearScreen:false,optimizeDeps:{noDiscovery:true},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:null}});
  await server.listen();
  const callers=[['/src/platform/index.ts','workblocks.cjs'],['/src/platform/desktop.ts','workblocks.cjs'],['/src/platform/desktop.ts','conditional-saved-source.cjs'],['/src/platform/desktop-note-plan.ts','conditional-saved-source.cjs'],['/src/platform/mobile-native.ts','document-semantics.cjs']];
  for(const [caller,dependency]of callers){
   const transformed=await server.transformRequest(caller);assert.ok(transformed,caller);
   const imports=parse(transformed.code,{ecmaVersion:'latest',sourceType:'module'}).body.filter(n=>n.type==='ImportDeclaration').map(n=>n.source.value);
   assert.ok(!imports.some(id=>id.split('?')[0].endsWith('/desktop/'+dependency)),caller+' must not request raw CommonJS as ESM');
   assert.ok(imports.some(id=>id.includes('/deps/')&&path.basename(id.split('?')[0]).replaceAll('_','').includes(dependency.replace('.',''))),caller+' must use the actual prebundled dependency');
  }
  const metadataFile=path.join(server.config.cacheDir,'deps','_metadata.json');let metadata;
  const deadline=Date.now()+10000;while(Date.now()<deadline){try{metadata=JSON.parse(await fs.readFile(metadataFile,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(r=>setTimeout(r,20));}}
  assert.ok(metadata,'Vite must finish publishing its actual dependency optimizer output');
  const modules={};
  for(const filename of ['workblocks.cjs','document-semantics.cjs','conditional-saved-source.cjs']){
   const source=path.join(root,'desktop',filename),info=Object.values(metadata.optimized).find(row=>path.resolve(path.dirname(metadataFile),row.src)===source);
   assert.ok(info,'Normal app config must optimize '+filename);
   const file=path.resolve(path.dirname(metadataFile),info.file),built=await import(pathToFileURL(file).href);
   modules[filename]=built.default??built;
  }
  const blocks=modules['workblocks.cjs'];for(const name of ['captureWorkBlockCommand','decodeWorkBlockEnvelope','validateWorkBlockValue'])assert.equal(typeof blocks[name],'function',name);
  assert.throws(()=>blocks.captureWorkBlockCommand('invalid',{}),{code:'invalid_workblock_request'});
  const document=modules['document-semantics.cjs'];for(const name of ['captureDocumentRequest','decodeDocumentReply','createDesktopDocumentSemantics'])assert.equal(typeof document[name],'function',name);
  assert.deepEqual(document.captureDocumentRequest({schemaVersion:1,command:{op:'status'}}),{schemaVersion:1,command:{op:'status'}});
  assert.throws(()=>document.captureDocumentRequest({schemaVersion:1,command:{op:'invalid'}}),{code:'invalid_document_request'});
  const savedSource=modules['conditional-saved-source.cjs'];
  for(const name of ['captureSavedSourceGuard','captureSavedSourceWitness','captureSavedSourceId','captureSavedSourceValue'])assert.equal(typeof savedSource[name],'function',name);
  const witness={entryId:'note-entry',revision:'saved-revision',path:'Notes/A.md'},guard={captureId:'physical-capture',logicalWitness:witness};
  assert.deepEqual(savedSource.captureSavedSourceGuard(guard),guard);
  assert.deepEqual(savedSource.captureSavedSourceValue({...guard,source:'Original body.\n'},witness),{...guard,source:'Original body.\n'});
  assert.throws(()=>savedSource.captureSavedSourceGuard({...guard,source:'Unexpected source'}),{code:'invalid_saved_source'});
  assert.throws(()=>savedSource.captureSavedSourceValue({...guard,source:'Original body.\n'},{...witness,revision:'different-revision'}),{code:'invalid_saved_source'});
 }finally{await server?.close();await fs.rm(directory,{recursive:true,force:true});}
});
