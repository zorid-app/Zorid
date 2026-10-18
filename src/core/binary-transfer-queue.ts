import type {BinaryStreams} from './binary-streams.ts';

// A consumer's checkpoint phases allow one command at a time. Share complete
// transfer ownership across Vault wrappers using that exact consumer, without
// occupying their unrelated metadata/text-write queues.
const tails=new WeakMap<BinaryStreams,Promise<void>>();

/** Capture caller-owned input before scheduling; validate admission when the
 * action starts and between awaits. Rejection releases the next transfer. */
export function scheduleBinaryTransfer<T>(streams:BinaryStreams,action:()=>Promise<T>):Promise<T>{
  const result=(tails.get(streams)??Promise.resolve()).then(action);
  const settled=result.then(()=>undefined,()=>undefined);
  tails.set(streams,settled);
  void settled.then(()=>{if(tails.get(streams)===settled)tails.delete(streams);});
  return result;
}
