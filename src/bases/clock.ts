/** One clock/timezone pair shared by a single Base evaluation. */
export interface BaseClockCapture {
  readonly clockMs: number;
  readonly timezone: string;
}

export interface BaseClockHost {
  capture(configuredTimezone?: string): BaseClockCapture;
  scheduleAt(deadlineMs: number, callback: () => void): () => void;
  subscribeWake(callback: () => void): () => void;
  isVisible(): boolean;
}

interface ClockEvents {
  addEventListener(type: string, callback: () => void): void;
  removeEventListener(type: string, callback: () => void): void;
}
interface ClockDocument extends ClockEvents {
  readonly visibilityState?: string;
}
/** Small injectable surfaces; the host never infers query dependencies/cadence. */
export interface BaseClockDependencies {
  readonly now?: () => number;
  readonly deviceTimezone?: () => string;
  readonly timeout?: (callback: () => void, delayMs: number) => () => void;
  readonly document?: ClockDocument | null;
  readonly window?: ClockEvents | null;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function deviceTimezone(): string {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return 'UTC';
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Browser defaults are resolved on use, so importing this module is SSR safe. */
export function createBaseClockHost(dependencies: BaseClockDependencies = {}): BaseClockHost {
  const now = dependencies.now ?? (() => Date.now());
  const timezone = dependencies.deviceTimezone ?? deviceTimezone;
  const timeout = dependencies.timeout ?? ((callback: () => void, delayMs: number) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(handle);
  });
  const documentEvents = dependencies.document === undefined
    ? (typeof document === 'undefined' ? null : document)
    : dependencies.document;
  const windowEvents = dependencies.window === undefined
    ? (typeof window === 'undefined' ? null : window)
    : dependencies.window;

  return {
    capture(configuredTimezone) {
      const clockMs = now();
      const selectedTimezone = configuredTimezone?.trim() || timezone().trim();
      if (!selectedTimezone) throw new Error('Device timezone is unavailable');
      return Object.freeze({ clockMs, timezone: selectedTimezone });
    },
    scheduleAt(deadlineMs, callback) {
      if (!Number.isFinite(deadlineMs)) throw new RangeError('Clock deadline must be finite');
      let active = true;
      let cancelTimeout: (() => void) | undefined;
      const arm = (remaining: number) => {
        // Round upward to avoid repeatedly firing early for a fractional ms.
        cancelTimeout = timeout(wake, Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.ceil(remaining))));
      };
      const wake = () => {
        cancelTimeout = undefined;
        if (!active) return;
        const remaining = deadlineMs - now();
        if (remaining > 0) {
          arm(remaining);
          return;
        }
        active = false;
        callback();
      };
      arm(deadlineMs - now());
      return () => {
        if (!active) return;
        active = false;
        cancelTimeout?.();
        cancelTimeout = undefined;
      };
    },
    subscribeWake(callback) {
      let active = true;
      const wake = () => { if (active) callback(); };
      documentEvents?.addEventListener('visibilitychange', wake);
      windowEvents?.addEventListener('focus', wake);
      return () => {
        if (!active) return;
        active = false;
        documentEvents?.removeEventListener('visibilitychange', wake);
        windowEvents?.removeEventListener('focus', wake);
      };
    },
    isVisible() {
      return documentEvents?.visibilityState === undefined || documentEvents.visibilityState === 'visible';
    },
  };
}
