import {rm,stat} from 'node:fs/promises';
const stamp=()=>new Date().toISOString();
const describe=error=>String(error?.stack??error);
/** Attach immediately after spawn; raw events identify this exact owned child. */
export function observeOwnedChild(child){
  const receipt={pid:child.pid??null,events:[]};
  child.once('spawn',()=>{receipt.pid=child.pid??null;receipt.events.push({event:'spawn',pid:receipt.pid,at:stamp()});});
  child.once('error',error=>receipt.events.push({event:'error',message:describe(error),at:stamp()}));
  child.once('exit',(code,signal)=>{receipt.exit={code,signal,at:stamp()};receipt.events.push({event:'exit',...receipt.exit});});
  child.once('close',(code,signal)=>{receipt.close={code,signal,at:stamp()};receipt.events.push({event:'close',...receipt.close});});
  return receipt;
}
async function exitWithin(child,receipt,ms){
  if(receipt.exit)return;
  await new Promise(resolve=>{
    let timer;
    const finish=()=>{clearTimeout(timer);child.removeListener('exit',finish);resolve();};
    child.once('exit',finish);timer=setTimeout(finish,ms);
  });
}
async function bounded(action,ms){
  let timer;
  try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned cleanup deadline')),ms);})]);}
  finally{clearTimeout(timer);}
}
/** No process-name/port killing. Only the supplied owned child/profile/server.
 * All cleanup branches run even after another fails; receipts never erase failure. */
export async function cleanupOwnedResources({chrome,childReceipt,profile,server,cdp,exitWaitMs=4000,serverWaitMs=10000}){
  const result={startedAt:stamp(),chrome:{pid:chrome?.pid??null,signals:[],confirmedExit:false,status:chrome?'unverified':'not_started'},profile:{path:profile,removed:false,status:'pending'},vite:{created:!!server,closeResolved:false,status:server?'pending':'not_started'},cdp:{created:!!cdp,closeRequested:false},failures:[]};
  const failed=(resource,error)=>result.failures.push({resource,message:describe(error),at:stamp()});
  try{cdp?.close();result.cdp.closeRequested=!!cdp;}catch(error){failed('cdp',error);}
  let noOwnedProcess=!chrome;
  if(chrome){
    const raw=childReceipt??{pid:chrome.pid??null,events:[]};result.chrome.raw=raw;
    try{
      const neverSpawned=chrome.pid===undefined&&raw.events.some(event=>event.event==='error');
      noOwnedProcess=neverSpawned;
      if(neverSpawned)result.chrome.status='spawn_failed_no_pid';
      else{
        if(!raw.exit&&chrome.exitCode===null&&chrome.signalCode===null)for(const signal of ['SIGTERM','SIGKILL']){
          const attempt={signal,pid:chrome.pid??null,at:stamp()};result.chrome.signals.push(attempt);
          try{attempt.killReturned=chrome.kill(signal);}catch(error){attempt.error=describe(error);}
          await exitWithin(chrome,raw,exitWaitMs);if(raw.exit)break;
        }
        result.chrome.exitCode=chrome.exitCode;result.chrome.signalCode=chrome.signalCode;
        result.chrome.confirmedExit=!!raw.exit&&raw.exit.code===chrome.exitCode&&raw.exit.signal===chrome.signalCode;
        result.chrome.status=result.chrome.confirmedExit?'exit_event_confirmed':'exit_unverified';
        noOwnedProcess=result.chrome.confirmedExit;
        if(!noOwnedProcess)failed('chrome',new Error('Exact owned Chrome PID exit event not confirmed; profile retained'));
      }
    }catch(error){failed('chrome',error);}
  }
  if(server){
    const http=server.httpServer;
    result.vite.addressBefore=http?.address?.()??null;
    try{
      await bounded(()=>server.close(),serverWaitMs);result.vite.closeResolved=true;
      result.vite.httpListeningAfter=http?.listening??null;
      if(http?.listening)throw new Error('Owned Vite close resolved while its HTTP server still listens');
      result.vite.status='close_confirmed';result.vite.closedAt=stamp();
    }catch(error){
      result.vite.status='close_failed';failed('vite',error);
      // Preserve failure while still attempting to stop only this owned listener.
      try{http?.closeAllConnections?.();http?.close?.();result.vite.fallbackHttpCloseAttempted=!!http;}catch(fallback){failed('vite-http-fallback',fallback);}
    }
  }
  if(!noOwnedProcess)result.profile.status='retained_unconfirmed_child';
  else if(profile){
    try{
      await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      try{await stat(profile);throw new Error('Owned profile still exists after removal');}
      catch(error){if(error?.code!=='ENOENT')throw error;result.profile.absenceErrorCode=error.code;}
      result.profile.removed=true;result.profile.status='absence_confirmed';result.profile.removedAt=stamp();
    }catch(error){result.profile.status='removal_failed';failed('profile',error);}
  }else result.profile.status='not_created';
  result.finishedAt=stamp();return structuredClone(result);
}
