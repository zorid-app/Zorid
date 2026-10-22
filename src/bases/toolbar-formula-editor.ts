import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap, snippetCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { parseBaseExpression } from './expression.ts';

export interface BaseFormulaEditorOptions {
  propertyIds?: readonly string[];
  functionNames?: readonly string[];
  /** Supported receiver methods supplied by the caller, never discovered by evaluation. */
  methodNames?: readonly string[];
  /** Invoked by Escape only after CodeMirror's completion handler declines it. */
  onEscape?(): void;
  /** Syntax diagnostics only: editing never evaluates an expression. */
  onDiagnostics?(message: string | undefined): void;
}
export interface BaseFormulaEditor {
  sync(): void;
  focus(): void;
  hasFocus(): boolean;
  destroy(): void;
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

function completions(options: BaseFormulaEditorOptions) {
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

// Owner-document-only hosts (for example inert DOM previews) cannot construct
// CodeMirror, which requires browser globals. Keep their native draft usable.
function nativeFormulaEditor(textarea: HTMLTextAreaElement, options: BaseFormulaEditorOptions): BaseFormulaEditor {
  const doc = textarea.ownerDocument, wrapper = doc.createElement('div'), error = doc.createElement('div');
  wrapper.className = 'bases-formula-editor'; error.className = 'bases-formula-editor-error';
  error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  textarea.insertAdjacentElement('afterend', wrapper); wrapper.append(textarea, error);
  let destroyed = false, lastDiagnostic: string | undefined;
  const sync = () => {
    if (destroyed) return;
    const message = syntaxDiagnostic(textarea.value); error.hidden = !message; error.textContent = message ?? '';
    if (message !== lastDiagnostic) { lastDiagnostic = message; options.onDiagnostics?.(message); }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && options.onEscape) { event.preventDefault(); options.onEscape(); }
  };
  textarea.addEventListener('input', sync); textarea.addEventListener('keydown', keydown); sync();
  return { sync, focus() { if (!destroyed) textarea.focus(); }, hasFocus: () => !destroyed && doc.activeElement === textarea, destroy() {
    if (destroyed) return;
    destroyed = true; textarea.removeEventListener('input', sync); textarea.removeEventListener('keydown', keydown);
    if (wrapper.contains(textarea)) wrapper.replaceWith(textarea); else wrapper.remove();
  } };
}

/** Enhance a native draft model; CodeMirror owns text, selection, IME and undo. */
export function enhanceBaseFormulaEditor(textarea: HTMLTextAreaElement, options: BaseFormulaEditorOptions = {}): BaseFormulaEditor {
  if (typeof document === 'undefined') return nativeFormulaEditor(textarea, options);
  const doc = textarea.ownerDocument, win = doc.defaultView;
  const original = { hidden: textarea.hidden, ariaHidden: textarea.getAttribute('aria-hidden'), tabIndex: textarea.getAttribute('tabindex') };
  const wrapper = doc.createElement('div'); wrapper.className = 'bases-formula-editor';
  const error = doc.createElement('div'); error.className = 'bases-formula-editor-error';
  error.id = `bases-formula-diagnostic-${++nextDiagnosticId}`; error.hidden = true;
  error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  textarea.insertAdjacentElement('afterend', wrapper);
  textarea.hidden = true; textarea.tabIndex = -1; textarea.setAttribute('aria-hidden', 'true');
  let destroyed = false, synchronizing = false, publishing = false, lastDiagnostic: string | undefined;
  const attributes = new Compartment(), editability = new Compartment();
  const contentAttributes = () => EditorView.contentAttributes.of({
    'aria-label': textarea.getAttribute('aria-label') ?? 'Formula',
    'aria-multiline': 'true',
    'aria-readonly': String(textarea.readOnly || textarea.disabled),
    'aria-describedby': [textarea.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '),
  });
  const editable = () => [EditorState.readOnly.of(textarea.readOnly || textarea.disabled), EditorView.editable.of(!textarea.readOnly && !textarea.disabled)];
  const restoreNative = () => {
    textarea.hidden = original.hidden;
    for (const [name, value] of [['aria-hidden', original.ariaHidden], ['tabindex', original.tabIndex]] as const) {
      if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value);
    }
  };
  let view: EditorView;
  try { view = new EditorView({
    parent: wrapper,
    state: EditorState.create({ doc: textarea.value, extensions: [
      formulaLanguage, syntaxHighlighting(formulaHighlight), EditorView.lineWrapping,
      history(), keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap,
        { key: 'Escape', run: () => { if (!options.onEscape) return false; options.onEscape(); return true; } },
      ]),
      autocompletion({ override: [completions(options)], defaultKeymap: false }),
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
        textarea.value = update.state.doc.toString(); diagnose();
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
  observer?.observe(textarea, { attributes: true, attributeFilter: ['disabled', 'readonly', 'aria-label', 'aria-describedby'] });
  diagnose();
  return {
    sync,
    focus() { if (!destroyed) view.focus(); },
    hasFocus() { return !destroyed && view.hasFocus; },
    destroy() {
      if (destroyed) return;
      destroyed = true; observer?.disconnect(); textarea.removeEventListener('input', sync); view.destroy(); wrapper.remove();
      restoreNative();
    },
  };
}
