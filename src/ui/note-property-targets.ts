import type { Vault } from '../core/vault.ts';
import type { CommittedMetadataState } from '../core/committed-metadata-frame.ts';
import { createBaseClockHost } from '../bases/clock.ts';
import type { BaseClockHost } from '../bases/clock.ts';
import { closePropertyTargetQueries, isPlainPropertyValue, queryPropertyTargets } from '../bases/property-targets.ts';
import type { PropertyTarget, PropertyTargetsResult } from '../bases/property-targets.ts';
import { baseValuesEqual } from '../bases/expression.ts';
import type { BaseExpressionValue } from '../bases/expression.ts';

export interface NotePropertyTargets {
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
  const current = () => { try { return !disposed && options.isCurrent() && vault.adapter.documentSemantics === service; } catch { return false; } };
  const notify = () => { if (current()) { try { options.onChange(); } catch { /* A renderer cannot strand the query queue. */ } } };
  function invalidate() {
    if (!current()) return;
    serial++; abort?.abort(); wake?.(); wake = undefined;
    if (result) { result = undefined; notify(); }
    if (!service?.propertyTargetsAvailable || !clock.isVisible() || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; run(); }, 30);
  }
  function run() {
    if (!current() || !service?.propertyTargetsAvailable) return;
    const entry = vault.entries.get(options.getPath());
    if (!entry?.entryId || !entry.revision || entry.type !== 'file' || !vault.entries.has('Properties.yaml')) return;
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
    disposed = true; serial++; abort?.abort(); wake?.(); wake = undefined;
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    for (const stop of stops.splice(0)) stop();
    result = undefined;
  }
  return {
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
      const task = pending.then(async () => { if (service) await closePropertyTargetQueries(service); });
      closing = task;
      void task.then(() => {}, () => { if (closing === task) closing = undefined; });
      return task;
    },
  };
}
