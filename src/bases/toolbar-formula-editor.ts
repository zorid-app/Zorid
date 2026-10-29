import { Compartment, EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap, snippetCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { parseBaseExpression } from './expression.ts';
import type { BaseExpression } from './expression.ts';

export interface BaseFormulaEditorOptions {
  propertyIds?: readonly string[];
  functionNames?: readonly string[];
  /** Supported receiver methods supplied by the caller, never discovered by evaluation. */
  methodNames?: readonly string[];
  /** Invoked by Escape only after CodeMirror's completion handler declines it. */
  onEscape?(): void;
  /** Submit on an unhandled Tab while retaining normal browser focus navigation. */
  onCommit?(): void;
  /** Syntax diagnostics only: editing never evaluates an expression. */
  onDiagnostics?(message: string | undefined): void;
}
export interface BaseFormulaAdmissionDraft {
  /** Native/CodeMirror construction baseline; the outer saved-configuration
   * owner must independently admit its fresh actor/source before reconstructing. */
  readonly initial:string;
  readonly state:{readonly text:string;readonly selection:readonly {readonly anchor:number;readonly head:number}[];readonly mainIndex:number;readonly scrollTop:number;readonly scrollLeft:number;readonly focus:boolean};
  readonly ready:Promise<void>;
}
const completedFormulaDrafts=new WeakSet<BaseFormulaAdmissionDraft>();
export interface BaseFormulaEditor {
  canCaptureAdmissionDraft():boolean;
  captureFreeze():BaseFormulaAdmissionDraft|undefined;
  restoreAdmissionDraft(draft:BaseFormulaAdmissionDraft):boolean;
  sync(): void;
  focus(): void;
  hasFocus(): boolean;
  destroy(): void;
}
export type BaseSummaryEditorOptions = Pick<BaseFormulaEditorOptions, 'functionNames' | 'methodNames' | 'onEscape' | 'onCommit' | 'onDiagnostics'>;

// Summary scope contains an empty list named values in the reference editor.
// Candidates below are implemented by the shared Rust evaluator; no host or
// note context is probed to discover completions, and drafts are never evaluated.
const summaryFunctions = ['if','date','duration','list','max','min','number','now','today','escapeHTML'] as const;
const summaryBaseMethods = ['isTruthy','isEmpty','toString','isType'] as const;
const summaryListMethods = ['contains','containsAll','containsAny','filter','flat','join','map','reduce','reverse','slice','sort','unique','sum','mean'] as const;
const listReturningMethods = new Set(['filter','flat','map','reverse','slice','sort','unique']);
function summaryReceiverKind(expression: BaseExpression): 'list' | 'scalar' | undefined {
  if (expression.kind === 'identifier') return expression.name.toLowerCase() === 'values' ? 'list' : undefined;
  if (expression.kind === 'list') return 'list';
  if (expression.kind === 'literal') return 'scalar';
  if (expression.kind === 'call') {
    if (expression.callee.kind === 'identifier') {
      const name = expression.callee.name;
      if(name === 'if') { const yes=expression.args[1] && summaryReceiverKind(expression.args[1]), no=expression.args[2] && summaryReceiverKind(expression.args[2]); return yes===no ? yes : undefined; }
      return name === 'list' ? 'list' : (summaryFunctions as readonly string[]).includes(name) ? 'scalar' : undefined;
    }
    const callee = expression.callee;
    if (callee.kind === 'member' && callee.key.kind === 'literal' && callee.key.value.type === 'string') {
      const receiver = summaryReceiverKind(callee.object), method = callee.key.value.value;
      if (receiver === 'list' && (summaryListMethods as readonly string[]).includes(method)) return listReturningMethods.has(method) ? 'list' : 'scalar';
      if (receiver && (summaryBaseMethods as readonly string[]).includes(method)) return 'scalar';
    }
  }
  if (expression.kind === 'member' && expression.key.kind === 'literal' && expression.key.value.type === 'string' && expression.key.value.value === 'length' && summaryReceiverKind(expression.object) === 'list') return 'scalar';
  return undefined;
}
/** Isolate the receiver in a partially typed call or arithmetic expression. */
function summaryReceiverSource(source:string):string {
  let depth=0;
  for(let index=source.length-1;index>=0;index--){
    const character=source[index];
    if(character==='"'||character==="'"){
      const quote=character;
      for(index--;index>=0;index--){
        if(source[index]!==quote)continue;
        let slashes=0;for(let before=index-1;before>=0&&source[before]==='\\';before--)slashes++;
        if(slashes%2===0)break;
      }
    }else if(character===')'||character===']')depth++;
    else if(character==='('||character==='['){if(depth)depth--;else return source.slice(index+1).trim();}
    else if(!depth&&/[,+\-*/%!<>=&|]/u.test(character))return source.slice(index+1).trim();
  }
  return source.trim();
}

// Original lexical presentation, independent of the expression evaluator. The
// parser remains the authority for syntax diagnostics (highlighting is tolerant).
const formulaLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)/)) return 'string';
    if (stream.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/(?:true|false|null)\b/)) return 'keyword';
    if (stream.match(/[$_\p{L}][$_\p{L}\p{N}\p{M}]*/u)) return /^\s*\(/.test(stream.string.slice(stream.pos)) ? 'variableName.function' : 'propertyName';
    if (stream.match(/[+*/%!<>=&|\-]+/)) return 'operator';
    stream.next(); return null;
  },
});
const formulaHighlight = HighlightStyle.define([
  { tag: tags.string, color: 'var(--color-green, #5c8f5c)' },
  { tag: tags.number, color: 'var(--color-orange, #bf7548)' },
  { tag: tags.keyword, color: 'var(--color-purple, #9562ba)' },
  { tag: tags.function(tags.variableName), color: 'var(--color-blue, #5688b6)' },
  { tag: tags.propertyName, color: 'var(--text-normal)' },
]);

