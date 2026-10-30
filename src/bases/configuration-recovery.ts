import { BaseViewReferenceRenameError } from './view-references.ts';

const admission=new Set(['host_exited','client_not_admitted','client_ownership_lost','desktop_recovery_pending','desktop_recovery_stale_reply']);
const transient=new Set(['storage_busy','storage_io_retryable','storage_capacity','source_capture_capacity','filesystem_io_retryable','lock_timeout']);
const own=(value:object,key:string):unknown=>{const field=Object.getOwnPropertyDescriptor(value,key);return field&&Object.hasOwn(field,'value')?field.value:undefined;};
function kind(error:unknown):'admission'|'transient'|undefined {
  const seen=new Set<unknown>();
  for(let depth=0;depth<8;depth++){
    if(!error||typeof error!=='object'||seen.has(error))return;seen.add(error);
    const descriptor=Object.getOwnPropertyDescriptor(error,'cause');if('cause'in error&&(!descriptor||!Object.hasOwn(descriptor,'value')))return;
    const code=own(error,'code'),source=own(error,'source'),cause=own(error,'cause');
    if(code==='outcome_unknown'&&source==='host'&&cause!==undefined){error=cause;continue;}
    if(cause!==undefined)return;
    if(source==='host'&&typeof code==='string'){if(admission.has(code))return'admission';if(transient.has(code))return'transient';}
    if(source==='transport'&&code==='durable_transport_lost')return'transient';return;
  }
}
/** Reference publication retains one original plan plus its completed-file set.
 * Its domain wrapper is retryable only if EVERY unfinished file has trusted
 * transient provenance. A mixed conflict cannot borrow another file's retry. */
export function baseConfigurationRecoveryFailure(error:unknown):unknown {
  if(!(error instanceof BaseViewReferenceRenameError))return error;
  let selected:unknown,selectedKind:'admission'|'transient'|undefined;
  for(const failure of error.failures.values()){
    const disposition=kind(failure);if(!disposition)return error;
    if(!selectedKind||disposition==='admission'){selected=failure;selectedKind=disposition;}
  }
  return selectedKind?selected:error;
}
