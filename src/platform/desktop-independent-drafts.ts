import type {IndependentDraftProvider,IndependentDraftReceipt,IndependentDraftRead,IndependentDraftScope,IndependentDraftBaseline} from '../core/independent-drafts.ts';
import type {DesktopBridge,DesktopIndependentJournalRequest} from './bridge';

const maximum=(1n<<64n)-1n;
const fail=(code='invalid_draft_response',commitUncertain=true,source='protocol')=>Object.assign(new Error('Independent draft protection is unavailable; the draft is retained.'),{code,commitUncertain,source});
function record(value:unknown,keys:readonly string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));}
function id(value:unknown):string{if(typeof value!=='string'||!value||value.length>256||/[\0/\\]/.test(value))throw fail();return value;}
function counter(value:unknown):string{if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>maximum)throw fail();return value;}
function generation(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||Object.is(value,-0))throw fail();return value;}
function body(value:unknown):string{if(typeof value!=='string'||value.length*2>64*1024*1024)throw fail();return value;}
function baseline(value:unknown,entryId:string):IndependentDraftBaseline{
  if(!record(value,['entryId','path','revision','content'])||value.entryId!==entryId||typeof value.path!=='string'||!value.path||value.path.length>32768||/[\0\\]/.test(value.path)||value.path.startsWith('/')||/^[a-z]:/i.test(value.path)||value.path.split('/').some(part=>!part||part==='.'||part==='..')||typeof value.revision!=='string'||!value.revision||value.revision.length>32768)throw fail();
  return Object.freeze({entryId,path:value.path,revision:value.revision,content:body(value.content)});
}
const receiptKeys=['vaultId','clientId','incarnationId','entryId','writer','revision','generation','deleted'];

/** This provider has no dependency on core RPCs, queues or host retirement.
 * Only main's authenticated document grant can acknowledge journal protection.
 * Every response is copied and checked before reaching the note coordinator.
 */
