import { detachEvent, reportAsyncError } from './events.ts';
import type { ErrorReporter, EventRef } from './events.ts';

/** Resource ownership foundation. Runtime lifecycle ordering still requires parity checks. */
export class Component {
  private children = new Set<Component>();
  private parent: Component | null = null;
  private cleaners: (() => unknown)[] = [];
  private state: 'idle' | 'loading' | 'loaded' | 'unloading' | 'unloaded' = 'idle';
  private generation = 0;
  private loading: Promise<void> = Promise.resolve();
  private reportError: ErrorReporter;

  constructor(reportError: ErrorReporter = reportAsyncError) { this.reportError = reportError; }

  onload(): void | Promise<void> {}
  onunload(): void {}

  load(): void {
    if (this.state === 'loading' || this.state === 'loaded') return;
    if (this.state === 'unloading') throw new Error('Cannot load a component during unload');
    this.state = 'loading';
    const generation = ++this.generation;
    const finish = () => {
      if (generation !== this.generation || this.state !== 'loading') return;
      this.state = 'loaded';
      for (const child of this.children) child.load();
    };
    const fail = (error: unknown) => {
      if (generation === this.generation) this.unload();
      throw error;
    };
    try {
      const result = this.onload();
      if (result && typeof result.then === 'function') this.loading = result.then(finish).catch(fail);
      else { finish(); this.loading = Promise.resolve(); }
    } catch (error) {
      if (generation === this.generation) this.unload();
      this.loading = Promise.reject(error);
    }
    void this.loading.catch(this.reportError);
  }

  /** Host extension: wait for an asynchronous plugin onload hook. */
  whenLoaded(): Promise<void> { return this.loading; }

  unload(): void {
    if (this.state === 'unloaded' || this.state === 'unloading') return;
    const wasActive = this.state === 'loaded' || this.state === 'loading';
    this.state = 'unloading';
    ++this.generation;
    const errors: unknown[] = [];
    if (wasActive) { try { this.onunload(); } catch (error) { errors.push(error); } }
    for (const child of [...this.children].reverse()) {
      try { child.unload(); } catch (error) { errors.push(error); }
    }
    for (const cleanup of this.cleaners.splice(0).reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    this.state = 'unloaded';
    for (const error of errors) this.reportError(error);
  }

  addChild<T extends Component>(component: T): T {
    if (this.state === 'unloading') throw new Error('Cannot attach a child during unload');
    for (let parent: Component | null = this; parent; parent = parent.parent) {
      if (parent === component) throw new Error('Component ownership cannot contain a cycle');
    }
    if (component.parent && component.parent !== this) throw new Error('Component already has a parent');
    this.children.add(component);
    component.parent = this;
    if (this.state === 'loaded') component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    if (this.children.delete(component)) {
      component.parent = null;
      component.unload();
    }
    return component;
  }

  register(cleanup: () => unknown): void {
    // Async hooks may finish after disable; their resources must not survive it.
    if (this.state === 'unloading' || this.state === 'unloaded') {
      try { cleanup(); } catch (error) { this.reportError(error); }
    } else this.cleaners.push(cleanup);
  }

  registerEvent(ref: EventRef): void { this.register(() => detachEvent(ref)); }

  registerDomEvent<K extends keyof WindowEventMap>(target: Window, type: K, callback: (event: WindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof DocumentEventMap>(target: Document, type: K, callback: (event: DocumentEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent(target: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent(target: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, callback, options);
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
    this.register(() => target.removeEventListener(type, callback, capture));
  }

  registerInterval(id: number): number {
    this.register(() => globalThis.clearInterval(id));
    return id;
  }
}
