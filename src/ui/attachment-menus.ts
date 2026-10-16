import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';

type Action = () => void | Promise<void>;
export interface AttachmentMenuActions {
  copyImage?: Action;
  swapFile?: Action;
  removeImage?: Action;
  resetSize?: Action;
  openInNewTab?: Action;
  openToRight?: Action;
  rename?: Action;
  openExternal?: Action;
  reveal?: Action;
  deleteImage?: Action;
  onError?: (error: unknown) => void;
}
export interface AttachmentMenuTarget {
  surface: 'standalone' | 'embed';
  image: boolean;
  /** Resolved vault attachment; external URLs never get file mutation actions. */
  local: boolean;
  hasSize?: boolean;
  isMac?: boolean;
  /** Recheck owner, resolved path and render generation after the menu replies. */
  isAlive: () => boolean;
}

/** Bounded built-in sections. Host capabilities determine which actions exist;
 * the shared file/link menu's plugin contributions are not reconstructed here. */
export function attachmentMenuItems(target: AttachmentMenuTarget, actions: AttachmentMenuActions): ContextMenuItem[] {
  const groups: ContextMenuItem[][] = [[], [], [], [], []];
  const add = (group: number, id: keyof AttachmentMenuActions, label: string, enabled = true) => {
    if (actions[id]) groups[group].push({ id, label, enabled });
  };
  if (target.image) {
    add(0, 'copyImage', 'Copy image');
    if (target.surface === 'embed') {
      if (target.local) add(0, 'swapFile', 'Swap file...');
      add(0, 'removeImage', 'Remove image');
      add(0, 'resetSize', 'Reset size', !!target.hasSize);
    }
  }
  if (target.local) {
    add(1, 'openInNewTab', 'Open in new tab');
    add(1, 'openToRight', 'Open to the right');
    add(2, 'rename', 'Rename...');
    add(3, 'openExternal', 'Open in default app');
    add(3, 'reveal', target.isMac ? 'Reveal in Finder' : 'Show in system explorer');
    if (target.image && target.surface === 'embed') add(4, 'deleteImage', 'Delete image');
  }
  return groups.filter(group => group.length).flatMap((group, index) => index ? [{ type: 'separator' as const }, ...group] : group);
}

/** Action callbacks that await their own reads must revalidate their ownership
 * again before side effects. This boundary guards delayed native menu replies. */
export async function showAttachmentMenu(event: MouseEvent, target: AttachmentMenuTarget, actions: AttachmentMenuActions): Promise<void> {
  if (event.defaultPrevented || !target.isAlive()) return;
  const items = attachmentMenuItems(target, actions);
  if (!items.length) return;
  try {
    const id = await showContextMenu(event, items);
    if (!id || !target.isAlive()) return;
    const offered = items.find(item => 'id' in item && item.id === id);
    if (!offered || !('id' in offered) || offered.enabled === false) return;
    const action = actions[id as keyof Omit<AttachmentMenuActions, 'onError'>];
    await action?.();
  } catch (error) { if (target.isAlive()) actions.onError?.(error); }
}