function propertyExpression(id: string): string {
  const match = /^(note|file|formula|this)\.(.*)$/u.exec(id);
  if (!match || /^[$_\p{L}][$_\p{L}\p{N}\p{M}]*$/u.test(match[2])) return id;
  return `${match[1]}[${JSON.stringify(match[2])}]`;
}

function completions(options: BaseFormulaEditorOptions, summary = false) {
  const properties: Completion[] = Array.from(new Set(options.propertyIds ?? []), id => ({ label: id, type: 'property', apply: propertyExpression(id) }));
  const callable = (names: readonly string[], type: string) => Array.from(new Set(names.map(name => name.replace(/\(\)$/u, ''))), name => snippetCompletion(`${name}(\${})`, { label: `${name}()`, type }));
  const values = [...properties, ...callable(options.functionNames ?? [], 'function')];
  const methods = callable(options.methodNames ?? [], 'method');
  return (context: CompletionContext) => {
    const source = context.state.sliceDoc(0, context.pos);
    // Scan quotes rather than matching a trailing quote: a completed string
    // receiver ("text".contains) is different from an unfinished string value.
    let quote: string | undefined, escaped = false;
    for (const character of source) {
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
    }
    if (quote) return null;
    const suffix = context.matchBefore(/[$_\p{L}\p{N}\p{M}]*$/u)!;
    const receiver = source.slice(0, suffix.from).trimEnd();
    if (receiver.endsWith('.')) {
      if (summary) {
        let kind: ReturnType<typeof summaryReceiverKind>;
        try { kind = summaryReceiverKind(parseBaseExpression(summaryReceiverSource(receiver.slice(0,-1)))); } catch { return null; }
        if (!kind) return null;
        const members = kind === 'list' ? [{label:'length',type:'property'},...methods] : methods.filter(method => (summaryBaseMethods as readonly string[]).includes(method.label.replace(/\(\)$/u,'')));
        return {from:suffix.from,options:members,validFor:/^[$_\p{L}\p{N}\p{M}]*$/u};
      }
      // Only a bare namespace uses full property IDs. For actual receivers,
      // replace the identifier after the final dot, preserving calls, bracket
      // properties, nested members and all preceding expression text.
      const namespace = /(^|[^.$_\p{L}\p{N}\p{M}])([$_\p{L}][$_\p{L}\p{N}\p{M}]*)\.$/u.exec(receiver);
      const namespaceProperties = namespace && properties.filter(property => property.label.startsWith(`${namespace[2]}.`));
      if (namespace && namespaceProperties?.length) {
        const prefix = `${namespace[2]}.`;
        return { from: receiver.length - prefix.length, options: namespaceProperties,
          validFor: (text: string) => text.startsWith(prefix) && /^[$_\p{L}\p{N}\p{M}]*$/u.test(text.slice(prefix.length)) };
      }
      if (!receiver.slice(0, -1).trim() || !methods.length) return null;
      return { from: suffix.from, options: methods, validFor: /^[$_\p{L}\p{N}\p{M}]*$/u };
    }
    const word = context.matchBefore(/[$\p{L}\p{N}\p{M}_.]*/u);
    if (!word || (!context.explicit && word.from === word.to)) return null;
    // A new dot changes completion context, so cached global candidates must
    // expire rather than replacing the receiver with a global/property value.
    return { from: word.from, options: values, validFor: /^[$_\p{L}\p{N}\p{M}]*$/u };
  };
}

