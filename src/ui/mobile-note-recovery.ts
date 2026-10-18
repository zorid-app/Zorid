import type {DurableCheckpoints,CheckpointMetadata} from '../core/durable-checkpoints.ts';
import type {DurableWriteRead} from '../core/durable-writes.ts';
import type {MobileDocumentSnapshot} from './mobile-document-view-window.ts';
import {captureWebRoute,webRouteToken,webRouteVersion} from '../platform/mobile-web-routing.ts';

const encoder=new TextEncoder();
const MAX_BODY=32*1024*1024;
/** Read-only preview. Observe immutable identity BEFORE reading its checkpoint;
 * never construct a NoteBuffer, query/commit an intent, acknowledge or save here. */
export async function readPassiveMobileNote(input:{entryId:string;readById:(id:string)=>Promise<DurableWriteRead|null>;checkpoints:DurableCheckpoints;check:()=>void}):Promise<MobileDocumentSnapshot>{
  const {entryId,readById,checkpoints,check}=input;
  if(!webRouteToken(entryId))throw new Error('Invalid passive note identity');
  const scope={...checkpoints.scope};
  const valid=()=>{check();if(checkpoints.scope.vaultId!==scope.vaultId||checkpoints.scope.clientId!==scope.clientId)throw new Error('Passive note client changed');};
  valid();const observed=await readById(entryId);valid();
  if(!observed||observed.entryId!==entryId||typeof observed.content!=='string')throw new Error('Passive note identity changed');
  const route={kind:'document' as const,entryId,path:observed.path,revision:observed.revision,recovery:'none' as const};captureWebRoute(route);
  const key='note/v1/'+entryId,head=await checkpoints.load(key);valid();
  if(!head||head.deleted||head.encodedState===null)return{route,content:observed.content};
  if(head.vaultId!==scope.vaultId||head.clientId!==scope.clientId||head.key!==key||typeof head.encodedState!=='string'||head.encodedState.length>MAX_BODY||encoder.encode(head.encodedState).length>MAX_BODY)throw new Error('Saved editor state is unavailable; retained');
  const raw=JSON.parse(head.encodedState);
  if(!raw||raw.version!==1||typeof raw.writer!=='string'||!Number.isSafeInteger(raw.generation)||raw.generation<0||typeof raw.draft!=='string'||typeof raw.conflict!=='boolean'
    ||!raw.base||raw.base.entryId!==entryId||typeof raw.base.path!=='string'||typeof raw.base.content!=='string'||!webRouteToken(raw.base.revision)
    ||raw.operation!==undefined&&(!raw.operation||typeof raw.operation!=='object'||Array.isArray(raw.operation)))throw new Error('Saved editor state is unsupported; retained');
  const retained=raw.conflict||raw.operation!==undefined||raw.draft!==raw.base.content;
  return{route:{...route,recovery:retained?'retainedDraft':'none'},content:retained?raw.draft:observed.content};
}

export interface MobileRecoveryItem {
  readonly key:string;readonly revision:string;readonly sequence:string;
  readonly kind:'savedEditorState'|'fileOperation'|'legacyNativeOperation'|'other';
  readonly entryId?:string;
  /** Metadata is NOT proof that a draft/operation is pending or clear. */
  readonly status:'uninspected';
}
export interface MobileRecoveryPage {
  readonly phase:'list'|'changes';readonly highWater:string;readonly items:readonly MobileRecoveryItem[];
  readonly hasMore:boolean;readonly complete:boolean;readonly recordsObserved:number;
  readonly status:'uninspected'|'metadataObserved'|'unavailable';readonly error?:string;
}
/** A discoverable bounded page, not a materialized map of every saved body/ID.
 * Native/Workspace can page this inventory without replaying recovery. */
