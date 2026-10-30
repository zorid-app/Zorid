import {NoteLoadSupervisor} from '../ui/note-load-supervisor.ts';

const temporary=new Set(['storage_busy','storage_io_retryable','storage_capacity','filesystem_io_retryable','lock_timeout']);
const own=(value:object,key:string):unknown=>{const field=Object.getOwnPropertyDescriptor(value,key);return field&&Object.hasOwn(field,'value')?field.value:undefined;};
function retryable(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const cause=Object.getOwnPropertyDescriptor(error,'cause');
  if('cause'in error&&(!cause||!Object.hasOwn(cause,'value')||cause.value!==undefined))return false;
  const code=own(error,'code'),source=own(error,'source');
  return source==='host'&&typeof code==='string'&&temporary.has(code)||source==='transport'&&code==='durable_transport_lost';
}
class StopDatabaseRetry {readonly error:unknown;constructor(error:unknown){this.error=error;}}
/** One already-captured collection mutation IO, without rerunning its widget,
 * changing its operation ID, interpreting projection strings or claiming a lease. */
export class DatabaseMutationSupervisor {
  private readonly io=new NoteLoadSupervisor();
  stop():void{this.io.stop();}
  run<T>(operation:()=>Promise<T>,validate:()=>void):Promise<T>{
    let terminal:StopDatabaseRetry|undefined;
    // Terminal IO failures retain their original provenance for the capsule's
    // retirement handler. They cannot dispatch again, so post-failure owner
    // validation must not replace them with a synthetic admission error.
    return this.io.run(async()=>{try{return await operation();}catch(error){if(retryable(error))throw error;terminal=new StopDatabaseRetry(error);throw terminal;}},()=>{if(!terminal)validate();})
      .catch(error=>{throw error instanceof StopDatabaseRetry?error.error:error;});
  }
}