export function createDesktopIndependentDraftProvider(bridge:Pick<DesktopBridge,'independentJournal'>,vault:string,coreScope:{vaultId:string;clientId:string},grant:unknown):IndependentDraftProvider{
  if(!record(grant,['token','scope'])||typeof grant.token!=='string'||!grant.token||grant.token.length>128||!record(grant.scope,['vaultId','clientId','incarnationId'])
    ||grant.scope.vaultId!==coreScope.vaultId||grant.scope.clientId!==coreScope.clientId||typeof bridge.independentJournal!=='function')throw fail();
  const scope:IndependentDraftScope=Object.freeze({vaultId:id(grant.scope.vaultId),clientId:id(grant.scope.clientId),incarnationId:id(grant.scope.incarnationId)}),token=grant.token,invoke=bridge.independentJournal.bind(bridge);
  function receipt(value:unknown):IndependentDraftReceipt{
    if(!record(value,receiptKeys)||value.vaultId!==scope.vaultId||value.clientId!==scope.clientId||typeof value.deleted!=='boolean')throw fail();
    return Object.freeze({vaultId:scope.vaultId,clientId:scope.clientId,incarnationId:id(value.incarnationId),entryId:id(value.entryId),writer:id(value.writer),revision:counter(value.revision),generation:generation(value.generation),deleted:value.deleted});
  }
  async function request(op:DesktopIndependentJournalRequest['op'],args:readonly unknown[]):Promise<unknown>{
    let result:unknown;
    try{result=await invoke({vault,token,op,args});}catch{throw fail('draft_transport_lost',true,'transport');}
    if(record(result,['independentJournal','schemaVersion','ok','value'])&&result.independentJournal===true&&result.schemaVersion===1&&result.ok===true)return result.value;
    if(record(result,['independentJournal','schemaVersion','ok','error'])&&result.independentJournal===true&&result.schemaVersion===1&&result.ok===false&&record(result.error,['code','commitUncertain','source'])
      &&typeof result.error.code==='string'&&/^[a-z_]{1,64}$/.test(result.error.code)&&typeof result.error.commitUncertain==='boolean'&&['main','transport','protocol'].includes(result.error.source as string))throw fail(result.error.code,result.error.commitUncertain,result.error.source as string);
    throw fail();
  }
  return Object.freeze<IndependentDraftProvider>({scope,
    async isRetiredIncarnation(input){
      let incarnationId:string;try{incarnationId=id(input);}catch{throw fail('invalid_draft_request',false);}
      const value=await request('isRetiredIncarnation',[incarnationId]);
      if(typeof value!=='boolean')throw fail();
      return value;
    },
    async compareAndSwap(input){
      if(!record(input,['entryId','writer','generation','expectedRevision','nextRevision','baseline','draft','checkpointRevision','pendingOperation']))throw fail('invalid_draft_request',false);
      const entryId=id(input.entryId),writer=id(input.writer),expected=input.expectedRevision===null?null:counter(input.expectedRevision),next=counter(input.nextRevision),savedGeneration=generation(input.generation);
      if(BigInt(next)!==(expected===null?1n:BigInt(expected)+1n))throw fail('invalid_draft_revision',false);
      const captured=Object.freeze({entryId,writer,generation:savedGeneration,expectedRevision:expected,nextRevision:next,baseline:baseline(input.baseline,entryId),draft:body(input.draft),checkpointRevision:input.checkpointRevision===null?null:id(input.checkpointRevision),pendingOperation:input.pendingOperation===null?null:body(input.pendingOperation)});
      const saved=receipt(await request('compareAndSwap',[captured]));
      if(saved.entryId!==entryId||saved.writer!==writer||saved.incarnationId!==scope.incarnationId||saved.revision!==next||saved.generation!==savedGeneration||saved.deleted)throw fail();return saved;
    },
    async retire(input){
      if(!record(input,['entryId','writer','incarnationId','generation','expectedRevision','nextRevision']))throw fail('invalid_draft_request',false);
      const entryId=id(input.entryId),writer=id(input.writer),incarnationId=id(input.incarnationId),expected=counter(input.expectedRevision),next=counter(input.nextRevision),savedGeneration=generation(input.generation);
      if(BigInt(next)!==BigInt(expected)+1n)throw fail('invalid_draft_revision',false);
      const original=Object.freeze({...scope,incarnationId,entryId,writer,revision:expected,generation:savedGeneration,deleted:false});
      const saved=receipt(await request('retire',[original]));
      if(saved.entryId!==entryId||saved.writer!==writer||saved.incarnationId!==incarnationId||saved.revision!==next||saved.generation!==savedGeneration||!saved.deleted)throw fail();return saved;
    },
    async list(options){
      if(options!==undefined&&!record(options,['entryId']))throw fail('invalid_draft_request',false);
      const entryId=options===undefined?undefined:id(options.entryId),value=await request('list',entryId===undefined?[]:[{entryId}]);
      if(!Array.isArray(value)||value.length>4096||Reflect.ownKeys(value).length!==value.length+1||Reflect.ownKeys(value).some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'))))throw fail();
      const seen=new Set<string>(),rows=value.map(row=>{const saved=receipt(row),key=JSON.stringify([saved.incarnationId,saved.entryId,saved.writer]);if(saved.deleted||entryId!==undefined&&saved.entryId!==entryId||seen.has(key))throw fail();seen.add(key);return saved;});return Object.freeze(rows);
    },
    async read(address):Promise<IndependentDraftRead>{
      if(!record(address,address&&typeof address==='object'&&Object.hasOwn(address,'incarnationId')?['entryId','writer','incarnationId']:['entryId','writer']))throw fail('invalid_draft_request',false);
      const entryId=id(address.entryId),writer=id(address.writer),incarnationId=address.incarnationId===undefined?scope.incarnationId:id(address.incarnationId),value=await request('read',[{entryId,writer,incarnationId}]);if(value===null)return null;
      const deleted=!!value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'deleted')?.value===true;
      if(!record(value,deleted?receiptKeys:[...receiptKeys,'baseline','draft','checkpointRevision','pendingOperation']))throw fail();
      const saved=receipt(Object.fromEntries(receiptKeys.map(key=>[key,value[key]])));
      if(saved.entryId!==entryId||saved.writer!==writer||saved.incarnationId!==incarnationId)throw fail();
      if(deleted)return Object.freeze({...saved,deleted:true});
      return Object.freeze({...saved,deleted:false,baseline:baseline(value.baseline,entryId),draft:body(value.draft),checkpointRevision:value.checkpointRevision===null?null:id(value.checkpointRevision),pendingOperation:value.pendingOperation===null?null:body(value.pendingOperation)});
    },
  });
}
