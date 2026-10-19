import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaseClockHost } from '../src/bases/clock.ts';

class FakeTimers {
  now = 1_000;
  reads = 0;
  nextId = 0;
  cancelled: number[] = [];
  delays: number[] = [];
  pending = new Map<number, { callback: () => void; delay: number }>();
  clock = () => { this.reads++; return this.now; };
  timeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.delays.push(delay);
    this.pending.set(id, { callback, delay });
    return () => { this.cancelled.push(id); this.pending.delete(id); };
  };
  fire(now: number) {
    assert.equal(this.pending.size, 1);
    const [id, timer] = this.pending.entries().next().value!;
    this.pending.delete(id);
    this.now = now;
    timer.callback();
  }
  host() {
    return createBaseClockHost({
      now: this.clock, timeout: this.timeout, deviceTimezone: () => 'America/Toronto',
      document: null, window: null,
    });
  }
}

class FakeEvents {
  visibilityState = 'visible';
  listeners = new Map<string, Set<() => void>>();
  removed: string[] = [];
  addEventListener(type: string, callback: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, callback: () => void) {
    this.removed.push(type); this.listeners.get(type)?.delete(callback);
  }
  emit(type: string) { for (const callback of this.listeners.get(type) ?? []) callback(); }
}

test('capture reads the clock once and uses a trimmed configured zone without device lookup', () => {
  let reads = 0, deviceReads = 0;
  const host = createBaseClockHost({
    now: () => { reads++; return 1234; },
    deviceTimezone: () => { deviceReads++; return 'America/Toronto'; },
    document: null, window: null,
  });
  const captured = host.capture('  Pacific/Auckland  ');
  assert.deepEqual(captured, { clockMs: 1234, timezone: 'Pacific/Auckland' });
  assert.equal(reads, 1); assert.equal(deviceReads, 0);
  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(host.capture('  '), { clockMs: 1234, timezone: 'America/Toronto' });
  assert.equal(reads, 2); assert.equal(deviceReads, 1);
});

test('device timezone is captured anew rather than fixed at construction', () => {
  let zone = 'America/Toronto';
  const host = createBaseClockHost({ now: () => 42, deviceTimezone: () => zone, document: null, window: null });
  assert.equal(host.capture().timezone, 'America/Toronto');
  zone = 'Europe/Paris';
  assert.equal(host.capture().timezone, 'Europe/Paris');
  assert.throws(() => createBaseClockHost({ now: () => 42, deviceTimezone: () => '' }).capture(), /timezone/);
});

test('UTC fallback is limited to an unavailable Intl implementation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Intl')!;
  try {
    Object.defineProperty(globalThis, 'Intl', { configurable: true, writable: true, value: undefined });
    const host = createBaseClockHost({ now: () => 42, document: null, window: null });
    assert.deepEqual(host.capture(), { clockMs: 42, timezone: 'UTC' });
  } finally { Object.defineProperty(globalThis, 'Intl', descriptor); }
  const host = createBaseClockHost({ now: () => 42, deviceTimezone: () => { throw new Error('Intl failed'); } });
  assert.throws(() => host.capture(), /Intl failed/);
});

test('a past deadline remains asynchronous and fires once with no pending timer', () => {
  const timers = new FakeTimers(), host = timers.host(); let calls = 0;
  const cancel = host.scheduleAt(999, () => { calls++; });
  const callback = timers.pending.values().next().value!.callback;
  assert.equal(calls, 0); assert.deepEqual(timers.delays, [0]);
  timers.fire(1_000);
  callback(); cancel(); cancel();
  assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
  assert.deepEqual(timers.cancelled, []);
});

test('long absolute deadlines rearm only bounded timeouts toward the same deadline', () => {
  const timers = new FakeTimers(), host = timers.host(); let calls = 0;
  const maximum = 2_147_483_647, deadline = timers.now + maximum * 2 + 5;
  host.scheduleAt(deadline, () => { calls++; });
  timers.fire(1_000 + maximum);
  assert.equal(calls, 0);
  timers.fire(1_000 + maximum * 2);
  assert.equal(calls, 0);
  timers.fire(deadline);
  assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
  assert.deepEqual(timers.delays, [maximum, maximum, 5]);
});

test('early wake and backwards wall-clock changes rearm rather than firing early', () => {
  const timers = new FakeTimers(), host = timers.host(); let calls = 0;
  host.scheduleAt(2_000, () => { calls++; });
  timers.fire(500);
  assert.equal(calls, 0); assert.deepEqual(timers.delays, [1_000, 1_500]);
  timers.fire(1_999);
  assert.equal(calls, 0); assert.equal(timers.delays.at(-1), 1);
  timers.fire(2_000);
  assert.equal(calls, 1);
});

test('timer cancellation is idempotent and suppresses a previously queued callback', () => {
  const timers = new FakeTimers(), host = timers.host(); let calls = 0;
  const cancel = host.scheduleAt(2_000, () => { calls++; });
  const queued = timers.pending.values().next().value!.callback;
  cancel(); cancel(); queued();
  assert.equal(calls, 0); assert.deepEqual(timers.cancelled, [1]);
  assert.equal(timers.pending.size, 0);
  assert.throws(() => host.scheduleAt(Infinity, () => {}), /finite/);
  assert.throws(() => host.scheduleAt(NaN, () => {}), /finite/);
});

test('wake subscriptions use visibility/focus events and clean up once without polling', () => {
  const document = new FakeEvents(), window = new FakeEvents(); let calls = 0, timers = 0;
  const host = createBaseClockHost({
    document, window, timeout: () => { timers++; return () => {}; },
  });
  const unsubscribe = host.subscribeWake(() => { calls++; });
  const queued = document.listeners.get('visibilitychange')!.values().next().value!;
  assert.equal(host.isVisible(), true);
  document.visibilityState = 'hidden'; document.emit('visibilitychange');
  assert.equal(host.isVisible(), false); assert.equal(calls, 1);
  document.visibilityState = 'visible'; document.emit('visibilitychange'); window.emit('focus');
  assert.equal(host.isVisible(), true); assert.equal(calls, 3);
  unsubscribe(); unsubscribe();
  document.emit('visibilitychange'); window.emit('focus'); queued();
  assert.equal(calls, 3); assert.equal(timers, 0);
  assert.deepEqual(document.removed, ['visibilitychange']);
  assert.deepEqual(window.removed, ['focus']);
});

test('explicit absent event surfaces are visible and need no browser globals', () => {
  const host = createBaseClockHost({ document: null, window: null, now: () => 0, deviceTimezone: () => 'UTC' });
  assert.equal(host.isVisible(), true);
  const unsubscribe = host.subscribeWake(() => assert.fail('no wake source'));
  unsubscribe(); unsubscribe();
  assert.deepEqual(host.capture(), { clockMs: 0, timezone: 'UTC' });
});
