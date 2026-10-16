import { normalizePath } from './types.ts';

export type HandoffJson = null | boolean | number | string | HandoffJson[] | { [key: string]: HandoffJson };
export interface HandoffSelection { ranges: { anchor: number; head: number }[]; main: number }
/** Use JSON.parse(JSON.stringify(state.toJSON({history: historyField}))).
 * History is engine-version-specific; custom effects are not preserved by CM's history serializer. */
export interface HandoffEditorState {
  doc: string;
  selection: HandoffSelection;
  history: { [key: string]: HandoffJson };
  scrollTop: number;
  scrollLeft: number;
}
export interface WindowTabHandoff {
  version: 1;
  transferId: string;
  sourceWindowId: string;
  vaultId: string;
  /** Source leaf generation. Freeze it or abort if source changes before commit. */
  revision: number;
  tab: { id: string; path: string | null; kind: 'note' | 'graph'; mode: 'live' | 'reading'; subpath?: string };
  /** A recoverable buffer snapshot, not permission to overwrite current disk contents. */
  buffer?: { text: string; savedText: string; pendingWrite?: string; conflicted: boolean };
  editor?: HandoffEditorState;
  scroll: { top: number; left: number };
  /** Only include state with a real target restore adapter (PDF/Canvas/etc.). */
  view?: { type: string; state: { [key: string]: HandoffJson } };
}
const fail = (message: string): never => { throw new Error(`Invalid window handoff: ${message}`); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail('only plain objects are supported');
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => typeof value === 'string' ? value : fail(`${name} must be text`);
const id = (value: unknown, name: string): string => {
  const result = text(value, name);
  if (!result || result.length > 4096 || /[\u0000-\u001f\u007f]/.test(result)) return fail(`${name} must be a nonempty identifier`);
  return result;
};
const count = (value: unknown, name: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} must be a nonnegative integer`);
const offset = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail('scroll offset must be finite and nonnegative');

/** Clone only JSON data; reject getters, cycles, nonfinite numbers and oversized payloads.
 * Limits fail explicitly rather than silently dropping source/history. */
function cloneJson(value: unknown): HandoffJson {
  const seen = new Set<object>();
  let nodes = 0, units = 0;
  const copy = (input: unknown, depth: number): HandoffJson => {
    if (++nodes > 250_000 || depth > 64) return fail('JSON structure exceeds transfer limits');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : fail('nonfinite JSON number');
    if (typeof input === 'string') {
      units += input.length;
      if (units > 32 * 1024 * 1024) return fail('text/history exceeds transfer limit');
      return input;
    }
    if (!input || typeof input !== 'object') return fail('payload must contain JSON data only');
    if (seen.has(input)) return fail('cyclic payload');
    if (Object.getOwnPropertySymbols(input).length) return fail('symbol keys are not transferable');
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const descriptor of Object.values(descriptors)) if ('get' in descriptor || 'set' in descriptor) return fail('accessors are not transferable');
    let result: HandoffJson;
    if (Array.isArray(input)) {
      if (input.length > 250_000 - nodes) return fail('JSON array exceeds transfer limits');
      result = Array.from({ length: input.length }, (_, index) => copy(descriptors[String(index)]?.value, depth + 1));
    } else {
      object(input);
      const output: { [key: string]: HandoffJson } = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') return fail('reserved object key');
        units += key.length;
        if (units > 32 * 1024 * 1024) return fail('text/history exceeds transfer limit');
        output[key] = copy(descriptor.value, depth + 1);
      }
      result = output;
    }
    seen.delete(input);
    return result;
  };
  return copy(value, 0);
}

/** Validate and take an independent snapshot before sending across renderer IPC. */
export function parseWindowTabHandoff(value: unknown): WindowTabHandoff {
  const data = object(cloneJson(value));
  if (data.version !== 1) return fail('unsupported version');
  id(data.transferId, 'transferId'); id(data.sourceWindowId, 'sourceWindowId'); id(data.vaultId, 'vaultId'); count(data.revision, 'revision');
  const tab = object(data.tab);
  id(tab.id, 'tab.id');
  if (tab.path !== null) {
    const path = text(tab.path, 'tab.path');
    try { if (normalizePath(path) !== path) return fail('tab.path must be canonical'); }
    catch { return fail('tab.path must stay inside the vault'); }
  }
  if (tab.kind !== 'note' && tab.kind !== 'graph') return fail('unknown tab kind');
  if (tab.mode !== 'live' && tab.mode !== 'reading') return fail('unknown tab mode');
  if (tab.subpath !== undefined) text(tab.subpath, 'tab.subpath');
  const scroll = object(data.scroll); offset(scroll.top); offset(scroll.left);
  const buffer = data.buffer === undefined ? undefined : object(data.buffer);
  if (buffer) {
    if (tab.path === null || tab.kind !== 'note') return fail('buffer needs a file tab');
    text(buffer.text, 'buffer.text'); text(buffer.savedText, 'buffer.savedText');
    if (buffer.pendingWrite !== undefined) text(buffer.pendingWrite, 'buffer.pendingWrite');
    if (typeof buffer.conflicted !== 'boolean') return fail('buffer conflict flag missing');
  }
  if (data.editor !== undefined) {
    const editor = object(data.editor);
    if (!buffer || text(editor.doc, 'editor.doc') !== buffer.text) return fail('editor must match buffer text');
    offset(editor.scrollTop); offset(editor.scrollLeft); object(editor.history);
    const selection = object(editor.selection), ranges = selection.ranges;
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1000) return fail('invalid selection ranges');
    const main = count(selection.main, 'selection.main');
    if (main >= ranges.length) return fail('main selection is out of range');
    for (const value of ranges) {
      const range = object(value);
      if (count(range.anchor, 'selection.anchor') > (editor.doc as string).length || count(range.head, 'selection.head') > (editor.doc as string).length) return fail('selection exceeds document');
    }
  }
  if (data.view !== undefined) { const view = object(data.view); id(view.type, 'view.type'); object(view.state); }
  return data as unknown as WindowTabHandoff;
}

export interface WindowHandoffState {
  snapshot: WindowTabHandoff;
  targetWindowId: string;
  phase: 'offered' | 'ready' | 'committed' | 'aborted';
  reason?: string;
}
export type WindowHandoffEvent =
  | { type: 'target-ready'; transferId: string; windowId: string; revision: number }
  | { type: 'source-commit'; transferId: string; windowId: string; revision: number }
  | { type: 'abort'; transferId: string; windowId: string; reason: string };
/** The host authenticates real sender IDs and target vault binding before invoking this pure reducer. */
export function offerWindowHandoff(value: unknown, targetWindowId: string): WindowHandoffState {
  const snapshot = parseWindowTabHandoff(value);
  id(targetWindowId, 'targetWindowId');
  if (snapshot.sourceWindowId === targetWindowId) return fail('source and target must differ');
  return { snapshot, targetWindowId, phase: 'offered' };
}
export function advanceWindowHandoff(state: WindowHandoffState, event: WindowHandoffEvent): WindowHandoffState {
  if (!['target-ready', 'source-commit', 'abort'].includes(event.type)) throw new Error('Unknown handoff event');
  if (event.transferId !== state.snapshot.transferId) throw new Error('Handoff token mismatch');
  if (state.phase === 'aborted' || state.phase === 'committed') throw new Error('Handoff already settled');
  if (event.type === 'abort') {
    if (![state.snapshot.sourceWindowId, state.targetWindowId].includes(event.windowId)) throw new Error('Handoff participant mismatch');
    return { ...state, phase: 'aborted', reason: id(event.reason, 'abort reason') };
  }
  const expectedWindow = event.type === 'target-ready' ? state.targetWindowId : state.snapshot.sourceWindowId;
  if (event.windowId !== expectedWindow) throw new Error('Handoff participant mismatch');
  if (event.revision !== state.snapshot.revision) throw new Error('Handoff source revision changed');
  if (event.type === 'target-ready') {
    if (state.phase !== 'offered') throw new Error('Target already ready');
    return { ...state, phase: 'ready' };
  }
  if (state.phase !== 'ready') throw new Error('Target has not restored the handoff');
  return { ...state, phase: 'committed' };
}
/** Before commit the source retains recovery ownership and the target must stay inert. */
export function handoffOwner(state: WindowHandoffState): string {
  return state.phase === 'committed' ? state.targetWindowId : state.snapshot.sourceWindowId;
}
/** Decide whether restoring a dirty buffer can proceed without discarding an independent disk edit. */
export function reconcileHandoffBuffer(buffer: NonNullable<WindowTabHandoff['buffer']>, disk: string): 'base' | 'pending-write' | 'conflict' {
  if (disk === buffer.savedText) return 'base';
  if (buffer.pendingWrite !== undefined && disk === buffer.pendingWrite) return 'pending-write';
  return 'conflict';
}
