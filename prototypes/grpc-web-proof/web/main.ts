import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ProofService } from '../gen/zorid/prototype/grpcproof/v1/proof_pb.js';
const client=createClient(ProofService,createGrpcWebTransport({baseUrl:'http://127.0.0.1:8792',useBinaryFormat:true,defaultTimeoutMs:10_000}));
const button=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector<HTMLElement>('#status')!,results=document.querySelector<HTMLElement>('#results')!;
const log=(text:string)=>{results.textContent+=text+'\n';};
const check=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const sha=async(bytes:Uint8Array)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer));
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
async function errorCode(action:()=>Promise<unknown>,expected:Code,label:string){try{await action();throw new Error(label+' unexpectedly succeeded');}catch(error){if(!(error instanceof ConnectError)||error.code!==expected)throw error;log('PASS '+label+' → '+Code[error.code]+': '+error.rawMessage);}}
button.addEventListener('click',()=>{void run();});
async function run(){
  button.disabled=true;status.textContent='Running';results.textContent='';
  try{
    const suffix=crypto.randomUUID(),ciphertext=new Uint8Array(128*1024);
    for(let i=0;i<ciphertext.length;i++)ciphertext[i]=(i*31+17)%256;
    const digest=await sha(ciphertext),operationId='browser-'+suffix;
    const input={operationId,ciphertext,sha256:digest};
    const accepted=await client.put(input),download=await client.get({operationId});
    check(download.receipt&&accepted.length===BigInt(ciphertext.length)&&same(download.ciphertext,ciphertext)&&same(await sha(download.ciphertext),digest)&&same(download.receipt.sha256,digest),'128KiB bytes or digest differ');
    log('PASS binary protobuf 131072 bytes upload/download exact SHA256 '+hex(digest));
    const retry=await client.put(input);check(retry.sequence===accepted.sequence&&retry.appliedCount===1,'retry applied more than once');log('PASS identical operation retry retains sequence '+retry.sequence+' and applied_count=1');
    const wrong=ciphertext.slice();wrong[0]^=1;
    await errorCode(()=>client.put({...input,ciphertext:wrong,sha256:digest}),Code.InvalidArgument,'wrong ciphertext hash');
    await errorCode(()=>client.put({...input,ciphertext:wrong,sha256:new Uint8Array(32)}),Code.InvalidArgument,'malformed digest');
    const changedDigest=await sha(wrong);
    await errorCode(()=>client.put({...input,ciphertext:wrong,sha256:changedDigest}),Code.AlreadyExists,'same operation with changed bytes');
    const tooLarge=new Uint8Array(128*1024+1),oversized='oversize-'+suffix,tooLargeDigest=await sha(tooLarge);
    await errorCode(()=>client.put({operationId:oversized,ciphertext:tooLarge,sha256:tooLargeDigest}),Code.ResourceExhausted,'128KiB+1 size rejection');
    await errorCode(()=>client.query({operationId:oversized}),Code.NotFound,'oversized operation remains absent');
    await errorCode(()=>client.query({operationId:'missing-'+suffix}),Code.NotFound,'missing operation');
    const lost={operationId:'lost-'+suffix,ciphertext,sha256:digest,suppressFirstReceipt:true};
    await errorCode(()=>client.put(lost),Code.Unavailable,'intentionally suppressed first receipt');
    const observed=await client.query({operationId:lost.operationId}),recovered=await client.put(lost);
    check(observed.sequence===recovered.sequence&&recovered.appliedCount===1&&same(recovered.sha256,digest),'lost receipt retry changed identity');
    log('PASS suppressed receipt query + exact retry same sequence '+recovered.sequence+'; transport failure did not roll back');
    const abort=new AbortController();let timer=setTimeout(()=>abort.abort(),100);
    try{await errorCode(()=>client.wait({delayMs:5000},{signal:abort.signal}),Code.Canceled,'AbortSignal cancellation');}finally{clearTimeout(timer);}
    const cancel=new AbortController(),delayed={operationId:'cancel-'+suffix,ciphertext,sha256:digest,firstResponseDelayMs:3000};
    const outcome=client.put(delayed,{signal:cancel.signal}).then(()=>null,error=>error);
    let committed:Awaited<ReturnType<typeof client.query>>|undefined;
    for(let attempt=0;attempt<30;attempt++){
      try{committed=await client.query({operationId:delayed.operationId});break;}catch(error){if(!(error instanceof ConnectError)||error.code!==Code.NotFound)throw error;await new Promise(resolve=>setTimeout(resolve,30));}
    }
    check(committed,'delayed operation never became queryable before cancellation');cancel.abort();
    const canceled=await outcome;check(canceled instanceof ConnectError&&canceled.code===Code.Canceled,'delayed response not canceled');
    const afterCancel=await client.put(delayed);check(afterCancel.sequence===committed!.sequence&&afterCancel.appliedCount===1,'cancellation retry changed receipt');
    log('PASS cancel after observed acceptance → Canceled, exact retry sequence '+afterCancel.sequence+'; cancellation is not rollback');
    status.textContent='PASS — all compatibility checks';log('LIMIT: in-memory transport proof; no durable ledger, server restart, authentication, E2EE or production integration established.');
  }catch(error){status.textContent='FAIL';log(error instanceof Error?error.stack??error.message:String(error));}
  finally{button.disabled=false;}
}
