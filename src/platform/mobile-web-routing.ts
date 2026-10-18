/** Optional webRouting:1 presentation protocol. Web alone owns tabs/history.
 * Native pins store/client to the existing physical host; these packets never
 * claim a client, authorize storage, or create a second editor host. */
import {vaultPath} from './path.ts';
export interface WebRouteScope { readonly localStoreId:string; readonly clientId:string }
export type WebDocumentRoute = {kind:'document';entryId:string;path:string;revision:string;recovery:'none'|'retainedDraft'};
export type WebRoute = {kind:'home'} | WebDocumentRoute;
export type WebRouteAction =
  | {type:'open';entryId:string;disposition:'current'|'newTab'}
  | {type:'createNote'} | {type:'newTab'} | {type:'showHome'}
  | {type:'setPresentation';surface:'editor'|'native'}
  | {type:'selectTab';tabId:string} | {type:'closeTab';tabId:string}
  | {type:'traverse';direction:-1|1}
  | {type:'gestureBegin';gestureId:string;direction:-1|1};
export type WebRouteCommand = {id:string;webSessionId:string;expectedVersion:string;action:WebRouteAction}
  | {id:string;webSessionId:string;action:{type:'gestureEnd';gestureId:string;sequence:string;decision:'commit'|'cancel'}};
/** No per-frame result/state publication, route version bump, or storage I/O. */
export interface WebRouteProgress { webSessionId:string;gestureId:string;sequence:string;fraction:number }
export interface WebRouteTab {id:string;title:string;route:WebRoute;canBack:boolean;canForward:boolean}
export interface WebRouteState extends WebRouteScope {
  webSessionId:string;version:string;status:'ready'|'busy'|'blocked';presentation:'editor'|'native';selectedTabId:string;
  tabs:WebRouteTab[];
  gesture?:{id:string;phase:'prepared'|'tracking'|'settling';direction:-1|1};
}
export interface WebRouteResult {id:string;webSessionId:string;status:'applied'|'cancelled'|'failed'|'stale';version:string}
export interface NativeWebRouting {
  readonly scope:Readonly<WebRouteScope>;
  subscribe(command:(input:Readonly<WebRouteCommand>)=>Promise<void>,progress:(input:Readonly<WebRouteProgress>)=>void):()=>void;
  publish(state:WebRouteState):Promise<void>;
  result(result:WebRouteResult):Promise<void>;
}