export class MobileRecoveryInventory {
  private checkpoints:DurableCheckpoints;
  private current:()=>boolean;
  private scope:{vaultId:string;clientId:string};
  private cursor?:string;
  private phase:'list'|'changes'='list';
  private passHighWater?:string;
  private listHighWater?:string;
  private recordsObserved=0;
  private done=false;
  private pending?:Promise<MobileRecoveryPage>;
  private last:MobileRecoveryPage={phase:'list',highWater:'0',items:[],hasMore:true,complete:false,recordsObserved:0,status:'uninspected'};
  constructor(checkpoints:DurableCheckpoints,isCurrent:()=>boolean){this.checkpoints=checkpoints;this.scope={...checkpoints.scope};this.current=isCurrent;}
  snapshot():MobileRecoveryPage{return structuredClone(this.last);}
  private check(){if(!this.current()||this.checkpoints.scope.vaultId!==this.scope.vaultId||this.checkpoints.scope.clientId!==this.scope.clientId)throw new Error('Recovery inventory owner changed');}
  next():Promise<MobileRecoveryPage>{
    try{this.check();}catch(error){this.unavailable(error);return Promise.reject(error);}
    if(this.pending)return this.pending;if(this.done)return Promise.resolve(this.snapshot());
    const task=this.read();this.pending=task;void task.finally(()=>{if(this.pending===task)this.pending=undefined;}).catch(()=>{});return task;
  }
  private async read():Promise<MobileRecoveryPage>{
    try{
      this.check();const phase=this.phase;
      const page=phase==='list'?await this.checkpoints.list({limit:50,...(this.cursor?{cursor:this.cursor}:{})}):await this.checkpoints.changes({after:this.listHighWater!,limit:50,...(this.cursor?{cursor:this.cursor}:{})});this.check();
      if(!page||!Array.isArray(page.items)||page.items.length>50||!webRouteVersion(page.highWater)||this.passHighWater!==undefined&&page.highWater!==this.passHighWater
        ||phase==='changes'&&BigInt(page.highWater)<BigInt(this.listHighWater!)
        ||page.cursor!==null&&(typeof page.cursor!=='string'||!page.cursor||page.cursor.length>8192||page.cursor===this.cursor))throw new Error('Invalid recovery inventory page');
      const items:MobileRecoveryItem[]=[];
      for(const row of page.items){this.validate(row);if(BigInt(row.sequence)>BigInt(page.highWater))throw new Error('Recovery metadata exceeds captured high water');if(row.deleted)continue;
        const entryId=row.key.startsWith('note/v1/')?row.key.slice(8):undefined;
        if(entryId!==undefined&&!webRouteToken(entryId))throw new Error('Invalid saved editor identity');
        const kind=entryId!==undefined?'savedEditorState':row.key.startsWith('mobile-file-command/v1/')?'fileOperation':row.key==='native-file-menu/v1/pending'?'legacyNativeOperation':'other';
        items.push({key:row.key,revision:row.revision,sequence:row.sequence,kind,...(entryId?{entryId}:{}),status:'uninspected'});
      }
      this.recordsObserved+=page.items.length;
      this.passHighWater=page.highWater;this.cursor=page.cursor??undefined;
      if(page.cursor===null){
        if(phase==='list'){this.listHighWater=page.highWater;this.phase='changes';this.passHighWater=undefined;}
        else this.done=true;
      }
      this.last={phase,highWater:page.highWater,items,hasMore:!this.done,complete:this.done,recordsObserved:this.recordsObserved,status:'metadataObserved'};
      return this.snapshot();
    }catch(error){
      // Keep the last good page/cursor discoverable and retryable; a failed or
      // exhausted read is never represented as clear or zero pending recovery.
      this.unavailable(error);
      throw error;
    }
  }
  private unavailable(error:unknown):void{this.last={...this.last,status:'unavailable',complete:false,error:error instanceof Error?error.message:'Recovery inventory unavailable'};}
  private validate(row:CheckpointMetadata):void{
    if(!row||row.version!==1||row.vaultId!==this.scope.vaultId||row.clientId!==this.scope.clientId||typeof row.key!=='string'||!row.key||row.key.length>8192
      ||!webRouteToken(row.revision)||!webRouteVersion(row.sequence)||typeof row.deleted!=='boolean'||!Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>MAX_BODY)throw new Error('Invalid recovery metadata');
  }
}
