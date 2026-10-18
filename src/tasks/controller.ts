import { catchUpDocumentIndex } from '../core/document-semantics.ts';
import type { DocumentPin, DocumentService, DocumentTaskFilter, DocumentTasksRead, DocumentTaskRow, DocumentTaskType, DocumentTaskWitness, DocumentValue } from '../core/document-semantics.ts';
import { createTaskPreset } from './presets.ts';
import type { TaskPreset } from './presets.ts';

/** Host owns ordinary file mutations, durable save and dirty-buffer admission.
 * Every witness must be checked again at mutation time, including the type file.
 * Successful promises mean durable success, never merely queued editor changes. */
export interface TaskCaptureRequest {
  readonly captureId: string; readonly title: string; readonly destination: string;
  readonly typeWitness: DocumentTaskWitness; readonly properties: Readonly<Record<string, DocumentValue>>;
}
export interface TasksHost {
  readonly documents: DocumentService;
  /** Current ordinary YAML file EntryIds, not semantic type IDs or paths. */
  typeDefinitionIds(): readonly string[];
  createTask(input: TaskCaptureRequest): Promise<void>;
  editTask(input: { expectedTypeId: string; witness: DocumentTaskWitness; typeWitness: DocumentTaskWitness; properties: Readonly<Record<string, string | null>> }): Promise<void>;
  openTask(witness: DocumentTaskWitness): Promise<void>;
  /** Non-clobber create of ordinary Type/Base files; never overwrite or rollback
   * by deleting an existing file. Partial creation must be reported as failure. */
  installPreset(preset: TaskPreset): Promise<void>;
  subscribe?(listener: () => void): () => void;
}
export interface TaskDraft {
  readonly row: DocumentTaskRow;
  readonly type: DocumentTaskType;
  status: string; plannedDay: string; deadline: string;
}
export interface TaskCaptureDraft { title: string; destination: string; typeId: string }
export interface TasksState {
  busy: boolean; error: string | null; data: DocumentTasksRead | null;
  filter: DocumentTaskFilter; showDone: boolean;
  unconfirmedCapture: TaskCaptureRequest | null;
  capture: TaskCaptureDraft; drafts: Map<string, TaskDraft>;
}
const message = (error: unknown) => {
  const code = (error as {code?: string})?.code;
  return code === 'snapshot_expired' ? 'This task snapshot expired. Refresh to reopen it; your drafts are retained.'
    : error instanceof Error ? `${code ? code + ': ' : ''}${error.message}` : String(error);
};
/** Detach retained intents from mutable transport/host objects, including
 * nested defaults. This copies DTO data only and interprets no query semantics. */
