import {assert} from './assertions.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Parent-side tap observes the exact Worker made by BrowserCoreRuntime. Only
 * fault lifecycle messages (release/refresh) may be injected; no authoring RPC. */
export function observeNormalWorkers(channelName){
  const channel=new BroadcastChannel(channelName),events=[],workers=[];
  channel.onmessage=({data})=>{events.push(data);};
  const NativeWorker=globalThis.Worker;
  globalThis.Worker=new Proxy(NativeWorker,{construct(Target,args){
    assert(new URL(String(args[0]),location.href).pathname.endsWith('/browser-core-worker.ts'),'Unexpected worker in bounded normal-runtime proof');
    const worker=Reflect.construct(Target,args);
    const entry={worker,ended:false,database:null,clientId:null,pending:new Map()};workers.push(entry);
    const nativePost=worker.postMessage.bind(worker),nativeTerminate=worker.terminate.bind(worker);
    worker.postMessage=(data,...rest)=>{
      if(data?.operation==='open'){entry.database=data.payload.database;entry.clientId=data.payload.clientId;}
      return nativePost(data,...rest);
    };
    worker.terminate=()=>{entry.ended=true;for(const pending of entry.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Injected lifecycle lost with Worker termination'));}entry.pending.clear();return nativeTerminate();};
    worker.addEventListener('message',({data})=>{
      const pending=entry.pending.get(data?.id);if(!pending)return;
      entry.pending.delete(data.id);clearTimeout(pending.timer);
      data.ok?pending.resolve(data.result):pending.reject(Object.assign(new Error('Normal injected lifecycle rejected'),data.error));
    });
    entry.inject=operation=>{
      assert(['release-client','refresh'].includes(operation),'Semantic authoring injection is forbidden');
      const id='proof-lifecycle-'+crypto.randomUUID();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{entry.pending.delete(id);reject(new Error('Injected lifecycle deadline'));},15000);
        entry.pending.set(id,{resolve,reject,timer});nativePost({id,operation});
      });
    };
    return worker;
  }});
  async function until(predicate,label,timeout=15000){
    const deadline=performance.now()+timeout;
    while(performance.now()<deadline){const result=predicate();if(result)return result;await pause(10);}
    throw new Error('Observer deadline: '+label);
  }
  const matches=(host,event)=>event.database===host.name&&event.clientId===host.clientId;
  const entry=host=>{const result=[...workers].reverse().find(item=>item.database===host.name&&item.clientId===host.clientId&&!item.ended);assert(result,'Normal runtime Worker tap absent');return result;};
  async function command(host,action,extra={}){
    const request=crypto.randomUUID();channel.postMessage({database:host.name,clientId:host.clientId,request,action,...extra});
    return until(()=>events.find(event=>matches(host,event)&&event.event==='control-ack'&&event.request===request),'control '+action);
  }
  return {events,workers,matches,until,command,
    event(host,name,after=0,extra=()=>true){return until(()=>events.slice(after).find(event=>matches(host,event)&&event.event===name&&extra(event)),name);},
    inject:(host,operation)=>entry(host).inject(operation),
    transactions(host,operation){return events.filter(event=>matches(host,event)&&event.event==='transaction'&&event.witness.mode==='readwrite'&&(operation===undefined||event.witness.operation===operation)).map(event=>event.witness);},
    async inspect(host){const index=events.length;await command(host,'inspect');return this.event(host,'transactions',index);},
    cleanup(){globalThis.Worker=NativeWorker;for(const item of workers)if(!item.ended)item.worker.terminate();channel.close();},
  };
}
