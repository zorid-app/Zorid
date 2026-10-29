import type {DesktopBridge,DesktopDurableContext,DesktopDurableRequest} from './bridge';

const genericMessage='Durable editor request failed; retain pending recovery state.';
const failure=(code:string,commitUncertain:boolean,source:string,message=genericMessage)=>Object.assign(new Error(message),{code,commitUncertain,source});
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&[null,Object.prototype].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function decode(value:unknown,request:DesktopDurableRequest){
  if(!value||typeof value!=='object'||!('durableError' in value))return value;
  const candidate=value as Record<string,unknown>;
  if(!exact(candidate,['durableError','schemaVersion','error'])||candidate.durableError!==true||candidate.schemaVersion!==1)
    throw failure('invalid_durable_response',true,'protocol');
  const detail=candidate.error;
  if(!exact(detail,['code','commitUncertain','source'])||typeof detail.code!=='string'||!/^[a-z_]{1,64}$/.test(detail.code)
    ||typeof detail.commitUncertain!=='boolean'||!['host','transport','protocol'].includes(detail.source as string))
    throw failure('invalid_durable_response',true,'protocol');
  const {code,commitUncertain,source}=detail;
  const savedSource=request.kind==='invoke'&&['captureSavedSource','releaseSavedSource'].includes(request.method);
  throw failure(code,commitUncertain,source as string,savedSource&&source==='host'&&code==='conditional_source_changed'&&!commitUncertain
    ?'The file changed or was replaced. Your draft was kept; refresh before saving.':genericMessage);
}

/** The legacy bridge remains usable by older desktop shells. */
export function createDesktopDurableTransport(bridge:DesktopBridge){
  if(bridge.durableRequest!==undefined){
    const request=async(input:DesktopDurableRequest)=>{
      if(typeof bridge.durableRequest!=='function')throw failure('invalid_durable_response',true,'protocol');
      let value:unknown;
      try{value=await bridge.durableRequest(input);}
      catch{throw failure('durable_transport_lost',true,'transport');}
      return decode(value,input);
    };
    return {
      getDurableContext:(vault:string)=>request({kind:'context',vault}) as Promise<DesktopDurableContext|null>,
      recoverDurableContext:(vault:string,admissionId:string)=>request({kind:'recover',vault,admissionId}) as Promise<DesktopDurableContext>,
      durableInvoke:(vault:string,admissionId:string,method:string,args:readonly unknown[])=>request({kind:'invoke',vault,admissionId,method,args}),
      releaseDurableContext:async(vault:string,admissionId:string)=>{await request({kind:'release',vault,admissionId});},
    };
  }
  return {
    getDurableContext:bridge.getDurableContext?((vault:string)=>bridge.getDurableContext!(vault)):undefined,
    recoverDurableContext:bridge.recoverDurableContext?((vault:string,admissionId:string)=>bridge.recoverDurableContext!(vault,admissionId)):undefined,
    durableInvoke:bridge.durableInvoke?((vault:string,admissionId:string,method:string,args:readonly unknown[])=>bridge.durableInvoke!(vault,admissionId,method,args)):undefined,
    releaseDurableContext:bridge.releaseDurableContext?((vault:string,admissionId:string)=>bridge.releaseDurableContext!(vault,admissionId)):undefined,
  };
}
