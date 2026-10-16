export interface NumberedTabKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  /** Legacy virtual-key matching is retained for non-US keyboard layouts. */
  which?: number;
  keyCode?: number;
}
export interface NumberedTabShortcutContext {
  platform: 'mac' | 'other';
  /** Number of tabs in the active pane/group, including pinned tabs. */
  tabCount: number;
  isPhone?: boolean;
  /** A modal, popup or another keyboard scope owns this event. */
  blocked?: boolean;
}
export type NumberedTabShortcut = { handled: false } | { handled: true; index?: number };

/** Pure matcher: never changes focus, consumes events or performs async work.
 * A matched unavailable command is still handled, but has no destination.
 * Input/contenteditable focus alone does not disable workspace tab shortcuts. */
export function resolveNumberedTabShortcut(
  event: NumberedTabKeyEvent,
  context: NumberedTabShortcutContext,
): NumberedTabShortcut {
  if (context.blocked || event.defaultPrevented || event.isComposing || event.repeat) return { handled: false };
  if (event.altKey || event.shiftKey) return { handled: false };
  const exactMod = context.platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!exactMod) return { handled: false };
  const logical = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  const code = event.which || event.keyCode || 0;
  const virtual = code >= 49 && code <= 57 && Number.isInteger(code) ? code - 48 : 0;
  // Defaults register 1..8, then 9; either logical or virtual key may match.
  const number = logical && virtual ? Math.min(logical, virtual) : logical || virtual;
  if (!number) return { handled: false };
  const count = Number.isSafeInteger(context.tabCount) && context.tabCount > 0 ? context.tabCount : 0;
  if (!count || (context.isPhone && number !== 9)) return { handled: true };
  const index = number === 9 ? count - 1 : number - 1;
  return index < count ? { handled: true, index } : { handled: true };
}

export interface WorkspaceShortcutContext extends NumberedTabShortcutContext {
  /** Expose only after a native host can safely create a separate Zorid window. */
  canOpenWindow?: boolean;
}
export type WorkspaceShortcutAction =
  | { type: 'select-tab'; index: number }
  | { type: 'new-tab' }
  | { type: 'new-file' }
  | { type: 'new-window' };
export type WorkspaceShortcut = { handled: false } | { handled: true; action?: WorkspaceShortcutAction };

/** Requested workspace shortcuts, with exact modifiers and no callback execution.
 * Cmd/Ctrl+Shift+N is consumed even without window capability; never fall through
 * to the plain Cmd/Ctrl+N file action. Other shortcuts belong to the host. */
export function resolveWorkspaceShortcut(event: NumberedTabKeyEvent, context: WorkspaceShortcutContext): WorkspaceShortcut {
  const numbered = resolveNumberedTabShortcut(event, context);
  if (numbered.handled) return numbered.index === undefined ? { handled: true } : { handled: true, action: { type: 'select-tab', index: numbered.index } };
  if (context.blocked || event.defaultPrevented || event.isComposing || event.repeat || event.altKey) return { handled: false };
  const exactMod = context.platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!exactMod) return { handled: false };
  const code = event.which || event.keyCode || 0;
  const key = event.key.toLowerCase();
  if (key === 'n' || code === 78) {
    if (event.shiftKey) return context.canOpenWindow ? { handled: true, action: { type: 'new-window' } } : { handled: true };
    return { handled: true, action: { type: 'new-file' } };
  }
  if (!event.shiftKey && (key === 't' || code === 84)) return { handled: true, action: { type: 'new-tab' } };
  return { handled: false };
}
