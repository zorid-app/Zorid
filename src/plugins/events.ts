// Original implementation against the statically audited event contract.
export type ErrorReporter = (error: unknown) => void;
type Callback = (...args: any[]) => unknown;
export interface EventRef {
  e: Events;
  name: string;
  fn: Callback;
  ctx: unknown;
}

export const reportAsyncError: ErrorReporter = error => { setTimeout(() => { throw error; }, 0); };

export function detachEvent(ref: EventRef): void { ref.e.offref(ref); }

export class Events {
  private listeners = new Map<string, EventRef[]>();
  private reportError: ErrorReporter;

  /** A custom reporter is a host extension; the default reports through a timer. */
  constructor(reportError: ErrorReporter = reportAsyncError) { this.reportError = reportError; }

  on<Args extends unknown[]>(name: string, callback: (...args: Args) => unknown, ctx?: unknown): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(ref);
    this.listeners.set(name, listeners);
    return ref;
  }

  off(name: string, callback?: Callback): void {
    const remaining = callback ? this.listeners.get(name)?.filter(ref => ref.fn !== callback) : undefined;
    if (remaining?.length) this.listeners.set(name, remaining);
    else this.listeners.delete(name);
  }

  offref(ref: EventRef | null | undefined): void {
    if (!ref) return;
    const remaining = this.listeners.get(ref.name)?.filter(listener => listener !== ref);
    if (remaining?.length) this.listeners.set(ref.name, remaining);
    else this.listeners.delete(ref.name);
  }

  trigger(name: string, ...args: unknown[]): void {
    // Dispatch keeps the original snapshot, including subsequently detached refs.
    for (const ref of this.listeners.get(name)?.slice() ?? []) this.tryTrigger(ref, args);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    try { ref.fn.apply(ref.ctx, args); }
    catch (error) { this.reportError(error); }
  }
}
