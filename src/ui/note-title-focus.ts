export interface NoteTitleFocusOptions {
  /** Resolve only after saving and rebuilding any affected editor. */
  save: (name: string) => Promise<void>;
  /** Owner/file/tab identity, including the active pane when transferring focus. */
  isCurrent: () => boolean;
  focusBody: () => void;
  onError: (error: unknown) => void;
}

/** Keep Enter's focus transfer behind asynchronous title persistence. */
export function bindNoteTitleFocus(title: HTMLInputElement, options: NoteTitleFocusOptions): void {
  let pending: Promise<void> | undefined;
  let enterRequested = false;
  const commit = (enter: boolean) => {
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
  title.onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault(); commit(true);
  };
  title.onblur = () => commit(false);
}
