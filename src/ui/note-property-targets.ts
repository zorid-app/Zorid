import type { DatabaseCollection, DatabaseEntry } from '../core/databases.ts';
import type { BasePropertyDefinition } from '../bases/property-definitions.ts';
import type { Vault } from '../core/vault.ts';
import type { CommittedMetadataState } from '../core/committed-metadata-frame.ts';
import { createBaseClockHost } from '../bases/clock.ts';
import type { BaseClockHost } from '../bases/clock.ts';
import { closePropertyTargetQueries, isPlainPropertyValue, queryPropertyTargets } from '../bases/property-targets.ts';
import type { PropertyTarget, PropertyTargetsResult } from '../bases/property-targets.ts';
import { baseValuesEqual } from '../bases/expression.ts';
import type { BaseExpressionValue } from '../bases/expression.ts';

export interface NotePropertyTargets {
  getCollection(): {collection:DatabaseCollection;entry:DatabaseEntry}|undefined;
  prepareCollection(): Promise<{collection:DatabaseCollection;entry:DatabaseEntry}|undefined>;
  getDefinitions(): Readonly<Record<string,BasePropertyDefinition>>;
  get(property: string): readonly PropertyTarget[] | undefined;
  /** Bare property name and current raw editor value; never resolves a path. */
  getDisplayValue(property: string, raw: BaseExpressionValue): BaseExpressionValue | undefined;
  invalidate(): void;
  destroy(): void;
  /** Joins cancelled reads and retries any unacknowledged pin close. */
  close(): Promise<void>;
}

/** One ordinary note's saved relation choices. Rust owns every target filter;
 * this host only invalidates stale results and schedules explicit core wakes. */
