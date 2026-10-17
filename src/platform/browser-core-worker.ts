import { openBrowserVault, BrowserVaultError } from '../core/browser-vault.ts';
import type { BrowserVault, BrowserVaultWasm } from '../core/browser-vault.ts';
import { afterDurableCommit } from './browser-core-events.ts';

// DOM builds and worker builds share this file without mixing lib.dom/lib.webworker.
const port = self as unknown as {onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void};
let vault: BrowserVault | undefined, clientId = '', channel: BroadcastChannel | undefined;
let sequence = '0', queue: Promise<unknown> = Promise.resolve();
let recovery = new Set<string>();
async function refresh(): Promise<void> {
  if (!vault) return;
  const next = await vault.changesSince(sequence);
  if (next.sequence !== sequence) { port.postMessage({event:'change',paths:next.paths}); sequence = next.sequence; }
}
async function execute(intentId: string): Promise<string> {
  const receipt = await vault!.executeIntent(clientId, intentId);
  // A hint is only emitted after strict commit. Other tabs read authoritative
  // storage; no data or sequence from an incoming BroadcastChannel is trusted.
  return afterDurableCommit(intentId,receipt,async () => { await refresh(); channel?.postMessage({changed:true}); });
}
async function dispatch(operation: string, payload: any): Promise<unknown> {
  if (operation === 'open') {
    if (vault) throw new BrowserVaultError('already_open', 'Worker already owns a vault');
    if (payload?.allowNewVault !== true || typeof payload?.clientId !== 'string') throw new BrowserVaultError('invalid_open', 'Explicit vault and client identity required');
    const moduleUrl = new URL(payload.wasmModuleUrl, self.location.href);
    if (moduleUrl.origin !== self.location.origin) throw new BrowserVaultError('invalid_wasm_url', 'WASM must be a same-origin application asset');
    const wasm = await import(/* webpackIgnore: true */ moduleUrl.href) as BrowserVaultWasm & {default(): Promise<unknown>};
    await wasm.default();
    vault = await openBrowserVault({name:payload.database, wasm}); clientId = payload.clientId;
    try {
      channel = new BroadcastChannel(`zorid-core:${payload.database}`);
      let recoveredCommit = false;
      for (const intent of await vault.intents(clientId)) if (!intent.acknowledged && ['commit_requested','committed'].includes(intent.status)) {
        try { await vault.executeIntent(clientId, intent.intent_id); recoveredCommit = true; }
        catch (error) { if (!(error instanceof BrowserVaultError && error.source === 'rust')) throw error; }
      }
      sequence = JSON.parse(await vault.snapshot()).sequence;
      if (recoveredCommit) channel.postMessage({changed:true});
      channel.onmessage = () => {
        // Serialize hints with operations; lost hints are repaired on visibility.
        queue = queue.then(refresh).catch(error => port.postMessage({event:'storage-error', code:error.code ?? 'storage_failure'}));
      };
      recovery = new Set((await vault.intents(clientId)).filter(intent => !intent.acknowledged && intent.status !== 'prepared').map(intent=>intent.intent_id));
      return {ready:true, sequence, authorityId:vault.authorityId, recovery:[...recovery]};
    } catch (error) { channel?.close(); channel = undefined; vault.close(); vault = undefined; throw error; }
  }
  if (!vault) throw new BrowserVaultError('not_open', 'Open worker vault first');
  switch (operation) {
    case 'inventory': return vault.inventory();
    case 'read': return vault.readEntry(payload);
    case 'read-id':return vault.readEntryById(payload);
    case 'checkpoint-load':return vault.checkpoints(clientId).load(payload);
    case 'checkpoint-cas':return vault.checkpoints(clientId).compareAndSwap(payload);
    case 'checkpoint-list':return vault.checkpoints(clientId).list(payload);
    case 'checkpoint-changes':return vault.checkpoints(clientId).changes(payload);
    case 'prepare':
      if (recovery.size && !recovery.has(payload.intentId)) throw new BrowserVaultError('recovery_required', 'Reconcile recovered intent outcomes before new mutations', {intent_ids:[...recovery]});
      return vault.prepareIntent(clientId, payload.intentId, payload.requestJson);
    case 'execute':
      if (recovery.size && !recovery.has(payload)) throw new BrowserVaultError('recovery_required', 'Reconcile recovered outcomes before authorizing another mutation', {intent_ids:[...recovery]});
      return execute(payload);
    case 'intents': return vault.intents(clientId);
    case 'acknowledge':
      await vault.acknowledgeIntent(clientId,payload.intentId,payload.outcome); recovery.delete(payload.intentId); return;
    case 'refresh': return refresh();
    default: throw new BrowserVaultError('invalid_operation', 'Unknown browser worker operation');
  }
}
port.onmessage = ({data}) => {
  const {id, operation, payload} = data;
  queue = queue.catch(() => undefined).then(async () => {
    try { port.postMessage({id, ok:true, result:await dispatch(operation, payload)}); }
    catch (error) {
      const failure = error instanceof BrowserVaultError ? error : new BrowserVaultError('storage_failure', error instanceof Error ? error.message : String(error));
      try { port.postMessage({id, ok:false, error:{code:failure.code, message:failure.message, details:failure.details, source:failure.source}}); }
      catch { /* Lost response remains outcome_unknown; do not poison later dispatch. */ }
    }
  });
};
