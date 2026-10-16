// Original implementation against public API shapes, not recovered application code.
export interface EventRef { readonly __eventRef: unique symbol }
export type ErrorReporter = (error: unknown) => void;
type Callback = (...args: any[]) => unknown;
interface Subscription { emitter: Events; name: string; callback: Callback; context: unknown; active: boolean }
const subscriptions = new WeakMap<EventRef, Subscription>();

export const reportAsyncError: ErrorReporter = error => { queueMicrotask(() => { throw error; }); };

export function detachEvent(ref: EventRef): void { subscriptions.get(ref)?.emitter.offref(ref); }

export class Events {
  private listeners = new Map<string, Set<EventRef>>();
  private reportError: ErrorReporter;

  constructor(reportError: ErrorReporter = reportAsyncError) { this.reportError = reportError; }

  on<Args extends unknown[]>(name: string, callback: (...args: Args) => unknown, ctx?: unknown): EventRef {
    const ref = Object.freeze({}) as EventRef;
    subscriptions.set(ref, { emitter: this, name, callback, context: ctx, active: true });
    let listeners = this.listeners.get(name);
    if (!listeners) { listeners = new Set(); this.listeners.set(name, listeners); }
    listeners.add(ref);
    return ref;
  }

  off(name: string, callback: Callback): void {
    for (const ref of this.listeners.get(name) ?? []) if (subscriptions.get(ref)?.callback === callback) this.offref(ref);
  }

  offref(ref: EventRef): void {
    const subscription = subscriptions.get(ref);
    if (!subscription || subscription.emitter !== this || !subscription.active) return;
    subscription.active = false;
    const listeners = this.listeners.get(subscription.name);
    listeners?.delete(ref);
    if (listeners?.size === 0) this.listeners.delete(subscription.name);
    subscriptions.delete(ref);
  }

  trigger(name: string, ...args: unknown[]): void {
    // Additions during dispatch wait until the next event; removals take effect immediately.
    for (const ref of [...this.listeners.get(name) ?? []]) this.tryTrigger(ref, args);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    const subscription = subscriptions.get(ref);
    if (!subscription || subscription.emitter !== this || !subscription.active) return;
    try { subscription.callback.apply(subscription.context, args); }
    catch (error) { this.reportError(error); }
  }
}
