export interface NoteTitleFocusOptions {
  /** Resolve only after saving and rebuilding any affected editor. */
  save: (name: string) => Promise<void>;
  /** Owner/file/tab identity, including the active pane when transferring focus. */
  isCurrent: () => boolean;
  focusBody: () => void;
  onError: (error: unknown) => void;
}

/** Unsubmitted input only. It cannot authorize a rename or reuse its old witness. */
export interface NoteTitleRawDraft {
  readonly baseline: string;
  readonly value: string;
  readonly focused: boolean;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly selectionDirection: 'forward' | 'backward' | 'none' | null;
}
export interface NoteTitleAdmissionRecovery {
  readonly rawDrafts: NoteTitleRawDraft;
  settle(): Promise<void>;
}
export interface NoteTitleFocusHandle {
  canRecoverAdmission(): boolean;
  prepareAdmissionRecovery(): NoteTitleAdmissionRecovery;
  restoreAdmissionDrafts(draft: NoteTitleRawDraft, options?: {focus?: boolean}): {
    restored: boolean; pending: boolean; conflicts: readonly {draft: NoteTitleRawDraft; reason: string}[];
  };
  destroy(): void;
}

/** Keep Enter's focus transfer behind asynchronous title persistence. */
export function bindNoteTitleFocus(title: HTMLInputElement, options: NoteTitleFocusOptions): NoteTitleFocusHandle {
  let pending: Promise<void> | undefined;
  const baseline = title.value;
  const restoredDrafts = new WeakSet<NoteTitleRawDraft>();
  let frozen = false, destroyed = false, composing = false, restoredPassive = false;
  let compositionDone: (() => void) | undefined, recovery: NoteTitleAdmissionRecovery | undefined;
  let composition:{start:string;update?:string;lastValue?:string;lastData?:string|null;lastFinal?:boolean;end?:string;cancelled?:boolean}|undefined;
  const finishComposition=()=>{
    if(!composition||composition.end===undefined)return;
    const value=title.value,ended=composition.end;
    const finalInput=composition.lastFinal&&composition.lastValue===value;
    const priorInput=!!ended&&composition.lastValue===value&&(ended===composition.update||ended===composition.lastData);
    const cancelled=ended===''&&value===composition.start&&(composition.cancelled||!composition.update&&!composition.lastValue);
    if(!finalInput&&!priorInput&&!cancelled)return;
    composing=false;composition=undefined;compositionDone?.();compositionDone=undefined;
  };
  const compositionStart = () => { if (!destroyed){composing=true;composition={start:title.value};} };
  const compositionUpdate = (event:CompositionEvent) => { if(composition)composition.update=event.data; };
  const compositionEnd = (event:CompositionEvent) => { if(composition){composition.end=event.data;finishComposition();} };
  const compositionInput=(event:Event)=>{if(composition){const input=event as InputEvent;composition.lastValue=title.value;composition.lastData=input.data;composition.lastFinal=input.isComposing===false;finishComposition();}};
  title.addEventListener('compositionstart', compositionStart);
  title.addEventListener('compositionupdate', compositionUpdate);title.addEventListener('input',compositionInput);
  title.addEventListener('compositionend', compositionEnd);
  const capture = (): NoteTitleRawDraft => ({baseline, value:title.value,
    focused:title.ownerDocument.activeElement===title,
    selectionStart:title.selectionStart, selectionEnd:title.selectionEnd, selectionDirection:title.selectionDirection});
  let enterRequested = false;
  const commit = (enter: boolean) => {
    if (frozen || destroyed || restoredPassive && !enter) return;
    restoredPassive = false;
    if (pending) { enterRequested ||= enter; return; }
    if (!title.isConnected) return;
    enterRequested = enter;
    const name = title.value.trim(), document = title.ownerDocument, wasReadOnly = title.readOnly;
    // A rename rebuilds this input. Do not accept a newer draft into a control
    // that will be replaced when the in-flight filename is committed.
    title.readOnly = true;
    let focusMoved = false;
    const moved = (event: FocusEvent) => { if (event.target !== title && event.target !== document.body) focusMoved = true; };
    document.addEventListener('focusin', moved, true);
    // Schedule after pending has been assigned: blur caused by focus transfer
    // must not recursively start another save, including an unchanged title.
    pending = Promise.resolve().then(async () => {
      if (!name) throw new Error('File name cannot be empty.');
      await options.save(name);
      if (enterRequested && !focusMoved && options.isCurrent()) {
        title.blur(); options.focusBody();
      }
    }).catch(options.onError).finally(() => {
      document.removeEventListener('focusin', moved, true);
      title.readOnly = wasReadOnly;
      pending = undefined; enterRequested = false;
    });
  };
  const keydown = title.onkeydown = event => {
    if(event.key==='Escape'&&composition)composition.cancelled=true;
    if (!frozen && !destroyed) restoredPassive = false;
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault(); commit(true);
  };
  const blur = title.onblur = () => commit(false);
  const freshInput = () => { if (!frozen && !destroyed) restoredPassive = false; };
  const freshPointer = () => { if (!frozen && !destroyed && title.ownerDocument.activeElement===title) restoredPassive=false; };
  title.addEventListener('input',freshInput);title.ownerDocument.addEventListener('pointerdown',freshPointer,true);
  return {
    canRecoverAdmission: () => !destroyed && !pending,
    prepareAdmissionRecovery() {
      if (recovery) return recovery;
      if (destroyed || pending) throw new Error('The submitted title rename is still pending.');
      // Freeze before the workspace changes focus or makes its old root inert.
      // Natural composition is allowed to finish; no input/blur event is replayed.
      let raw = capture(); frozen = true;
      const ready = composing ? new Promise<void>(resolve => { compositionDone = resolve; }) : Promise.resolve();
      const settled = ready.then(() => new Promise<void>(resolve => setTimeout(resolve, 0))).then(() => { raw = {...capture(),focused:raw.focused}; });
      return recovery = {get rawDrafts(){return raw;},settle:()=>settled};
    },
    restoreAdmissionDrafts(draft, restoreOptions) {
      if (!destroyed && !frozen && restoredDrafts.has(draft)) return {restored:true,pending:false,conflicts:[]};
      if (destroyed || frozen || pending || title.value !== baseline || baseline !== draft.baseline) return {
        restored:false,pending:false,conflicts:[{draft,reason:'The saved note title changed while storage reconnected.'}],
      };
      restoredPassive = true;title.value = draft.value;
      if (restoreOptions?.focus !== false && draft.focused) title.focus();
      if (draft.selectionStart !== null && draft.selectionEnd !== null) title.setSelectionRange(draft.selectionStart,draft.selectionEnd,draft.selectionDirection??undefined);
      restoredDrafts.add(draft);return {restored:true,pending:false,conflicts:[]};
    },
    destroy() {
      if (destroyed) return; destroyed = true; frozen = true;
      title.removeEventListener('compositionstart', compositionStart);title.removeEventListener('compositionend', compositionEnd);
      title.removeEventListener('compositionupdate',compositionUpdate);title.removeEventListener('input',compositionInput);
      title.removeEventListener('input',freshInput);title.ownerDocument.removeEventListener('pointerdown',freshPointer,true);
      if (title.onkeydown === keydown) title.onkeydown = null;if (title.onblur === blur) title.onblur = null;
    },
  };
}
