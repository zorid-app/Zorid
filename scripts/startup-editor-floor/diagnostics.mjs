// Finalization may be requested before the renderer becomes ready. Join the
// single readiness probe explicitly; a missed fixed deadline remains missed.
export function createDiagnosticLatch(){
 let completeReady,readyTracked=false;
 const ready=new Promise(resolve=>{completeReady=resolve;}),pending=new Set();
 return{
  trackProbe(name,tasks){
   const completion=Promise.allSettled(tasks);pending.add(completion);
   void completion.then(()=>{pending.delete(completion);});
   if(name==='ready'&&!readyTracked){readyTracked=true;void completion.then(()=>completeReady());}
  },
  async finish(startup){
   const initial=await startup;if(initial)await ready;
   while(pending.size)await Promise.all([...pending]);
   return initial;
  },
 };
}
