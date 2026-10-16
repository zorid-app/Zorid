import { detachEvent } from './events.ts';
import type { EventRef } from './events.ts';

export interface ScopeEventRef {
  scope: { unregister(event: ScopeEventRef): unknown };
}

/** Original implementation of the statically audited component lifecycle. */
export class Component {
  protected loaded = false;
  protected children: Component[] = [];
  private cleaners: (() => unknown)[] = [];

  onload(): void | Promise<void> {}
  onunload(): void {}

  load(): void | Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const pending: Promise<void>[] = [];
    const ownLoad = this.onload();
    if (ownLoad) pending.push(ownLoad);
    // A child can change ownership during its hook without changing this pass.
    for (const child of this.children.slice()) {
      const childLoad = child.load();
      if (childLoad) pending.push(childLoad);
    }
    if (pending.length) return Promise.all(pending).then(() => {});
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    // Pop before calling user code. Exceptions propagate and leave the rest queued.
    while (this.children.length) this.children.pop()!.unload();
    while (this.cleaners.length) this.cleaners.pop()!();
    this.onunload();
  }

  addChild<T extends Component>(component: T): T {
    this.children.push(component);
    if (this.loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
      component.unload();
    }
    return component;
  }

  register(cleanup: () => unknown): void { this.cleaners.push(cleanup); }

  registerEvent(ref: EventRef): void { this.register(() => detachEvent(ref)); }

  registerScopeEvent(ref: ScopeEventRef): void {
    this.register(() => ref.scope.unregister(ref));
  }

  registerDomEvent<K extends keyof WindowEventMap>(target: Window, type: K, callback: (event: WindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof DocumentEventMap>(target: Document, type: K, callback: (event: DocumentEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent(target: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent(target: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, callback, options);
    this.register(() => target.removeEventListener(type, callback, options));
  }

  registerInterval(id: number): number {
    this.register(() => globalThis.clearInterval(id));
    return id;
  }
}
