import {captureWebRouteCommand,captureWebRouteProgress,captureWebRouteResult,captureWebRouteState} from './mobile-web-routing.ts';
import type {NativeWebRouting,WebRouteCommand,WebRouteProgress,WebRouteResult,WebRouteScope,WebRouteState} from './mobile-web-routing.ts';

export interface NativeWebRoutingPlugin {
  addListener(event:'webRouteCommand'|'webRouteProgress',handler:(input:unknown)=>void):Promise<{remove():Promise<void>}>;
  webRouteState(input:WebRouteState):Promise<void>;
  webRouteResult(input:WebRouteResult):Promise<void>;
}
export interface NativeWebRoutingChannel {
  readonly service:NativeWebRouting;
  close():Promise<void>;
}
interface FrameScheduler {request(run:()=>void):unknown;cancel(handle:unknown):void}
const scheduler:FrameScheduler={
  request:run=>typeof requestAnimationFrame==='function'?requestAnimationFrame(run):setTimeout(run,0),
  cancel:handle=>{if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(handle as number);else clearTimeout(handle as ReturnType<typeof setTimeout>);},
};
function immutableState(input:WebRouteState):WebRouteState{
  const state=captureWebRouteState(input);
  for(const tab of state.tabs){Object.freeze(tab.route);Object.freeze(tab);}Object.freeze(state.tabs);
  if(state.gesture)Object.freeze(state.gesture);return Object.freeze(state);
}

/** Presentation-only channel on an ALREADY admitted native client. Queues are
 * independent of the storage request queue. Native receipt is never web commit. */
