import {BrowserVaultError} from './browser-vault.ts';
import {documentDraftRequest,documentDraftReply,DOCUMENT_DRAFT_CHUNK_BYTES,DOCUMENT_DRAFT_CONTROL_BYTES,DOCUMENT_DRAFT_PENDING_BYTES,DOCUMENT_DRAFT_PENDING_CALLS} from './document-drafts.ts';
import type {DocumentDraftRequest} from './document-drafts.ts';

/** Private generated bindings. No work-selection or completion handle is exposed
 * by the public draft transport. Raw arrays remain JS references until Rust has
 * admitted its actual ingress allocation. */
export interface BrowserDraftOwnerWasm {
  configureDrafts(client:string,lifetime:string,incarnation:string):void;
  draftCommandJson(request:string):string;
  draftUploadChunkJson(request:string,bytes:Uint8Array):string;
  draftReadPlanJson(request:string):string;
  draftReadIntoJson(request:string,bytes:Uint8Array):string;
  draftReleaseClientJson():string;
  workNextTurnJson():string;
  workSnapshotJson():string;
  workBeginCloseJson():string;
  workStepDraftJson(ticket:string):string;
  workIssued(ticket:string):BrowserDocumentWorkIssuedWasm;
}
export interface BrowserDocumentWorkIssuedWasm {
  descriptorJson():string;replayJson():string|undefined;completeJson(result:string):string;free():void;
}
export interface BrowserDocumentWorkTicket {readonly incarnation:string;readonly lane:'committed'|'draft';readonly lifetime:string;readonly id:string}
export interface BrowserDocumentWorkSnapshot {
  readonly selected:BrowserDocumentWorkTicket|null;readonly last_settled:BrowserDocumentWorkTicket|null;
  readonly closing:boolean;readonly close_ready:boolean;
}
export interface BrowserDocumentWorkFrame {
  readonly work:BrowserDocumentWorkSnapshot|null;
  readonly turn:null|{readonly state:'ready'|'waiting'|'quiesced'};
  readonly continued?:import('./document-runtime.ts').DocumentRuntimeReduction|null;
  readonly committed?:import('./document-runtime.ts').DocumentRuntimeReduction|null;
  readonly client_has_jobs?:boolean;
}
const methods:readonly string[]=['free','commandJson','updateJson','snapshotJson','issued','replayJson','configureDrafts','draftCommandJson','draftUploadChunkJson','draftReadPlanJson','draftReadIntoJson','draftReleaseClientJson','workNextTurnJson','workSnapshotJson','workBeginCloseJson','workStepDraftJson','workIssued'];
export function browserDraftMethodsAvailable(constructor:unknown,issuedConstructor:unknown):boolean {
  if(typeof constructor!=='function')return false;
  const prototype=(constructor as {prototype?:unknown}).prototype;
  if(!prototype||!methods.every(name=>typeof (prototype as Record<string,unknown>)[name]==='function')||typeof issuedConstructor!=='function')return false;
  const issued=(issuedConstructor as {prototype?:Record<string,unknown>}).prototype;
  return !!issued&&['descriptorJson','replayJson','completeJson','free'].every(name=>typeof issued[name]==='function');
}
const fail=(code='draft_invalid_request')=>new BrowserVaultError(code,'Transient document processing is unavailable',undefined,'rust');
const encoder=new TextEncoder();
export function draftJson<T>(text:string):T {
  if(typeof text!=='string'||text.length>DOCUMENT_DRAFT_CONTROL_BYTES||encoder.encode(text).byteLength>DOCUMENT_DRAFT_CONTROL_BYTES)throw fail('draft_control_limit');
  try{return JSON.parse(text) as T;}catch{throw fail('draft_contract');}
}
export function draftWasm<T>(operation:()=>T):T {
  try{return operation();}catch(error){if(error instanceof BrowserVaultError)throw error;
    let code='draft_contract';try{const row=JSON.parse(String(error));if(typeof row.code==='string'&&/^draft_[a-z_]{1,48}$/.test(row.code))code=row.code;}catch{}
    throw fail(code);
  }
}
/** These credits cover only arrays actually allocated by this JS adapter. They
 * are separate from the portable owner's canonical input/facts/scratch budgets.
 * The Worker releases an output credit only after postMessage hands it off. */
export function browserDraftFrames(options:{owner():BrowserDraftOwnerWasm;assertActive():void}) {
  let calls=0,bytes=0;
  return {invoke(input:DocumentDraftRequest,raw?:Uint8Array):{result:unknown;bytes:Uint8Array;release():void}{
    options.assertActive();const request=documentDraftRequest(input);
    if(request.op==='upload_chunk'?!(raw instanceof Uint8Array)||raw.byteLength===0||raw.byteLength>DOCUMENT_DRAFT_CHUNK_BYTES:raw!==undefined)throw fail('draft_invalid_chunk');
    if(calls>=DOCUMENT_DRAFT_PENDING_CALLS)throw fail('draft_capacity');
    calls++;let reserved=0,released=false;
    const release=()=>{if(released)return;released=true;calls--;bytes-=reserved;};
    try{
      const owner=options.owner(),control=JSON.stringify(request);let result:unknown,output:Uint8Array;
      if(request.op==='facts_read'){
        // Planning reads the current Ready job and actual encoded length. It
        // allocates no output body. The copy call repeats those exact fences.
        const plan=draftJson<Record<string,unknown>>(draftWasm(()=>owner.draftReadPlanJson(control))),size=plan.bytes;
        if(!Number.isSafeInteger(size)||typeof size!=='number'||size<0||size>request.maximum||size>DOCUMENT_DRAFT_CHUNK_BYTES)throw fail('draft_contract');
        if(bytes+size>DOCUMENT_DRAFT_PENDING_BYTES)throw fail('draft_capacity');
        reserved=size;bytes+=size;output=new Uint8Array(size);
        options.assertActive();result=draftJson(draftWasm(()=>owner.draftReadIntoJson(control,output)));
      }else{
        result=draftJson(draftWasm(()=>request.op==='upload_chunk'?owner.draftUploadChunkJson(control,raw!):owner.draftCommandJson(control)));
        output=new Uint8Array(0);
      }
      options.assertActive();documentDraftReply(request,{result,bytes:output});
      return {result,bytes:output,release};
    }catch(error){release();throw error;}
  }};
}
