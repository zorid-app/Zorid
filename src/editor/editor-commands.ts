import { Compartment, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import { eventHotkey, hotkeyIdentity } from '../ui/hotkeys.ts';
import type { EditorHotkeySource, Hotkey } from '../ui/hotkeys.ts';
import { formatMenuForEditor } from './format-menu.ts';
import type { FormatMenuItem } from './format-menu.ts';
import { activeTableEditor, tableSelectionAt, tableSelectionRanges, tableSelectionAnnotation } from './live-tables.ts';
import { toggleMarkdownFold, foldMarkdown, unfoldMarkdown, foldAllMarkdown, unfoldAllMarkdown } from './folding.ts';

const formats: Record<string, string> = {
  'editor-bold': 'format-bold', 'editor-italic': 'format-italic', 'editor-strikethrough': 'format-strikethrough',
  'editor-code': 'format-code', 'editor-math': 'format-math', 'editor-comment': 'format-comment',
  'editor-highlight': 'format-highlight-default', 'editor-clear-formatting': 'format-clear',
};
const folds: Record<string, (view: EditorView) => boolean> = {
  'editor-toggle-fold': toggleMarkdownFold, 'editor-fold': foldMarkdown, 'editor-unfold': unfoldMarkdown,
  'editor-fold-all': foldAllMarkdown, 'editor-unfold-all': unfoldAllMarkdown,
};
const ids = [...Object.keys(formats), ...Object.keys(folds)];

function findAction(items: FormatMenuItem[], id: string): Extract<FormatMenuItem, { run: unknown }> | undefined {
  for (const item of items) {
    if ('submenu' in item) { const found = findAction(item.submenu, id); if (found) return found; }
    else if ('id' in item && item.id === id && 'run' in item) return item;
  }
  return undefined;
}
function surfaceBlocked(view: EditorView, owner: EditorView): boolean {
  const document = view.dom.ownerDocument;
  return !view.hasFocus || !view.dom.isConnected || owner.state.readOnly
    || !!document.querySelector('.modal-overlay,[aria-modal="true"],[role="menu"]')
    || !!owner.dom.querySelector('.cm-tooltip-autocomplete,.cm-search');
}

/** Internal commands only. A recognized unavailable action is consumed, so a
 * lower-priority keymap never executes a different command for that binding. */
export function runEditorCommand(id: string, view: EditorView, owner: EditorView = view): boolean {
  if (!Object.hasOwn(formats, id) && !Object.hasOwn(folds, id)) return false;
  if (surfaceBlocked(view, owner) || view.composing || owner.composing || activeTableEditor(owner)?.composing) return true;
  if (Object.hasOwn(folds, id)) {
    const child = activeTableEditor(owner);
    const changed = folds[id](owner);
    if (changed && child && !child.dom.isConnected) owner.focus();
    return true;
  }
  const rectangle = tableSelectionAt(owner, view.contentDOM);
  if (!rectangle && view.state.readOnly) return true;
  const target = rectangle ? owner : view;
  const action = findAction(formatMenuForEditor(target, {
    inTableCell: view !== owner,
    ...(rectangle ? { ranges: () => tableSelectionRanges(owner, view.contentDOM) } : {}),
    annotations: [isolateHistory.of('full'), ...(rectangle ? [tableSelectionAnnotation] : [])],
  }), formats[id]);
  if (action?.enabled) {
    action.run();
    // Parent rectangle updates can synchronize the active child without
    // changing its ownership. Preserve its typing focus when still mounted.
    if (rectangle && view.dom.isConnected) view.focus();
  }
  return true;
}

function keyName(binding: Hotkey, source: EditorHotkeySource): string {
  const names = binding.modifiers.map(modifier => modifier === 'Mod' ? source.platform === 'mac' ? 'Meta' : 'Ctrl' : modifier);
  return [...new Set(names), binding.key === 'Space' ? ' ' : binding.key].join('-');
}

/** Each parent or table child gets its own compartment and subscription. The
 * shared source controls preferences, while the existing view owns history,
 * selection, focus and composition throughout every reconfiguration. */
export function editorCommandHotkeys(source?: EditorHotkeySource, owner?: EditorView): Extension {
  if (!source) return [];
  const preferences = source;
  const configuration = new Compartment();
  let current = ids.flatMap(id => preferences.effectiveBindings(id).map(binding => ({ id, binding })));
  const bindings = (): KeyBinding[] => current.map(({ id, binding }) => ({
    key: keyName(binding, preferences), run: (view: EditorView) => runEditorCommand(id, view, owner ?? view), preventDefault: true,
  }));
  return [configuration.of(Prec.high(keymap.of(bindings()))), ViewPlugin.fromClass(class {
    private alive = true;
    private pending = false;
    private queued = false;
    private compositionTarget: Element | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private unsubscribe: () => void;
    private view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      // Capture also sees the nested table editor's composition events.
      view.dom.addEventListener('keydown', this.guard, true);
      view.dom.addEventListener('compositionstart', this.start, true);
      view.dom.addEventListener('compositionend', this.end, true);
      this.unsubscribe = preferences.subscribe(() => { this.pending = true; this.schedule(); });
    }
    private guard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.repeat || event.isComposing || event.getModifierState('AltGraph'))
        || (event.target as Element | null)?.closest('.cm-editor') !== this.view.dom) return;
      const chord = eventHotkey({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, isComposing: false, repeat: false }, preferences.platform);
      if (chord && current.some(({ binding }) => hotkeyIdentity(binding, preferences.platform) === hotkeyIdentity(chord, preferences.platform))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    private start = (event: CompositionEvent) => { this.compositionTarget = event.target as Element; };
    private end = () => { this.compositionTarget = null; this.schedule(); };
    private schedule() {
      if (!this.alive || !this.pending || this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        if (!this.alive || !this.pending) return;
        if (this.compositionTarget?.isConnected && this.view.dom.contains(this.compositionTarget) || this.view.composing || owner?.composing || activeTableEditor(owner ?? this.view)?.composing) {
          clearTimeout(this.timer); this.timer = setTimeout(() => this.schedule(), 20); return;
        }
        this.pending = false;
        current = ids.flatMap(id => preferences.effectiveBindings(id).map(binding => ({ id, binding })));
        this.view.dispatch({ effects: configuration.reconfigure(Prec.high(keymap.of(bindings()))) });
      });
    }
    destroy() {
      this.alive = false; clearTimeout(this.timer); this.unsubscribe();
      this.view.dom.removeEventListener('keydown', this.guard, true);
      this.view.dom.removeEventListener('compositionstart', this.start, true);
      this.view.dom.removeEventListener('compositionend', this.end, true);
    }
  })];
}