let nextDiagnosticId = 0;

function syntaxDiagnostic(value: string): string | undefined {
  if (value.trim()) {
    try { parseBaseExpression(value); }
    catch (failure) { return failure instanceof Error ? failure.message : String(failure); }
  }
  return undefined;
}

/** Formula-local custody. Final input is confirmed by actual composition/input
 * events; CodeMirror then supplies a snapshot after its own DOM flush. */
function formulaAdmissionOwner(surface:HTMLElement,initial:string,options:{alive():boolean;read():BaseFormulaAdmissionDraft['state'];restore(state:BaseFormulaAdmissionDraft['state']):void;lockNative():void;freeze():void;settle(done:(state:BaseFormulaAdmissionDraft['state'])=>void):void}) {
  let frozen=false,restoring=false,interacted=false,composing=false,settling=false,captured:BaseFormulaAdmissionDraft|undefined,finish:(()=>void)|undefined;
  let startDOM='',updateData:string|undefined,lastInput:{dom:string;data:string|null;update?:string}|undefined;
  const dom=()=>surface instanceof surface.ownerDocument.defaultView!.HTMLTextAreaElement?surface.value:surface.textContent??'';
  const start=(event:CompositionEvent)=>{if(frozen)return;composing=true;settling=false;startDOM=dom();updateData=undefined;lastInput=undefined;};
  const update=(event:CompositionEvent)=>{if(composing)updateData=event.data;};
  const input=(event:Event)=>{if(!frozen&&!restoring)interacted=true;if(composing)lastInput={dom:dom(),data:(event as InputEvent).data??null,update:updateData};else{settling=false;finish?.();}};
  const end=(event:CompositionEvent)=>{composing=false;settling=!(event.data===''&&dom()===startDOM||lastInput?.dom===dom()&&(lastInput.data===event.data||lastInput.update===event.data));finish?.();};
  const interaction=()=>{if(!frozen&&!restoring)interacted=true;};
  surface.addEventListener('compositionstart',start,true);surface.addEventListener('compositionupdate',update,true);surface.addEventListener('compositionend',end,true);surface.addEventListener('input',input,true);surface.addEventListener('keydown',interaction,true);surface.addEventListener('pointerdown',interaction,true);
  const canCaptureAdmissionDraft=()=>!!captured||options.alive();
  function captureFreeze():BaseFormulaAdmissionDraft|undefined {
    if(captured)return captured;if(!canCaptureAdmissionDraft())return;frozen=true;const focused=options.read().focus;let state=options.read(),resolve!:()=>void,pending=false;const ready=new Promise<void>(yes=>{resolve=yes;});
    const draft:BaseFormulaAdmissionDraft={initial,get state(){return state;},ready};captured=draft;
    finish=()=>{if(composing||settling||pending||completedFormulaDrafts.has(draft))return;pending=true;options.lockNative();options.settle(snapshot=>{pending=false;if(composing||settling||completedFormulaDrafts.has(draft)||!options.alive())return;state={...snapshot,focus:focused};options.freeze();completedFormulaDrafts.add(draft);resolve();finish=undefined;});};finish();return draft;
  }
  function restoreAdmissionDraft(draft:BaseFormulaAdmissionDraft):boolean {
    if(frozen||interacted||composing||settling||!options.alive()||options.read().text!==initial||initial!==draft.initial||!completedFormulaDrafts.has(draft))return false;
    restoring=true;try{options.restore(draft.state);return true;}finally{restoring=false;}
  }
  return{canCaptureAdmissionDraft,captureFreeze,restoreAdmissionDraft,frozen:()=>frozen,changed(){if(!frozen&&!restoring)interacted=true;finish?.();},destroy(){surface.removeEventListener('compositionstart',start,true);surface.removeEventListener('compositionupdate',update,true);surface.removeEventListener('compositionend',end,true);surface.removeEventListener('input',input,true);surface.removeEventListener('keydown',interaction,true);surface.removeEventListener('pointerdown',interaction,true);}};
}

