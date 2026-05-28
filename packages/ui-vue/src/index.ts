export { default as ZBadge } from './components/ZBadge.vue';
export { default as ZButton } from './components/ZButton.vue';
export { default as ZCheckboxField } from './components/ZCheckboxField.vue';
export { default as ZConfirmDialog } from './components/ZConfirmDialog.vue';
export { default as ZDialogBackdrop } from './components/ZDialogBackdrop.vue';
export { default as ZDialogWindow } from './components/ZDialogWindow.vue';
export { default as ZModalWindow } from './components/ZModalWindow.vue';
export { default as ZPanel } from './components/ZPanel.vue';
export { default as ZPromptDialog } from './components/ZPromptDialog.vue';
export { default as ZResizeHandle } from './components/ZResizeHandle.vue';
export { default as ZStatusBar } from './components/ZStatusBar.vue';
export { default as ZTag } from './components/ZTag.vue';
export { default as ZTextField } from './components/ZTextField.vue';
export { default as ZVisuallyHidden } from './components/ZVisuallyHidden.vue';
export { default as ZWindowFrame } from './components/ZWindowFrame.vue';

export interface VirtualWindow { readonly start: number; readonly end: number; readonly offsetTop: number; readonly totalHeight: number; }
export function computeVirtualWindow(options: { readonly itemCount: number; readonly itemHeight: number; readonly viewportHeight: number; readonly scrollTop: number; readonly overscan?: number }): VirtualWindow {
  const overscan = options.overscan ?? 5;
  const visible = Math.ceil(options.viewportHeight / options.itemHeight);
  const start = Math.max(0, Math.floor(options.scrollTop / options.itemHeight) - overscan);
  const end = Math.min(options.itemCount, start + visible + overscan * 2);
  return { start, end, offsetTop: start * options.itemHeight, totalHeight: options.itemCount * options.itemHeight };
}
