import {captureWebRoute,captureWebRouteCommand,webRouteToken,webRouteUUID,webRouteVersion} from '../platform/mobile-web-routing.ts';
import type {WebRoute,WebDocumentRoute,WebRouteCommand,WebRouteProgress,WebRouteResult,WebRouteScope,WebRouteState} from '../platform/mobile-web-routing.ts';
import type {MobileDocumentView,MobileViewLoan} from './mobile-document-view-window.ts';
import {MobileDocumentViewWindow} from './mobile-document-view-window.ts';

interface Visit {id:string;route:WebRoute}
interface RouterTab {id:string;visits:Visit[];cursor:number}
interface Model {selectedTabId:string;tabs:RouterTab[]}
interface Gesture {id:string;loan:MobileViewLoan;tabId:string;targetIndex:number;sequence:bigint;direction:-1|1}
export interface MobileWebRouterHost {
  /** Scene/vault/client ownership, never a native document-history cursor. */
  isCurrent():boolean;
  /** Native presentation receipts cannot authorize or roll back web state. */
  publish(state:WebRouteState):Promise<void>;
  /** Existing safe create path; request ID makes duplicate callbacks inert. */
  createNote?(requestId:string,check:()=>void):Promise<string>;
  /** Persist web-owned bounded metadata, never bodies, undo or native authority. */
  save?(encoded:string):void;
}
const MAX_VERSION=18446744073709551615n;
const home=():Visit=>({id:crypto.randomUUID(),route:{kind:'home'}});
const newTab=():RouterTab=>({id:crypto.randomUUID(),visits:[home()],cursor:0});
const copy=<T>(value:T):T=>structuredClone(value);

/** Web is the only document tab/history authority. Native commands carry
 * receipts, not prospective native cursor/model commits. One queue serializes
 * navigation, separately from storage and resultless animation progress. */