// Owner-document-only hosts (for example inert DOM previews) cannot construct
// CodeMirror, which requires browser globals. Keep their native draft usable.
function nativeFormulaEditor(textarea: HTMLTextAreaElement, options: BaseFormulaEditorOptions): BaseFormulaEditor {
  const doc = textarea.ownerDocument, wrapper = doc.createElement('div'), error = doc.createElement('div');
  wrapper.className = 'bases-formula-editor'; error.className = 'bases-formula-editor-error';
  error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  textarea.insertAdjacentElement('afterend', wrapper); wrapper.append(textarea, error);
  let destroyed = false, lastDiagnostic: string | undefined;const initial=textarea.value;let admission:ReturnType<typeof formulaAdmissionOwner>|undefined;
  const sync = () => {
    if (destroyed) return;
    const message = syntaxDiagnostic(textarea.value); error.hidden = !message; error.textContent = message ?? '';
    if (message !== lastDiagnostic) { lastDiagnostic = message; options.onDiagnostics?.(message); }
  };
  const keydown = (event: KeyboardEvent) => {
    if(admission?.frozen()){if(!event.isComposing&&event.keyCode!==229&&(event.key==='Escape'||event.key==='Tab'))event.preventDefault();return;}
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && options.onEscape) { event.preventDefault(); options.onEscape(); }
    else if (event.key === 'Tab' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
      && !event.altKey && !event.ctrlKey && !event.metaKey && !destroyed && textarea.isConnected
      && doc.activeElement === textarea && !textarea.disabled && !textarea.readOnly && !textarea.closest('[inert]')) options.onCommit?.();
  };
  textarea.addEventListener('input', sync); textarea.addEventListener('keydown', keydown); sync();
  admission=formulaAdmissionOwner(textarea,initial,{alive:()=>!destroyed&&textarea.isConnected,read:()=>{const start=textarea.selectionStart??0,end=textarea.selectionEnd??start,backward=textarea.selectionDirection==='backward';return{text:textarea.value,selection:[{anchor:backward?end:start,head:backward?start:end}],mainIndex:0,scrollTop:textarea.scrollTop,scrollLeft:textarea.scrollLeft,focus:doc.activeElement===textarea};},restore:state=>{textarea.value=state.text;const selected=state.selection[state.mainIndex]??{anchor:0,head:0};textarea.setSelectionRange(Math.min(selected.anchor,selected.head),Math.max(selected.anchor,selected.head),selected.head<selected.anchor?'backward':'forward');textarea.scrollTop=state.scrollTop;textarea.scrollLeft=state.scrollLeft;sync();if(state.focus)textarea.focus({preventScroll:true});},lockNative:()=>{textarea.readOnly=true;},freeze:()=>{textarea.readOnly=true;},settle:done=>done(admissionState())});
  function admissionState():BaseFormulaAdmissionDraft['state']{const start=textarea.selectionStart??0,end=textarea.selectionEnd??start,backward=textarea.selectionDirection==='backward';return{text:textarea.value,selection:[{anchor:backward?end:start,head:backward?start:end}],mainIndex:0,scrollTop:textarea.scrollTop,scrollLeft:textarea.scrollLeft,focus:doc.activeElement===textarea};}
  return {canCaptureAdmissionDraft:admission.canCaptureAdmissionDraft,captureFreeze:admission.captureFreeze,restoreAdmissionDraft:admission.restoreAdmissionDraft, sync, focus() { if (!destroyed) textarea.focus(); }, hasFocus: () => !destroyed && doc.activeElement === textarea, destroy() {
    if (destroyed) return;
    destroyed = true;admission?.destroy(); textarea.removeEventListener('input', sync); textarea.removeEventListener('keydown', keydown);
    if (wrapper.contains(textarea)) wrapper.replaceWith(textarea); else wrapper.remove();
  } };
}