function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  freeze(copy); return copy;
}
function validDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number), date = new Date(0);
  date.setUTCFullYear(y,m-1,d); date.setUTCHours(0,0,0,0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m-1 && date.getUTCDate() === d;
}
export function taskReadDiagnostics(data: DocumentTasksRead): string[] {
  const r = data.result, messages: string[] = [];
  if (!r.coverageComplete) messages.push('Incomplete task coverage. Some saved notes could not be read.');
  if (r.truncated) messages.push(`Showing ${r.rows.length} of ${r.matched} matching tasks. Narrow the filter to see more.`);
  for (const d of r.typeDiagnostics) messages.push(`${data.definitions.find(f => f.id === d.witness.entryId)?.path ?? 'Type definition'}: ${d.code.replaceAll('_',' ')}`);
  for (const d of r.diagnostics) messages.push(`${r.rows.find(row => row.witness.entryId === d.witness.entryId)?.path ?? 'Saved task'}, ${d.property}: ${d.code.replaceAll('_',' ')}`);
  for (const d of r.metadataIssues) messages.push(`A saved note: ${d.exclusion ?? 'properties unavailable'}`);
  return messages;
}
export type TasksPhase = 'active' | 'preparing' | 'prepared' | 'disposed';
export class TasksController {
  readonly state: TasksState = {busy:false,error:null,data:null,filter:'all',showDone:false,unconfirmedCapture:null,capture:{title:'',destination:'Tasks',typeId:''},drafts:new Map()};
  private pins = new Set<DocumentPin>();
  private listeners = new Set<() => void>();
  private lifecycle: TasksPhase = 'active';
  private closeRun?: Promise<void>;
  private closeCancelled = false;
  get phase(): TasksPhase { return this.lifecycle; }
  private refreshRequested = false;
  private running: Promise<void> | undefined;
  private unsubscribe?: () => void;
  readonly host: TasksHost;
  constructor(host: TasksHost) { this.host = host; this.connect(); }
  private connect(): void { this.unsubscribe = this.host.subscribe?.(() => { void this.refresh(); }); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { if (this.phase !== 'disposed') for (const listener of this.listeners) listener(); }
  /** Fallible close work belongs before a host runtime marks itself disposed.
   * Failed preparation leaves this controller subscribed and retryable. */
  prepareClose(): Promise<void> {
    if (this.phase === 'prepared' || this.phase === 'disposed') return Promise.resolve();
    if (this.closeRun) return this.closeRun;
    this.lifecycle = 'preparing'; this.closeCancelled = false; this.refreshRequested = false;
    const run = Promise.resolve().then(async () => {
      try {
        await this.running;
        if (this.hasDrafts()) throw Error('Tasks has unsaved or unconfirmed changes. Save, discard, or resolve them before closing.');
        if (this.closeCancelled) throw Error('Tasks close was cancelled.');
        await this.closePins();
        if (this.closeCancelled) throw Error('Tasks close was cancelled.');
        // Subscriptions remain attached through fallible pin cleanup. Once this
        // succeeds, final destruction performs no host callback or async work.
        this.unsubscribe?.(); this.unsubscribe = undefined;
        this.lifecycle = 'prepared'; this.emit();
      } catch (error) {
        this.lifecycle = 'active'; this.state.error = message(error); this.emit(); throw error;
      }
    });
    this.closeRun = run;
    void run.finally(() => { if (this.closeRun === run) this.closeRun = undefined; }).catch(() => {});
    this.emit(); return run;
  }
  /** In-flight cancellation waits for the current read/close to drain before
   * prepareClose rejects and restores active input. No overlapping pin use. */
  cancelClose(): void {
    if (this.phase === 'preparing') { this.closeCancelled = true; return; }
    if (this.phase !== 'prepared') return;
    this.lifecycle = 'active'; this.connect(); this.emit();
  }
  /** Valid only after successful preparation; repeated destruction is harmless.
   * There are no remaining leases, host callbacks or promises to reject. */
  destroy(): void {
    if (this.phase === 'disposed') return;
    if (this.phase !== 'prepared') throw Error('Prepare Tasks close before destruction.');
    this.lifecycle = 'disposed'; this.listeners.clear();
  }
  async dispose(): Promise<void> { await this.prepareClose(); this.destroy(); }
  /** Coalesced and serialized: pin close never overlaps its read. No silent expiry retry. */
  refresh(): Promise<void> {
    if (this.phase !== 'active') return Promise.resolve();
    if (this.state.busy) { this.refreshRequested = true; return this.running ?? Promise.resolve(); }
    this.running = this.perform(async () => {
      await this.closePins();
      const status = await catchUpDocumentIndex(this.host.documents,{isCurrent:() => this.phase === 'active'});
      if (this.phase !== 'active') return;
      if (!status.current || status.rebuildRequired) throw Error('Saved notes are still being indexed. Refresh to reopen Tasks.');
      const pin = await this.host.documents.open(); this.pins.add(pin);
      try {
        if (!pin.tasks) throw Error('Tasks queries are unavailable in this vault.');
        const reply = await pin.tasks({typeIds:[...this.host.typeDefinitionIds()],options:{filter:this.state.filter,showDone:this.state.showDone,clockMs:Date.now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,maxRows:1000}});
        if (this.phase !== 'active') return;
        this.state.data = reply.value;
        if (!this.state.capture.typeId) this.state.capture.typeId = reply.value.types[0]?.typeId ?? '';
      } finally { await this.closePin(pin); }
    });
    return this.running;
  }
  private async closePin(pin: DocumentPin): Promise<void> { await pin.close(); this.pins.delete(pin); }
  private async closePins(): Promise<void> { for (const pin of this.pins) await this.closePin(pin); }
  flush(): Promise<void> { return this.running ?? Promise.resolve(); }
  private hasDrafts(): boolean { return !!this.state.unconfirmedCapture || !!this.state.capture.title || this.state.drafts.size > 0; }
  hasPendingChanges(): boolean { return this.state.busy || this.hasDrafts(); }
  private perform(action: () => Promise<void>): Promise<void> {
    if (this.phase !== 'active' || this.state.busy) return Promise.resolve();
    this.state.busy = true; this.state.error = null; this.emit();
    this.running = (async () => {
    try { await action(); } catch (error) { this.state.error = message(error); }
    finally {
      this.state.busy = false; this.emit();
      if (this.refreshRequested && this.phase === 'active') { this.refreshRequested = false; queueMicrotask(() => { void this.refresh(); }); }
    }
    })();
    return this.running;
  }
  setFilter(filter: DocumentTaskFilter, showDone = this.state.showDone): void { if (this.phase !== 'active') return; this.state.filter = filter; this.state.showDone = showDone; void this.refresh(); }
  beginEdit(row: DocumentTaskRow): void {
    if (this.phase !== 'active') return;
    if (this.state.drafts.has(row.witness.entryId)) return;
    const type = this.state.data?.types.find(t => t.typeId === row.typeId);
    if (!type) { this.state.error = 'Task type is unavailable. Refresh before editing.'; this.emit(); return; }
    this.state.drafts.set(row.witness.entryId,{row:immutableCopy(row),type:immutableCopy(type),status:row.statusId ?? '',plannedDay:row.plannedDay ?? '',deadline:row.deadline ?? ''}); this.emit();
  }
  discard(id: string): void { if (this.phase !== 'active') return; this.state.drafts.delete(id); this.emit(); }
  save(id: string): Promise<void> {
    return this.perform(async () => {
      const draft = this.state.drafts.get(id); if (!draft) return;
      const {type,row} = draft;
      const properties: Record<string,string|null> = {};
      if (draft.status !== (row.statusId ?? '')) {
        if (!type.status.options.some(o => o.id === draft.status)) throw Error('Choose a known status before saving.');
        properties[type.status.key] = draft.status;
      }
      for (const field of ['plannedDay','deadline'] as const) {
        if (!validDate(draft[field])) throw Error('Use a valid calendar date (YYYY-MM-DD).');
        if (draft[field] !== (row[field] ?? '') && type[field]) properties[type[field]!.key] = draft[field] || null;
      }
      if (Object.keys(properties).length) await this.host.editTask({expectedTypeId:row.typeId,witness:row.witness,typeWitness:type.witness,properties});
      this.state.drafts.delete(id); this.refreshRequested = true;
    });
  }
  capture(): Promise<void> {
    return this.perform(async () => {
      if (this.state.unconfirmedCapture) throw Error('An earlier capture is unconfirmed. Check the vault and resolve it before creating another task.');
      const draft = this.state.capture, type = this.state.data?.types.find(t => t.typeId === draft.typeId);
      if (!type) throw Error('Choose an available task type.');
      if (!draft.title.trim()) throw Error('Enter a task title.');
      const request: TaskCaptureRequest = immutableCopy({captureId:crypto.randomUUID(),title:draft.title.trim(),destination:draft.destination,typeWitness:type.witness,properties:Object.fromEntries(type.captureDefaults)});
      this.state.unconfirmedCapture = request;
      try { await this.host.createTask(request); }
      catch (error) {
        if ((error as {commitUncertain?:boolean})?.commitUncertain === false) this.state.unconfirmedCapture = null;
        else throw Error('Task creation is unconfirmed. Your capture is retained. Check the vault before resolving this capture; creating again could duplicate it.');
        throw error;
      }
      this.state.unconfirmedCapture = null;
      draft.title = ''; this.refreshRequested = true;
    });
  }
  /** Explicit user reconciliation after checking ordinary vault files. Never
   * automatically resend an uncertain create, including after refresh. */
  resolveCapture(found: boolean): void {
    if (this.phase !== 'active' || this.state.busy || !this.state.unconfirmedCapture) return;
    this.state.unconfirmedCapture = null;
    if (found) this.state.capture.title = '';
    this.state.error = null; this.emit(); void this.refresh();
  }
  open(row: DocumentTaskRow): Promise<void> { return this.perform(() => this.host.openTask(row.witness)); }
  install(locations: {type?: string; base?: string; destination?: string} = {}): Promise<void> {
    return this.perform(async () => {
      if (locations.type && !locations.type.startsWith('Types/')) throw Error('Choose a Type file inside the Types/ folder so Tasks can discover it.');
      const id = () => crypto.randomUUID();
      const preset = createTaskPreset({type:id(),status:id(),planned:id(),deadline:id(),todo:id(),working:id(),done:id()},locations);
      await this.host.installPreset(preset); this.refreshRequested = true;
    });
  }
}