export const webRouteUUID=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const webRouteToken=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export const webRouteVersion=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
const invalid=()=>new Error('Invalid web routing packet');
export function captureWebRouteCommand(value:unknown):Readonly<WebRouteCommand>{
  if(!object(value)||!webRouteUUID(value.id)||!webRouteUUID(value.webSessionId)||!object(value.action))throw invalid();
  const action=value.action,type=action.type;
  if(type==='gestureEnd'){
    if(!keys(value,['id','webSessionId','action'])||!keys(action,['type','gestureId','sequence','decision'])
      ||!webRouteUUID(action.gestureId)||!webRouteVersion(action.sequence)||action.decision!=='commit'&&action.decision!=='cancel')throw invalid();
  }else{
    if(!keys(value,['id','webSessionId','expectedVersion','action'])||!webRouteVersion(value.expectedVersion))throw invalid();
    switch(type){
      case 'open':if(!keys(action,['type','entryId','disposition'])||!webRouteToken(action.entryId)||action.disposition!=='current'&&action.disposition!=='newTab')throw invalid();break;
      case 'selectTab':case 'closeTab':if(!keys(action,['type','tabId'])||!webRouteUUID(action.tabId))throw invalid();break;
      case 'traverse':if(!keys(action,['type','direction'])||action.direction!==-1&&action.direction!==1)throw invalid();break;
      case 'gestureBegin':if(!keys(action,['type','gestureId','direction'])||!webRouteUUID(action.gestureId)||action.direction!==-1&&action.direction!==1)throw invalid();break;
      case 'setPresentation':if(!keys(action,['type','surface'])||action.surface!=='editor'&&action.surface!=='native')throw invalid();break;
      case 'newTab':case 'createNote':case 'showHome':if(!keys(action,['type']))throw invalid();break;
      default:throw invalid();
    }
  }
  return Object.freeze({...value,action:Object.freeze({...action})}) as Readonly<WebRouteCommand>;
}
export function captureWebRouteProgress(value:unknown):Readonly<WebRouteProgress>{
  if(!object(value)||!keys(value,['webSessionId','gestureId','sequence','fraction'])||!webRouteUUID(value.webSessionId)||!webRouteUUID(value.gestureId)
    ||!webRouteVersion(value.sequence)||typeof value.fraction!=='number'||!Number.isFinite(value.fraction)||value.fraction<0||value.fraction>1)throw invalid();
  return Object.freeze({...value}) as unknown as Readonly<WebRouteProgress>;
}
const utf8=new TextEncoder();
const boundedText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v)&&utf8.encode(v).length<=max;
export function captureWebRoute(value:unknown):WebRoute{
  if(!object(value))throw invalid();
  if(value.kind==='home'&&keys(value,['kind']))return{kind:'home'};
  if(value.kind!=='document'||!keys(value,['kind','entryId','path','revision','recovery'])||!webRouteToken(value.entryId)
    ||!webRouteToken(value.revision)||!boundedText(value.path,4096)||value.recovery!=='none'&&value.recovery!=='retainedDraft')throw invalid();
  try{if(vaultPath(value.path)!==value.path||value.path.split('/').some(part=>part.startsWith('.')))throw invalid();}catch{throw invalid();}
  return{kind:'document',entryId:value.entryId,path:value.path,revision:value.revision,recovery:value.recovery as WebDocumentRoute['recovery']};
}
export function captureWebRouteState(value:unknown):WebRouteState{
  if(!object(value)||!keys(value,['webSessionId','version','localStoreId','clientId','status','presentation','selectedTabId','tabs',...(value.gesture===undefined?[]:['gesture'])])
    ||!webRouteUUID(value.webSessionId)||!webRouteUUID(value.clientId)||!webRouteToken(value.localStoreId)||!webRouteVersion(value.version)
    ||!webRouteUUID(value.selectedTabId)||value.status!=='ready'&&value.status!=='busy'&&value.status!=='blocked'||value.presentation!=='editor'&&value.presentation!=='native'||!Array.isArray(value.tabs)||value.tabs.length<1||value.tabs.length>64)throw invalid();
  const seen=new Set<string>();
  const tabs=value.tabs.map(tab=>{
    if(!object(tab)||!keys(tab,['id','title','route','canBack','canForward'])||!webRouteUUID(tab.id)||seen.has(tab.id)||!boundedText(tab.title,1024)
      ||typeof tab.canBack!=='boolean'||typeof tab.canForward!=='boolean')throw invalid();
    seen.add(tab.id);return{id:tab.id,title:tab.title,route:captureWebRoute(tab.route),canBack:tab.canBack,canForward:tab.canForward};
  });
  if(!seen.has(value.selectedTabId))throw invalid();
  let gesture:WebRouteState['gesture'];
  if(value.gesture!==undefined){const g=value.gesture;if(!object(g)||!keys(g,['id','phase','direction'])||!webRouteUUID(g.id)
    ||g.phase!=='prepared'&&g.phase!=='tracking'&&g.phase!=='settling'||g.direction!==-1&&g.direction!==1)throw invalid();
    gesture={id:g.id,phase:g.phase as NonNullable<WebRouteState['gesture']>['phase'],direction:g.direction};}
  return{webSessionId:value.webSessionId,version:value.version,localStoreId:value.localStoreId,clientId:value.clientId,
    status:value.status as WebRouteState['status'],presentation:value.presentation,selectedTabId:value.selectedTabId,tabs,...(gesture?{gesture}:{})};
}
export function captureWebRouteResult(value:unknown):WebRouteResult{
  if(!object(value)||!keys(value,['id','webSessionId','status','version'])||!webRouteUUID(value.id)||!webRouteUUID(value.webSessionId)
    ||!webRouteVersion(value.version)||value.status!=='applied'&&value.status!=='cancelled'&&value.status!=='failed'&&value.status!=='stale')throw invalid();
  return{...value} as unknown as WebRouteResult;
}