/** Enhance a native draft model; CodeMirror owns text, selection, IME and undo. */
export function enhanceBaseFormulaEditor(textarea: HTMLTextAreaElement, options: BaseFormulaEditorOptions = {}): BaseFormulaEditor {
  return enhanceFormulaEditor(textarea,options);
}

/** Shared presentation with only the summary's values/list completion context. */
export function enhanceBaseSummaryEditor(textarea: HTMLTextAreaElement, options: BaseSummaryEditorOptions = {}): BaseFormulaEditor {
  const supported = (provided: readonly string[] | undefined, allowed: readonly string[]) => provided === undefined ? allowed : provided.filter(name => allowed.includes(name.replace(/\(\)$/u,'')));
  return enhanceFormulaEditor(textarea,{
    onEscape:options.onEscape,onCommit:options.onCommit,onDiagnostics:options.onDiagnostics,propertyIds:['values'],
    functionNames:supported(options.functionNames,summaryFunctions),
    methodNames:supported(options.methodNames,[...summaryBaseMethods,...summaryListMethods]),
  },true);
}

function enhanceFormulaEditor(textarea: HTMLTextAreaElement, options: BaseFormulaEditorOptions, summary = false): BaseFormulaEditor {
  if (typeof document === 'undefined') return nativeFormulaEditor(textarea, options);
  const doc = textarea.ownerDocument, win = doc.defaultView;
  const original = { hidden: textarea.hidden, ariaHidden: textarea.getAttribute('aria-hidden'), tabIndex: textarea.getAttribute('tabindex') };
  const wrapper = doc.createElement('div'); wrapper.className = 'bases-formula-editor';
  const error = doc.createElement('div'); error.className = 'bases-formula-editor-error';
  error.id = `bases-formula-diagnostic-${++nextDiagnosticId}`; error.hidden = true;
  error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  textarea.insertAdjacentElement('afterend', wrapper);
  textarea.hidden = true; textarea.tabIndex = -1; textarea.setAttribute('aria-hidden', 'true');
  let destroyed = false, synchronizing = false, publishing = false, composingKey = false, lastDiagnostic: string | undefined;const initial=textarea.value;let admission:ReturnType<typeof formulaAdmissionOwner>|undefined;
  const attributes = new Compartment(), editability = new Compartment();
  const contentAttributes = () => [EditorView.contentAttributes.of({
    'aria-label': textarea.getAttribute('aria-label') ?? 'Formula',
    'aria-multiline': 'true',
    'aria-readonly': String(textarea.readOnly || textarea.disabled),
    'aria-describedby': [textarea.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '),
  }),placeholder(textarea.placeholder)];
  const editable = () => [EditorState.readOnly.of(textarea.readOnly || textarea.disabled), EditorView.editable.of(!textarea.readOnly && !textarea.disabled)];
  const restoreNative = () => {
    textarea.hidden = original.hidden;
    for (const [name, value] of [['aria-hidden', original.ariaHidden], ['tabindex', original.tabIndex]] as const) {
      if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value);
    }
  };
  let view: EditorView;
  const commit = () => {
    if (!admission?.frozen()&&!destroyed && !synchronizing && !composingKey && !view.composing && !textarea.disabled && !textarea.readOnly
      && !view.state.readOnly && view.hasFocus && view.contentDOM.isConnected && !wrapper.closest('[inert]')) options.onCommit?.();
    return false; // Completion/snippet keymaps run first; unhandled Tab still moves focus.
  };
  try { view = new EditorView({
    parent: wrapper,
    state: EditorState.create({ doc: textarea.value, extensions: [
      formulaLanguage, syntaxHighlighting(formulaHighlight), EditorView.lineWrapping,
      EditorView.domEventObservers({keydown(event) { composingKey = event.isComposing || event.keyCode === 229; }}),
      history(), keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap,
        { key: 'Escape', run: view => {if(admission?.frozen())return !(composingKey||view.composing); if (!options.onEscape || composingKey || view.composing) return false; options.onEscape(); return true; } },
        { key: 'Tab', run: commit, shift: commit },
      ]),
      autocompletion({ override: [completions(options,summary)], defaultKeymap: false }),
      attributes.of(contentAttributes()), editability.of(editable()),
      EditorView.theme({
        '&': { fontSize: 'var(--font-ui-small, 13px)', backgroundColor: 'var(--background-primary)', borderRadius: 'var(--radius-s, 4px)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-content': { fontFamily: 'var(--font-monospace, monospace)', padding: '6px 0', minHeight: '58px' },
        '.cm-line': { padding: '0 8px' },
        '.cm-scroller': { overflow: 'auto', maxHeight: '240px' },
        '.cm-tooltip': { fontFamily: 'var(--font-interface, sans-serif)', backgroundColor: 'var(--background-secondary)', border: '1px solid var(--background-modifier-border)' },
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || synchronizing || destroyed) return;
        textarea.value = update.state.doc.toString();admission?.changed();if(admission?.frozen())return; diagnose();
        if (win) {
          publishing = true;
          try { textarea.dispatchEvent(new win.Event('input', { bubbles: true })); }
          finally { publishing = false; }
        }
      }),
    ] }),
  }); } catch (failure) {
    wrapper.remove(); restoreNative(); throw failure;
  }
  wrapper.append(error);

  function diagnose() {
    const message = syntaxDiagnostic(textarea.value);
    error.hidden = !message; error.textContent = message ?? '';
    wrapper.classList.toggle('has-error', !!message);
    view.contentDOM.setAttribute('aria-invalid', String(!!message));
    if (message !== lastDiagnostic) { lastDiagnostic = message; options.onDiagnostics?.(message); }
  }
  function sync() {
    if (destroyed || publishing) return;
    synchronizing = true;
    try {
      const current = view.state.doc.toString();
      view.dispatch({
        ...(current !== textarea.value ? { changes: { from: 0, to: current.length, insert: textarea.value } } : {}),
        effects: [attributes.reconfigure(contentAttributes()), editability.reconfigure(editable())],
        annotations: Transaction.addToHistory.of(false),
      });
      diagnose();
    } finally { synchronizing = false; }
  }
  textarea.addEventListener('input', sync);
  const observer = win?.MutationObserver ? new win.MutationObserver(sync) : undefined;
  observer?.observe(textarea, { attributes: true, attributeFilter: ['disabled', 'readonly', 'aria-label', 'aria-describedby', 'placeholder'] });
  diagnose();
  const readDraft=():BaseFormulaAdmissionDraft['state']=>({text:view.state.doc.toString(),selection:view.state.selection.ranges.map(range=>({anchor:range.anchor,head:range.head})),mainIndex:view.state.selection.mainIndex,scrollTop:view.scrollDOM.scrollTop,scrollLeft:view.scrollDOM.scrollLeft,focus:view.hasFocus});
  admission=formulaAdmissionOwner(view.contentDOM,initial,{alive:()=>!destroyed&&view.contentDOM.isConnected,read:readDraft,restore:state=>{
    synchronizing=true;try{const current=view.state.doc.toString();textarea.value=state.text;view.dispatch({...(current!==state.text?{changes:{from:0,to:current.length,insert:state.text}}:{}),selection:EditorSelection.create(state.selection.map(range=>EditorSelection.range(range.anchor,range.head)),state.mainIndex),annotations:Transaction.addToHistory.of(false)});diagnose();view.scrollDOM.scrollTop=state.scrollTop;view.scrollDOM.scrollLeft=state.scrollLeft;if(state.focus)view.focus();}finally{synchronizing=false;}
  },lockNative:()=>{view.contentDOM.contentEditable='false';},freeze:()=>{textarea.readOnly=true;view.dispatch({effects:[attributes.reconfigure(contentAttributes()),editability.reconfigure(editable())],annotations:Transaction.addToHistory.of(false)});},settle:done=>view.requestMeasure({read:()=>readDraft(),write:snapshot=>queueMicrotask(()=>done(snapshot))})});
  return {
    canCaptureAdmissionDraft:admission.canCaptureAdmissionDraft,captureFreeze:admission.captureFreeze,restoreAdmissionDraft:admission.restoreAdmissionDraft,
    sync,
    focus() { if (!destroyed) view.focus(); },
    hasFocus() { return !destroyed && view.hasFocus; },
    destroy() {
      if (destroyed) return;
      destroyed = true;admission?.destroy(); observer?.disconnect(); textarea.removeEventListener('input', sync); view.destroy(); wrapper.remove();
      restoreNative();
    },
  };
}