export class MobileWebRouter<V extends MobileDocumentView> {
  readonly webSessionId=crypto.randomUUID();
  readonly scope:Readonly<WebRouteScope>;
  private model:Model;
  private version=0n;
  private status:WebRouteState['status']='busy';
  private gesture?:Gesture;
  private tail:Promise<void>=Promise.resolve();
  private generation=0;
  private paused=false;
  private closed=false;
  private closing=false;
  private started=false;
  private presentation:WebRouteState['presentation']='editor';
  private publication:Promise<void>=Promise.resolve();
  private lastPublished?:string;
  private results=new Map<string,{key:string;promise:Promise<WebRouteResult>;settled:boolean}>();
  private window:MobileDocumentViewWindow<V>;
  private host:MobileWebRouterHost;
  constructor(scope:WebRouteScope,window:MobileDocumentViewWindow<V>,host:MobileWebRouterHost,restored?:string){
    this.window=window;this.host=host;
    if(!webRouteToken(scope.localStoreId)||!webRouteUUID(scope.clientId))throw new Error('Invalid router scope');
    this.scope=Object.freeze({...scope});
    const tab=newTab();this.model=restored?this.restore(restored):{selectedTabId:tab.id,tabs:[tab]};
  }
  private selected(model=this.model):RouterTab{return model.tabs.find(tab=>tab.id===model.selectedTabId)!;}
  private current(tab=this.selected()):Visit{return tab.visits[tab.cursor];}
  private check(generation=this.generation):void{
    if(this.closed||this.closing||this.paused||generation!==this.generation||!this.host.isCurrent())throw new Error('Stale web router');
  }
  snapshot():WebRouteState{
    return copy({...this.scope,webSessionId:this.webSessionId,version:String(this.version),status:this.window.blocked?'blocked':this.status,presentation:this.presentation,
      selectedTabId:this.model.selectedTabId,tabs:this.model.tabs.map(tab=>{
        const route=this.current(tab).route;
        return{id:tab.id,title:route.kind==='home'?'Home':route.path.split('/').at(-1)!.replace(/\.md$/i,''),route,
          canBack:tab.cursor>0,canForward:tab.cursor+1<tab.visits.length};
      }),...(this.gesture?{gesture:{id:this.gesture.id,direction:this.gesture.direction,phase:'tracking' as const}}:{})});
  }
  private async publish():Promise<void>{
    const state=this.snapshot(),key=JSON.stringify(state);
    const task=this.publication.then(async()=>{if(this.lastPublished===key)return;await this.host.publish(state);this.lastPublished=key;});
    this.publication=task.catch(()=>{});await task;
  }
  /** Publication failure leaves committed state dirty for later retry. */
  async republish():Promise<void>{await this.publish();}
  private commit(model:Model):void{
    this.check();if(this.version===MAX_VERSION)throw new Error('Router version exhausted');
    this.host.save?.(this.encode(model)); // Fallible persistence precedes commit.
    this.model=model;this.version++; // No fallible work after this logical commit.
  }
  private advancePresentation():void{if(this.version===MAX_VERSION)throw new Error('Router version exhausted');this.version++;}
  private enqueue<T>(run:()=>Promise<T>):Promise<T>{
    const task=this.tail.then(run);this.tail=task.then(()=>{},()=>{});return task;
  }
  async start():Promise<void>{
    if(this.started)return;this.started=true;
    await this.enqueue(async()=>{
      this.check();await this.activate(copy(this.model),this.model.selectedTabId,this.selected().cursor);this.status='ready';
      await this.prewarm();await this.publish();
    });
  }
  private async prewarm():Promise<void>{
    if(this.gesture||this.paused||this.closed)return;
    const tab=this.selected(),visits=tab.visits.slice(Math.max(0,tab.cursor-1),tab.cursor+2)
      .filter((visit):visit is Visit&{route:WebDocumentRoute}=>visit.route.kind==='document')
      .map(visit=>({id:visit.id,entryId:visit.route.entryId}));
    try{await this.window.prepare(visits);}catch{this.status='blocked';}
  }
  private async activate(model:Model,tabId:string,index:number,requestId:string=crypto.randomUUID()):Promise<void>{
    const generation=this.generation,check=()=>this.check(generation),tab=model.tabs.find(tab=>tab.id===tabId);
    if(!tab||index<0||index>=tab.visits.length)throw new Error('Unavailable web route');
    const visit=tab.visits[index];model.selectedTabId=tabId;tab.cursor=index;
    if(visit.route.kind==='home'){await this.window.home(()=>{check();this.commit(model);this.presentation='native';});return;}
    // Selecting an already-active route changes only logical tab metadata; no
    // editor reconstruction, duplicate writer, or fake traversal is required.
    if(this.window.currentVisitId===visit.id){await this.window.setPresentation(true,route=>{check();if(route)visit.route=route;this.commit(model);this.presentation='editor';});return;}
    const loan=await this.window.begin(requestId,{id:visit.id,entryId:visit.route.entryId},1);check();
    await this.window.commit(loan,route=>{check();visit.route=route;this.commit(model);this.presentation='editor';});
  }
  private async cancelGesture():Promise<void>{
    const gesture=this.gesture;this.gesture=undefined;if(gesture&&this.window.hasLoan)await this.window.cancel(gesture.loan);
  }
  async dispatch(input:unknown):Promise<WebRouteResult>{
    const command=captureWebRouteCommand(input),key=JSON.stringify(command),prior=this.results.get(command.id);
    if(prior){if(prior.key!==key)return this.result(command,'stale');return prior.promise;}
    if(this.results.size>=128){const expired=[...this.results].find(([,row])=>row.settled);if(expired)this.results.delete(expired[0]);else return this.result(command,'failed');}
    const row={key,promise:Promise.resolve(undefined as unknown as WebRouteResult),settled:false};
    row.promise=this.enqueue(()=>this.execute(command));this.results.set(command.id,row);
    void row.promise.finally(()=>{row.settled=true;}).catch(()=>{});return row.promise;
  }
  private result(command:Readonly<WebRouteCommand>,status:WebRouteResult['status']):WebRouteResult{
    return{id:command.id,webSessionId:this.webSessionId,status,version:String(this.version)};
  }
  private async execute(command:Readonly<WebRouteCommand>):Promise<WebRouteResult>{
    const before=this.version,generation=this.generation,priorStatus=this.status;
    let status:WebRouteResult['status']='applied';
    try{
      this.check();if(command.webSessionId!==this.webSessionId||'expectedVersion'in command&&BigInt(command.expectedVersion)!==this.version)return this.result(command,'stale');
      this.status='busy';const action=command.action;
      if(action.type==='gestureEnd'){
        const gesture=this.gesture;
        if(!gesture||gesture.id!==action.gestureId||BigInt(action.sequence)<=gesture.sequence){this.status=priorStatus;return this.result(command,'stale');}
        gesture.sequence=BigInt(action.sequence);
        if(action.decision==='cancel'){await this.cancelGesture();this.advancePresentation();status='cancelled';}
        else{
          const model=copy(this.model),tab=model.tabs.find(tab=>tab.id===gesture.tabId)!;
          tab.cursor=gesture.targetIndex;
          await this.window.commit(gesture.loan,route=>{this.check(generation);tab.visits[tab.cursor].route=route;this.commit(model);this.presentation='editor';});
          this.gesture=undefined;
        }
      }else if(action.type==='gestureBegin'){
        if(this.presentation!=='editor')throw new Error('Editor presentation is hidden');
        if(this.gesture)throw new Error('Gesture already pending');
        const tab=this.selected(),index=tab.cursor+action.direction,visit=tab.visits[index];
        if(!visit||visit.route.kind!=='document')throw new Error('No prepared adjacent document');
        const loan=await this.window.begin(action.gestureId,{id:visit.id,entryId:visit.route.entryId},action.direction);this.check(generation);
        this.gesture={id:action.gestureId,loan,tabId:tab.id,targetIndex:index,sequence:-1n,direction:action.direction};
        this.advancePresentation();
      }else{
        await this.cancelGesture();const model=copy(this.model),selected=this.selected(model);
        switch(action.type){
          case 'setPresentation':{
            await this.window.setPresentation(action.surface==='editor',route=>{
              this.check(generation);if(route)this.current(selected).route=route;
              this.commit(model);this.presentation=action.surface;
            });break;
          }
          case 'newTab':{if(model.tabs.length>=64)throw new Error('Tab limit reached');const tab=newTab();model.tabs.push(tab);await this.activate(model,tab.id,0,command.id);break;}
          case 'showHome':{selected.visits=selected.visits.slice(0,selected.cursor+1);selected.visits.push(home());this.boundHistory(selected);await this.activate(model,selected.id,selected.visits.length-1,command.id);break;}
          case 'selectTab':{const tab=model.tabs.find(tab=>tab.id===action.tabId);if(!tab)throw new Error('Tab missing');await this.activate(model,tab.id,tab.cursor,command.id);break;}
          case 'closeTab':{
            const index=model.tabs.findIndex(tab=>tab.id===action.tabId);if(index<0)throw new Error('Tab missing');
            const wasCurrent=model.selectedTabId===action.tabId;model.tabs.splice(index,1);
            if(!model.tabs.length)model.tabs.push(newTab());
            if(wasCurrent){const target=model.tabs[Math.min(index,model.tabs.length-1)];await this.activate(model,target.id,target.cursor,command.id);}else this.commit(model);break;
          }
          case 'traverse':await this.activate(model,selected.id,selected.cursor+action.direction,command.id);break;
          case 'open':case 'createNote':{
            if(action.type==='open'&&action.disposition==='newTab'&&model.tabs.length>=64)throw new Error('Tab limit reached');
            let entryId:string;
            if(action.type==='createNote'){
              if(!this.host.createNote)throw new Error('Note creation unavailable');
              await this.window.drain();this.check(generation);entryId=await this.host.createNote(command.id,()=>this.check(generation));this.check(generation);
            }else entryId=action.entryId;
            const tab=action.type==='open'&&action.disposition==='newTab'?newTab():selected;
            if(tab!==selected)model.tabs.push(tab);
            // Route display metadata is resolved by immutable admission; this
            // provisional value is never committed or published.
            const visit:Visit={id:crypto.randomUUID(),route:{kind:'document',entryId,path:'pending.md',revision:'pending',recovery:'none'}};
            tab.visits=tab.visits.slice(0,tab.cursor+1);tab.visits.push(visit);this.boundHistory(tab);
            await this.activate(model,tab.id,tab.visits.length-1,command.id);break;
          }
        }
      }
      this.status='ready';if(!this.gesture)await this.prewarm();
    }catch{
      // Once logical commit happened, failed publication/interaction cannot
      // reclassify it as failed, stale, or cancelled.
      if(this.version!==before){status='applied';this.status='blocked';}
      else{status=this.closed||this.paused||generation!==this.generation?'stale':'failed';this.status='blocked';
        try{await this.cancelGesture();if(!this.paused&&!this.closed&&generation===this.generation)await this.window.resume();}catch{/* Keep writer fenced. */}
        this.advancePresentation();}
    }
    try{await this.publish();}catch{/* Retain latest state for receipt retry. */}
    return this.result(command,status);
  }
  private boundHistory(tab:RouterTab):void{if(tab.visits.length>100)tab.visits.splice(0,tab.visits.length-100);tab.cursor=Math.min(tab.cursor,tab.visits.length-1);}
  progress(input:Readonly<WebRouteProgress>):boolean{
    if(this.closed||this.paused||input.webSessionId!==this.webSessionId||!this.gesture||input.gestureId!==this.gesture.id||!webRouteVersion(input.sequence))return false;
    const sequence=BigInt(input.sequence);if(sequence<=this.gesture.sequence)return false;
    try{const applied=this.window.progress(this.gesture.loan,sequence,input.fraction);if(applied)this.gesture.sequence=sequence;return applied;}catch{return false;}
  }
  /** Ordinary web links supersede a gesture without waiting for its old end. */
  async followEntry(entryId:string):Promise<WebRouteResult>{
    if(!webRouteToken(entryId))throw new Error('Invalid document identity');
    this.generation++;this.window.invalidate();this.gesture=undefined;
    return this.enqueue(()=>this.execute({id:crypto.randomUUID(),webSessionId:this.webSessionId,expectedVersion:String(this.version),action:{type:'open',entryId,disposition:'current'}}));
  }
  /** Invalidate first; drain admitted navigation/cleanup before lifecycle ACK. */
  drain():Promise<void>{
    this.paused=true;this.generation++;this.window.invalidate();this.gesture=undefined;
    // The ENTIRE flush/publication owns the shared tail. Awaiting the old tail
    // and flushing outside it would let resume overtake a still-active drain.
    return this.enqueue(async()=>{await this.window.drain();this.status='busy';this.advancePresentation();await this.publish();});
  }
  resume():Promise<void>{
    const generation=this.generation;
    return this.enqueue(async()=>{
      if(this.closed||this.closing||generation!==this.generation||!this.host.isCurrent())throw new Error('Stale web router resume');
      this.paused=false;this.check(generation);
      const tabId=this.model.selectedTabId,visitId=this.current().id;
      try{
        await this.window.resume(route=>{
          this.check(generation);if(this.model.selectedTabId!==tabId||this.current().id!==visitId)throw new Error('Resumed web route changed');
          const model=copy(this.model);if(route)this.current(this.selected(model)).route=route;this.commit(model);
        });this.status='ready';
      }catch(error){if(generation===this.generation)this.status='blocked';throw error;}
      await this.publish();
    });
  }
  async destroy():Promise<void>{if(this.closed)return;this.closing=true;await this.drain();await this.window.destroy();this.closed=true;}
  encode(model=this.model):string{const encoded=JSON.stringify({version:1,localStoreId:this.scope.localStoreId,...model});if(encoded.length>4*1024*1024)throw new Error('Router state too large');return encoded;}
  private restore(encoded:string):Model{
    if(encoded.length>4*1024*1024)throw new Error('Router state too large');
    const raw=JSON.parse(encoded),tabIds=new Set<string>(),visits=new Set<string>();
    if(!raw||raw.version!==1||raw.localStoreId!==this.scope.localStoreId||!webRouteUUID(raw.selectedTabId)||!Array.isArray(raw.tabs)||raw.tabs.length<1||raw.tabs.length>64)throw new Error('Invalid restored router');
    const tabs:RouterTab[]=raw.tabs.map((tab:any)=>{
      if(!tab||!webRouteUUID(tab.id)||tabIds.has(tab.id)||!Array.isArray(tab.visits)||tab.visits.length<1||tab.visits.length>100||!Number.isSafeInteger(tab.cursor)||tab.cursor<0||tab.cursor>=tab.visits.length)throw new Error('Invalid restored tab');
      tabIds.add(tab.id);return{id:tab.id,cursor:tab.cursor,visits:tab.visits.map((visit:any)=>{
        if(!visit||!webRouteUUID(visit.id)||visits.has(visit.id))throw new Error('Invalid restored visit');visits.add(visit.id);return{id:visit.id,route:captureWebRoute(visit.route)};
      })};
    });
    if(!tabIds.has(raw.selectedTabId))throw new Error('Restored selected tab missing');return{selectedTabId:raw.selectedTabId,tabs};
  }
}