export async function createNativeWebRoutingChannel(plugin:NativeWebRoutingPlugin,scope:WebRouteScope,isCurrent:()=>boolean,frames:FrameScheduler=scheduler):Promise<NativeWebRoutingChannel>{
  const pinnedScope=Object.freeze({...scope});let stopped=false,generation=0;
  let handler:((input:Readonly<WebRouteCommand>)=>Promise<void>)|undefined;
  let progressHandler:((input:Readonly<WebRouteProgress>)=>void)|undefined;
  let publication=Promise.resolve(),closePromise:Promise<void>|undefined;
  let session:string|undefined,acceptedGesture:string|undefined,latestState:string|undefined,acknowledgedState:string|undefined,acknowledgedVersion=-1n;
  let wantedVersion=-1n;
  const pendingResults=new Map<string,{key:string;packet:WebRouteResult;promise:Promise<void>;resolve:()=>void;reject:(error:Error)=>void}>();
  let sendingResults:Promise<void>|undefined;
  let repumpResults=false;
  let latestProgress:Readonly<WebRouteProgress>|undefined,frame:unknown;
  const calls=new Set<Promise<void>>();
  const admittedCommands=new Map<string,{fingerprint:string;finished:boolean;collision?:Promise<void>}>();
  const active=()=>!stopped&&isCurrent();
  const track=(task:Promise<void>)=>{calls.add(task);void task.finally(()=>calls.delete(task)).catch(()=>{});};
  const pumpResults=():Promise<void>=>{
    if(sendingResults){repumpResults=true;return sendingResults;}
    const task=Promise.resolve().then(async()=>{
      for(const [id,row]of pendingResults){
        if(!active())return;
        if(row.packet.status==='applied'&&(latestState!==acknowledgedState||BigInt(row.packet.version)>acknowledgedVersion))return;
        try{await plugin.webRouteResult(row.packet);}catch{return;} // Exact packet retained for an explicit retry.
        if(pendingResults.get(id)===row){pendingResults.delete(id);row.resolve();}
      }
    });
    sendingResults=task;void task.finally(()=>{
      if(sendingResults===task)sendingResults=undefined;
      if(repumpResults&&active()){repumpResults=false;void pumpResults();}
    }).catch(()=>{});return task;
  };
  const command=(input:unknown)=>{
    let captured:Readonly<WebRouteCommand>;try{captured=captureWebRouteCommand(input);}catch{return;}
    const owner=handler,epoch=generation;if(!active()||!owner)return;
    const key=`${captured.webSessionId}/${captured.id}`;
    const fingerprint=JSON.stringify(captured),prior=admittedCommands.get(key);
    if(prior){
      if(prior.fingerprint===fingerprint)return;
      // Same protocol policy as router replay collisions: explicitly stale,
      // without replacing or invoking the original command. One rejection task
      // per admitted ID bounds collision floods as well as ordinary admissions.
      if(!prior.collision){
        const task=publication.then(async()=>{
          if(active()&&epoch===generation&&session===captured.webSessionId)await plugin.webRouteResult({id:captured.id,webSessionId:captured.webSessionId,status:'stale',version:String(wantedVersion)});
        });
        prior.collision=task;track(task);
        void task.finally(()=>{if(prior.finished&&admittedCommands.get(key)===prior)admittedCommands.delete(key);}).catch(()=>{});
      }
      return;
    }
    // Backpressure is admission-only: overflow has no route side effect and no
    // synthetic receipt. Native retains the command ID for an exact retry.
    // Duplicates of an admitted command must not invoke its handler twice.
    if(admittedCommands.size>=128)return;
    const row={fingerprint,finished:false,collision:undefined as Promise<void>|undefined};
    admittedCommands.set(key,row);
    // The router owns its transaction queue; wrapping it in the storage or
    // publication queue would deadlock begin/end or source-flush admission.
    track(Promise.resolve().then(async()=>{
      try{if(active()&&epoch===generation&&handler===owner)await owner(captured);}
      finally{row.finished=true;if(!row.collision)admittedCommands.delete(key);else void row.collision.finally(()=>{if(admittedCommands.get(key)===row)admittedCommands.delete(key);}).catch(()=>{});}
    }));
  };
  const progress=(input:unknown)=>{
    let captured:Readonly<WebRouteProgress>;try{captured=captureWebRouteProgress(input);}catch{return;}
    if(!active()||!progressHandler||captured.webSessionId!==session||captured.gestureId!==acceptedGesture)return;
    // A newer accepted command decides gesture identity; never sort UUIDs.
    if(latestProgress&&latestProgress.gestureId===captured.gestureId&&BigInt(captured.sequence)<=BigInt(latestProgress.sequence))return;
    latestProgress=captured;
    if(frame!==undefined)return;
    const epoch=generation;
    frame=frames.request(()=>{frame=undefined;const latest=latestProgress;latestProgress=undefined;
      if(latest&&active()&&epoch===generation)progressHandler?.(latest);});
  };
  const commandListener=await plugin.addListener('webRouteCommand',command);
  let progressListener:{remove():Promise<void>};
  try{progressListener=await plugin.addListener('webRouteProgress',progress);}
  catch(error){await commandListener.remove();throw error;}
  const removers=[commandListener,progressListener].map(listener=>{
    let pending:Promise<void>|undefined;
    return()=>{if(pending)return pending;const task=listener.remove();pending=task;void task.catch(()=>{if(pending===task)pending=undefined;});return task;};
  });
  const service:NativeWebRouting={
    scope:pinnedScope,
    subscribe(next,onProgress){
      if(!active()||handler)throw new Error('Web routing subscription unavailable');
      handler=next;progressHandler=onProgress;
      return()=>{if(handler===next){generation++;handler=undefined;progressHandler=undefined;latestProgress=undefined;if(frame!==undefined){frames.cancel(frame);frame=undefined;}}};
    },
    publish(input){
      if(!active())return Promise.reject(new Error('Web routing host unavailable'));
      let state:WebRouteState;
      try{state=immutableState(input);if(state.localStoreId!==scope.localStoreId||state.clientId!==scope.clientId||session&&state.webSessionId!==session)throw new Error('Web routing scope changed');}
      catch(error){return Promise.reject(error);}
      const key=JSON.stringify(state),epoch=generation;
      const version=BigInt(state.version);
      if(version<wantedVersion||version===wantedVersion&&latestState!==key)return Promise.reject(new Error('Web routing state version regressed'));
      wantedVersion=version;
      session??=state.webSessionId;latestState=key;
      const task=publication.then(async()=>{
        if(!active()||epoch!==generation)throw new Error('Web routing publication retired');
        const version=BigInt(state.version);
        if(version<acknowledgedVersion||version===acknowledgedVersion&&acknowledgedState!==key)throw new Error('Web routing state version regressed');
        if(acknowledgedState===key)return;
        await plugin.webRouteState(state);
        if(!active()||epoch!==generation)throw new Error('Web routing receipt retired');
        acknowledgedVersion=version;acknowledgedState=key;acceptedGesture=state.gesture?.id;void pumpResults();
      });
      publication=task.catch(()=>{});track(task);return task;
    },
    result(input){
      let result:WebRouteResult;
      try{result=captureWebRouteResult(input);if(!active()||result.webSessionId!==session)throw new Error('Web routing result retired');}
      catch(error){return Promise.reject(error);}
      const key=JSON.stringify(result),prior=pendingResults.get(result.id);
      if(prior){if(prior.key!==key)return Promise.reject(new Error('Web routing result identity changed'));void publication.then(()=>pumpResults());return prior.promise;}
      if(pendingResults.size>=128)return Promise.reject(new Error('Web routing result limit'));
      let resolve!:()=>void,reject!:(error:Error)=>void;
      const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
      pendingResults.set(result.id,{key,packet:Object.freeze(result),promise,resolve,reject});
      // A committed web route stays committed when delivery fails. Hold its
      // native applied receipt until the LATEST authoritative state is received;
      // a failed receipt retains the exact result for publish/command retry.
      void publication.then(()=>pumpResults());track(promise);return promise;
    },
  };
  return{service,close(){
    if(closePromise)return closePromise;stopped=true;generation++;handler=undefined;progressHandler=undefined;latestProgress=undefined;
    if(frame!==undefined){frames.cancel(frame);frame=undefined;}
    for(const row of pendingResults.values())row.reject(new Error('Web routing result retired'));pendingResults.clear();
    closePromise=(async()=>{await Promise.all(removers.map(remove=>remove()));await Promise.allSettled([...calls]);await sendingResults;await publication;})();
    const task=closePromise;void task.catch(()=>{if(closePromise===task)closePromise=undefined;});
    return closePromise;
  }};
}
