'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createEditorCoreManager}=require('../desktop/editor-core.cjs');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const executable=process.env.ZORID_TEST_DESKTOP_HOST;

test('native host death after checkpoint commit recovers the identical CAS and prepared operation', {skip:!executable,timeout:20000},async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-admission-recovery-')));
  let manager;
  try{
    await fs.writeFile(path.join(root,'One.md'),'Original one\n');await fs.writeFile(path.join(root,'Two.md'),'Original two\n');
    manager=createEditorCoreManager({ZORID_DESKTOP_HOST_BIN:executable},{documentRuntime:true,onDocumentRuntimeNudge(){}});
    const broker=new WindowBroker({openVault:directory=>manager.open(directory),allowedURL:()=>true});
    const record=broker.register({webContents:{id:1,mainFrame:{url:'https://zorid.test/'},isDestroyed:()=>false,send(){}},isDestroyed:()=>false});
    record.clientSlot={clientId:randomUUID()};await broker.select(record,root);record.persistedVaultRoot=root;
    const first=await manager.context(broker,record,root),event={sender:record.window.webContents,senderFrame:record.window.webContents.mainFrame};
    const invoke=(binding,method,...args)=>manager.invoke(broker,record,event,root,binding.admissionId,method,args);
    const source=await invoke(first,'readText','One.md'),operationId=randomUUID();
    const plan=await invoke(first,'planWrite',{operationId,path:source.path,expectedEntryId:source.entryId,expectedRevision:source.revision,expectedContent:source.content,content:'Retained private fixture draft\n'});
    const prepared=await invoke(first,'prepare',plan);
    const originalChange={key:'test/recovery',expectedRevision:null,nextRevision:randomUUID(),encodedState:JSON.stringify({draft:'Retained private fixture draft\n',operation:prepared.ref})};
    const host=record.vault.service.host,request=host.request.bind(host);let injected=false;
    host.request=async(...args)=>{
      const reply=await request(...args);
      if(args[0].method==='checkpoint_cas'&&!injected){injected=true;const error=Object.assign(new Error('Fixture lost checkpoint reply'),{code:'host_exited',commitUncertain:true});host.abort(error);throw error;}
      return reply;
    };
    await assert.rejects(invoke(first,'checkpoints.compareAndSwap',originalChange),{code:'host_exited',commitUncertain:true});
    await host.exit;await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(invoke(first,'planWrite',{operationId:randomUUID(),path:source.path,expectedEntryId:source.entryId,expectedRevision:source.revision,expectedContent:source.content,content:'Must not reach old host'}),{code:'client_not_admitted'});
    const next=await manager.recover(broker,record,event,root,first.admissionId);
    assert.notEqual(next.admissionId,first.admissionId);assert.deepEqual(next.scope,first.scope);assert.notEqual(record.vault.service.host,host);
    const retained=await invoke(next,'checkpoints.load',originalChange.key);
    assert.equal(retained.revision,originalChange.nextRevision);assert.equal(retained.encodedState,originalChange.encodedState);
    const settled=await invoke(next,'checkpoints.compareAndSwap',originalChange);
    assert.equal(settled.revision,originalChange.nextRevision);assert.equal(settled.encodedState,originalChange.encodedState);
    const intent=await invoke(next,'query',prepared.ref);assert.equal(intent.state,'prepared');assert.deepEqual(intent.ref,prepared.ref);assert.equal(intent.ref.operationId,operationId);
    assert.equal(await fs.readFile(path.join(root,'One.md'),'utf8'),'Original one\n','Recovery never blindly commits pending note intent');
    await manager.release(broker,record,event,root,first.admissionId);
    assert.equal((await manager.context(broker,record,root)).admissionId,next.admissionId,'Late old cleanup cannot release replacement');
    await manager.release(broker,record,event,root,next.admissionId);
  }finally{await manager?.close();await fs.rm(root,{recursive:true,force:true});}
});
