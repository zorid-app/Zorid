// Bounded CDP client for an owned loopback Electron debugger only.
export class CDP {
  constructor(url){
    const parsed=new URL(url);if(parsed.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(parsed.hostname))throw Error('Only owned loopback CDP');
    this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.events=[];
    this.opened=new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});
    this.ws.addEventListener('message',event=>{
      const value=JSON.parse(event.data);
      if(value.id){const pending=this.pending.get(value.id);if(!pending)return;this.pending.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(Error(JSON.stringify(value.error))):pending.resolve(value.result);}
      else if(this.events.length<1000&&(['Runtime.exceptionThrown','Log.entryAdded','Inspector.detached'].includes(value.method)||value.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(value.params.type)))this.events.push(value);
    });
    this.ws.addEventListener('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Owned CDP closed'));}this.pending.clear();});
  }
  async call(method,params={}){
    await this.opened;const id=++this.next;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP deadline: '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});
  }
  async evaluate(expression){
    const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(reply.exceptionDetails)throw Error('Renderer evaluation failed: '+JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  close(){this.ws.close();}
}
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(action,timeout=15000){const end=Date.now()+timeout;let last;do{try{return await action();}catch(error){last=error;}await delay(100);}while(Date.now()<end);throw last??Error('Bounded wait expired');}