export function createNotePropertyTargets(options: {
  vault: Vault;
  getPath(): string;
  isCurrent(): boolean;
  onChange(): void;
  clock?: BaseClockHost;
  /** Lifecycle test seam; production always uses the sealed shared-core query. */
  query?: typeof queryPropertyTargets;
}): NotePropertyTargets {
  const { vault } = options, service = vault.adapter.documentSemantics;
  const clock = options.clock ?? createBaseClockHost();
  let disposed = false, serial = 0, result: PropertyTargetsResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined;
  let wake: (() => void) | undefined, pending: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined;
  const stops: (() => void)[] = [];
  type CollectionState={collection:DatabaseCollection;entry:DatabaseEntry};
  let collectionState:CollectionState|undefined,collectionPath:string|undefined,collectionActor:object|undefined;
  const collectionReads=new Set<Promise<CollectionState|undefined>>();
  let collectionSerial=0,collectionInvalidated=false;
  let collectionRequest:{path:string;promise:Promise<CollectionState|undefined>}|undefined;
  function prepareCollection():Promise<CollectionState|undefined>{
    const path=options.getPath();
    if(collectionRequest?.path===path)return collectionRequest.promise;
    const adapter=vault.adapter,databases=adapter.databases,durable=adapter.durableWrites,listed=vault.entries.get(path),entry=listed?{...listed}:undefined,request=++collectionSerial;
    const scope=durable?.checkpoints.scope,vaultId=scope?.vaultId,clientId=scope?.clientId;
    let resolvedId:string|undefined;
    const sameActor=()=>{const latest=vault.entries.get(path);return latest?.type==='file'&&(entry?.entryId?latest.entryId===entry.entryId:latest===listed||!!resolvedId&&latest.entryId===resolvedId);};
    const live=()=>current()&&request===collectionSerial&&vault.adapter===adapter&&vault.adapter.databases===databases&&adapter.durableWrites===durable&&durable?.checkpoints.scope.vaultId===vaultId&&durable?.checkpoints.scope.clientId===clientId&&options.getPath()===path&&sameActor();
    const apply=(next:CollectionState|undefined)=>{
      const changed=collectionPath!==path||JSON.stringify(next)!==JSON.stringify(collectionState);
      collectionPath=path;collectionActor=vault.entries.get(path);collectionState=next;if(changed)notify();return next;
    };
    const promise=Promise.resolve().then(async()=>{
      if(!databases){if(request===collectionSerial&&!disposed)return apply(undefined);return;}
      if(entry?.type!=='file')throw new Error('The collection note is unavailable.');
      // A namespace listing may intentionally omit durable identities. Resolve
      // through the admitted provider, never from readable _id/_type content.
      const fallback=!entry.entryId||!entry.revision;
      const witness=fallback&&adapter.durableWrites?await vault.readDurableText(path):undefined;
      if(!live())throw new Error('The collection note changed.');
      const entryId=fallback?witness?.entryId:entry.entryId,revision=fallback?witness?.revision:entry.revision;
      if(!entryId||!revision||!durable)throw new Error('The collection note identity is unavailable.');
      resolvedId=entryId;
      const selected=vault.entries.get(path);
      if(selected?.entryId&&selected.entryId!==entryId)throw new Error('The collection note changed.');
      let reply:Awaited<ReturnType<typeof databases.request>>|undefined;
      try{reply=await databases.request({op:'get_entry',entryId});}
      catch(error){
        // Only an admitted, definite native absence can establish an ordinary
        // note. Transport/validation/IO failures retain the last known state.
        const absent=error as {code?:unknown;source?:unknown;commitUncertain?:unknown};
        if(absent.code!=='collection_not_found'||absent.source!=='host'||absent.commitUncertain!==false)throw error;
      }
      if(!live())throw new Error('The collection note changed.');
      const latest=vault.entries.get(path);
      if(latest?.entryId&&latest.entryId!==entryId)throw new Error('The collection note changed.');
      const observed=await vault.readDurableTextById(entryId);
      if(!live()||!observed||observed.path!==path||observed.revision!==revision||latest?.entryId&&latest.entryId!==observed.entryId)throw new Error('The collection note changed.');
      if(!reply)return apply(undefined);
      const member=reply.entries.find(item=>item.entryId===entryId);
      if(!member||member.deleted||member.path!==path||member.fileRevision!==revision)throw new Error('The collection note changed.');
      const collection=reply.collections.find(item=>item.id===member.collectionId&&!item.deleted);
      if(!collection)throw new Error('The collection note is unavailable.');
      return apply({collection,entry:member});
    }).finally(()=>{collectionReads.delete(promise);if(collectionRequest?.promise===promise){collectionRequest=undefined;if(collectionInvalidated){collectionInvalidated=false;requestCollection();}}});
    collectionRequest={path,promise};collectionReads.add(promise);return promise;
  }
  const requestCollection=()=>{if(disposed||!vault.adapter.databases)return;if(collectionRequest){collectionInvalidated=true;return;}void prepareCollection().catch(()=>{});};

  const current = () => { try { return !disposed && options.isCurrent() && vault.adapter.documentSemantics === service; } catch { return false; } };
  const notify = () => { if (current()) { try { options.onChange(); } catch { /* A renderer cannot strand the query queue. */ } } };
  const selectedCollection=()=>{const entry=collectionPath?vault.entries.get(collectionPath):undefined;return current()&&collectionPath===options.getPath()&&entry?.type==='file'&&(entry.entryId?entry.entryId===collectionState?.entry.entryId:entry===collectionActor)?collectionState:undefined;};
  function invalidate() {
    if (!current()) return;
    requestCollection();
    serial++; abort?.abort(); wake?.(); wake = undefined;
    if (result) { result = undefined; notify(); }
    if (!service?.propertyTargetsAvailable || !clock.isVisible() || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; run(); }, 30);
  }
  function run() {
    if (!current() || !service?.propertyTargetsAvailable) return;
    const entry = vault.entries.get(options.getPath());
    if (!entry?.entryId || !entry.revision || entry.type !== 'file') return;
    const captured = ++serial, controller = new AbortController(); abort?.abort(); abort = controller;
    // Join the previous request's cancellation/close before opening another pin.
    pending = pending.then(async () => {
      const live = () => current() && serial === captured && !controller.signal.aborted && options.getPath() === entry.path
        && vault.entries.get(entry.path)?.entryId === entry.entryId && vault.entries.get(entry.path)?.revision === entry.revision;
      if (!live()) return;
      try {
        const next = await (options.query ?? queryPropertyTargets)({ service, vault, current: { ...entry }, readFile: path => vault.read(path), isCurrent: live, signal: controller.signal, clock });
        if (!live()) return;
        result = next.coverageComplete ? next : undefined; notify();
        const deadline = next.refreshHint?.nextWakeMs;
        if (deadline != null) wake = clock.scheduleAt(deadline, invalidate);
      } catch {
        // Unavailable, stale or incomplete choices stay unavailable. An existing
        // picker draft survives; no local evaluator supplies replacement rows.
        if (live()) { result = undefined; notify(); }
      }
    });
  }
  if(vault.adapter.databases){
    for(const event of ['create','modify','delete','rename','ready']as const)stops.push(vault.on(event,requestCollection));
    // A later normal invalidation retries a failed initial identity/membership
    // read. No polling or automatic failure loop is introduced.
    if(!service?.propertyTargetsAvailable)stops.push(vault.onMetadata(requestCollection));
    requestCollection();
  }
  if (service?.propertyTargetsAvailable) {
    for (const event of ['create', 'modify', 'delete', 'rename', 'ready'] as const) stops.push(vault.on(event, invalidate));
    const metadataWitness = (state: CommittedMetadataState | undefined) => JSON.stringify([state?.frame?.source, state?.frame?.snapshot, state?.frame?.coverageComplete]);
    let metadataState = vault.metadataFrame, metadataNotification = 0;
    const metadataSignature = (state: CommittedMetadataState | undefined) => `${state?.status}:${metadataWitness(state)}`;
    stops.push(vault.onMetadata(state => {
      const notification = ++metadataNotification;
      const apply = () => {
        if (disposed || notification !== metadataNotification) return;
        if (metadataSignature(state) !== metadataSignature(metadataState)) { metadataState = state; invalidate(); }
      };
      // A current runtime phase update makes the committed projection publish
      // stale/current synchronously for the same sealed frame. Cancelling here
      // would abort this manager's own freshness demand and repeat indefinitely.
      // Defer only that possible transient: persistent stale still invalidates,
      // while a changed witness, coverage or unavailable state acts immediately.
      if (state.status === 'stale' && metadataState?.status === 'current' && state.frame
        && metadataWitness(state) === metadataWitness(metadataState)) queueMicrotask(apply);
      else apply();
    }));
    if (service.maintenance) {
      let runtimeSignature = '';
      void service.maintenance.observeAndSubscribe(update => {
        const signature = JSON.stringify([update?.source, update?.published, update?.freshness]);
        if (signature !== runtimeSignature) { runtimeSignature = signature; invalidate(); }
      }).then(subscription => { if (disposed) subscription.unsubscribe(); else stops.push(subscription.unsubscribe); }, () => {});
    }
    stops.push(clock.subscribeWake(() => { if (!result || result.refreshHint?.dependency !== 'none' || clock.capture().timezone !== result.timezone) invalidate(); }));
    invalidate();
  }
  function destroy() {
    if (disposed) return;
    disposed = true; serial++; collectionSerial++;collectionState=undefined; abort?.abort(); wake?.(); wake = undefined;
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    for (const stop of stops.splice(0)) stop();
    result = undefined;
  }
  return {
    getCollection:selectedCollection,
    prepareCollection,
    getDefinitions(){
      const selected=selectedCollection();if(!selected)return{};
      return Object.fromEntries(selected.collection.properties.map(property=>[property.name,{type:property.datatype==='multi-select'?'multiselect':property.datatype,
        ...(property.options.length?{options:property.options.map(option=>({value:option.name,label:option.name,...(option.color?{color:option.color}:{}),...(option.category?{category:option.category==='not_started'?'todo' as const:option.category==='working'?'in-progress' as const:'done' as const}:{})}))}:{})} satisfies BasePropertyDefinition]));
    },
    get(property) { return current() && !result?.diagnostics.some(issue => !issue.property || issue.property === property || issue.property === `note.${property}`) ? result?.relationTargets[property] ?? result?.relationTargets[`note.${property}`] : undefined; },
    getDisplayValue(property, raw) {
      if (!current() || !result || !result.coverageComplete || result.diagnostics.some(issue => !issue.property || issue.property === property || issue.property === `note.${property}`)) return;
      const display = result.currentRelationValues, path = options.getPath(), entry = vault.entries.get(path), actor = result.current;
      if (!display || !actor || actor.kind !== 'file' || actor.deleted || !entry || entry.type !== 'file' || actor.path !== path || actor.id !== display.witness.entryId || actor.revision !== display.witness.revision || entry.entryId !== display.witness.entryId || entry.revision !== display.witness.revision) return;
      if (!Object.hasOwn(display.values, property) || !Object.hasOwn(display.editValues, property)) return;
      const baseline = display.editValues[property];
      return isPlainPropertyValue(raw) && isPlainPropertyValue(baseline) && baseValuesEqual(raw, baseline) ? display.values[property] : undefined;
    },
    invalidate, destroy,
    close() {
      destroy();
      if (closing) return closing;
      const reading=[...collectionReads];
      const task = pending.then(async () => { await Promise.allSettled(reading); if (service) await closePropertyTargetQueries(service); });
      closing = task;
      void task.then(() => {}, () => { if (closing === task) closing = undefined; });
      return task;
    },
  };
}
