/** Ordinary text controls keep their platform selection/clipboard menu unless
 * their own window can supply the native desktop replacement. The HTML action
 * menu cannot reliably paste and must not suppress that platform affordance.
 * Editor/table semantic menus have their own policy and do not use this guard. */
export function shouldOverrideInputContextMenu(input: HTMLInputElement | HTMLTextAreaElement): boolean {
  return typeof input.ownerDocument.defaultView?.zorid?.showContextMenu === 'function';
}
