import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformAdapter } from '../src/platform/index.ts';

for (const lateOutcome of ['success', 'terminal rejection']) {
  test(`late duplicate ${lateOutcome} preserves a newer uncertain operation ID`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls: { request: any; resolve: () => void; reject: (error: unknown) => void }[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { zorid: {
      getVault: async () => ({ path: '/fixture', name: 'Fixture' }),
      getDurableContext: async () => ({ admissionId: 'admitted', scope: { vaultId: 'authority', clientId: 'client' } }),
      releaseDurableContext: async () => {},
      durableInvoke: (_path: string, _admission: string, method: string, args: unknown[]) => {
        assert.equal(method, 'fileCommand');
        return new Promise<void>((resolve, reject) => calls.push({ request: args[0], resolve, reject }));
      },
    } } });
    try {
      const { adapter } = (await createPlatformAdapter())!;
      const first = adapter.write('Note.md', 'A');
      const duplicate = adapter.write('Note.md', 'A');
      assert.equal(calls[0].request.operationId, calls[1].request.operationId);
      calls[0].resolve(); await first;
      const next = adapter.write('Note.md', 'B');
      const nextId = calls[2].request.operationId;
      assert.notEqual(nextId, calls[0].request.operationId);
      if (lateOutcome === 'success') { calls[1].resolve(); await duplicate; }
      else {
        const rejected = assert.rejects(duplicate, { code: 'revision_conflict' });
        calls[1].reject(Object.assign(new Error('Old request rejected'), { code: 'revision_conflict', commitUncertain: false }));
        await rejected;
      }
      const uncertain = assert.rejects(next, { code: 'host_timeout' });
      calls[2].reject(Object.assign(new Error('ACK unknown'), { code: 'host_timeout', commitUncertain: true }));
      await uncertain;
      const retry = adapter.write('Note.md', 'B');
      calls[3].resolve(); await retry;
      assert.equal(calls[3].request.operationId, nextId);
      assert.equal(calls[3].request.entryId, calls[2].request.entryId);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

test('desktop reconciliation status catches subscription gaps and remains scoped through retry',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const initial={scanId:'startup',complete:true,scanComplete:true,finished:true,observed:0,imported:0,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[]};
  const pending={...initial,scanId:'pending',complete:false,scanComplete:false,issueCount:1,issues:[{path:null,code:'scan_limit'}]};
  let listener:(change:any)=>void=()=>{},stops=0,reads=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/fixture',name:'Fixture',reconciliation:reads++?pending:initial}),
    onChange:(next:(change:any)=>void)=>{listener=next;return ()=>{stops++;};},
    retryReconciliation:async(root:string)=>{assert.equal(root,'/fixture');return initial;},
  }}});
  try {
    const vault=(await createPlatformAdapter())!;const statuses:unknown[]=[];
    assert.equal(vault.reconciliation!.getStatus()!.complete,true);
    const stop=vault.reconciliation!.subscribe(status=>statuses.push(status));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(vault.reconciliation!.getStatus()!.scanId,'pending');
    listener({vault:'/other',reconciliation:initial});assert.equal(statuses.length,1);
    listener({vault:'/fixture',reconciliation:{...pending,scanId:'current'}});assert.equal(vault.reconciliation!.getStatus()!.scanId,'current');
    await vault.reconciliation!.retry();assert.equal(vault.reconciliation!.getStatus()!.complete,true);
    stop();assert.equal(stops,1);
  } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
