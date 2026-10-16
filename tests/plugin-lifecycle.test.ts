import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from '../src/plugins/events.ts';
import { Component } from '../src/plugins/component.ts';
import { Plugin } from '../src/plugins/plugin.ts';
import type { Command, PluginHost, SettingTab } from '../src/plugins/plugin.ts';

// Expectations come from the digest/offset-bound static audit, not a reference run.
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function hostFixture() {
  const commands = new Map<string, Command>(), tabs = new Set<SettingTab>(), data = new Map<string, unknown>();
  const removed: string[] = [];
  const host: PluginHost = {
    registerCommand(command) { commands.set(command.id, command); },
    removeCommand(id) { removed.push(id); commands.delete(id); },
    registerSettingTab(tab) { tabs.add(tab); return () => { tabs.delete(tab); }; },
    async loadPluginData(id) { return data.get(id) ?? null; },
    async savePluginData(id, value) { data.set(id, structuredClone(value)); },
  };
  const manifest = { id: 'example', name: 'Example', version: '1.0.0', minAppVersion: '1.0.0', description: '', author: 'Test' };
  return { host, manifest, commands, removed, tabs, data };
}

class Tracked extends Component {
  label: string;
  calls: string[];
  constructor(label: string, calls: string[]) { super(); this.label = label; this.calls = calls; }
  onload(): void { this.calls.push(`load:${this.label}`); this.register(() => this.calls.push(`clean:${this.label}`)); }
  onunload(): void { this.calls.push(`unload:${this.label}`); }
}

test('event references retain callback/context and offref only removes the selected subscription', () => {
  const errors: unknown[] = [], received: string[] = [];
  const events = new Events(error => errors.push(error)), context = { prefix: 'context' };
  function callback(this: typeof context, value: string) { received.push(`${this.prefix}:${value}`); }
  const ref = events.on('change', callback, context);
  assert.equal(ref.e, events); assert.equal(ref.name, 'change');
  assert.equal(ref.fn, callback); assert.equal(ref.ctx, context);
  events.on('change', callback, context);
  events.on('change', () => { throw new Error('bad listener'); });
  events.offref(ref);
  events.trigger('change', 'one');
  assert.deepEqual(received, ['context:one']); assert.equal(errors.length, 1);
  events.off('change', callback);
  events.trigger('change', 'two');
  assert.deepEqual(received, ['context:one']); assert.equal(errors.length, 2);
});

test('event dispatch retains removed listeners in its snapshot and defers additions', () => {
  const events = new Events(), received: string[] = [];
  const first = events.on('change', () => {
    received.push('first'); events.offref(second);
    events.on('change', () => received.push('new'));
  });
  const second = events.on('change', () => received.push('second'));
  events.trigger('change');
  assert.deepEqual(received, ['first', 'second']);
  events.offref(first); events.trigger('change');
  assert.deepEqual(received, ['first', 'second', 'new']);
  new Events().offref(second);
  events.tryTrigger(second, []); // Direct invocation does not require membership.
  assert.equal(received.at(-1), 'second');
});

test('off without a callback clears the named event and reentrant dispatch sees current listeners', () => {
  const events = new Events(), calls: string[] = [];
  events.on('change', () => { calls.push('first'); events.off('change'); events.trigger('change'); });
  events.on('change', () => calls.push('second'));
  events.trigger('change'); events.trigger('change');
  assert.deepEqual(calls, ['first', 'second']);
  events.offref(null); events.offref(undefined);
});

test('listener errors are reported on a timer after synchronous dispatch and microtasks', async t => {
  const calls: string[] = [], timers: (() => void)[] = [], failure = new Error('listener');
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
    assert.equal(delay, 0); timers.push(callback); return 1;
  });
  const events = new Events();
  events.on('change', () => { calls.push('bad'); throw failure; });
  events.on('change', () => calls.push('good'));
  events.trigger('change');
  queueMicrotask(() => calls.push('microtask'));
  await Promise.resolve();
  assert.deepEqual(calls, ['bad', 'good', 'microtask']);
  assert.equal(timers.length, 1); assert.throws(timers[0], error => error === failure);
});

test('component unload drains children then callbacks then its hook and removes child ownership', () => {
  const calls: string[] = [], parent = new Tracked('parent', calls);
  const first = new Tracked('first', calls), second = new Tracked('second', calls);
  assert.equal(parent.addChild(first), first);
  assert.equal(parent.load(), undefined); parent.load(); parent.addChild(second);
  parent.unload(); parent.unload();
  assert.deepEqual(calls, ['load:parent', 'load:first', 'load:second', 'clean:second', 'unload:second', 'clean:first', 'unload:first', 'clean:parent', 'unload:parent']);
  calls.length = 0; parent.load(); parent.removeChild(first); parent.unload();
  assert.deepEqual(calls, ['load:parent', 'clean:parent', 'unload:parent']);
});

test('base component starts children before its async hook resolves and waits for both', async () => {
  const own = deferred(), child = deferred(), calls: string[] = [];
  class Parent extends Component { onload() { calls.push('parent'); return own.promise; } }
  class Child extends Component { onload() { calls.push('child'); return child.promise; } }
  const component = new Parent(); component.addChild(new Child());
  const loading = component.load(); assert.ok(loading instanceof Promise);
  assert.deepEqual(calls, ['parent', 'child']); assert.equal(component.load(), undefined);
  let done = false; void loading.then(() => { done = true; });
  own.resolve(); await Promise.resolve(); assert.equal(done, false);
  child.resolve(); await loading; assert.equal(done, true); component.unload();
});

test('component load uses a child snapshot even when a sibling is removed during its hook', () => {
  const calls: string[] = [], parent = new Component(), second = new Tracked('second', calls);
  class First extends Component { onload() { calls.push('first'); parent.removeChild(second); } }
  parent.addChild(new First()); parent.addChild(second); parent.load(); parent.unload();
  assert.deepEqual(calls, ['first', 'load:second']); second.unload();
});

test('duplicate children and shared ownership are accepted; removal removes one occurrence', () => {
  const calls: string[] = [], first = new Component(), second = new Component(), child = new Tracked('child', calls);
  first.addChild(child); first.addChild(child); second.addChild(child);
  first.load(); second.load(); first.removeChild(child); first.unload(); second.unload();
  assert.deepEqual(calls, ['load:child', 'clean:child', 'unload:child']);
  const cycle = new Component(); assert.equal(cycle.addChild(cycle), cycle);
  cycle.removeChild(cycle); // Do not execute an intentionally cyclic lifecycle.
});

test('cleanup exceptions propagate, stop later cleanup and do not roll back the loaded flag', () => {
  const failure = new Error('cleanup'), calls: string[] = [], component = new Tracked('parent', calls);
  component.load(); component.register(() => { calls.push('bad'); throw failure; });
  assert.throws(() => component.unload(), error => error === failure);
  component.unload(); assert.deepEqual(calls, ['load:parent', 'bad']);
  component.load(); component.unload();
  assert.deepEqual(calls.slice(2), ['load:parent', 'clean:parent', 'clean:parent', 'unload:parent']);
});

test('a child unload exception stops siblings and parent callbacks until another load/unload', () => {
  const failure = new Error('child'), calls: string[] = [], parent = new Tracked('parent', calls);
  parent.addChild(new Tracked('first', calls));
  class BadChild extends Component { onunload() { calls.push('bad child'); throw failure; } }
  parent.addChild(new BadChild()); parent.load();
  assert.throws(() => parent.unload(), error => error === failure);
  parent.unload(); assert.deepEqual(calls, ['load:parent', 'load:first', 'bad child']);
  parent.load(); parent.unload();
  assert.deepEqual(calls.slice(3), ['load:parent', 'clean:first', 'unload:first', 'clean:parent', 'clean:parent', 'unload:parent']);
});

test('cleanup can register another cleanup in the same unload and reentrant unload is a no-op', () => {
  const calls: string[] = [], component = new Tracked('parent', calls);
  component.load(); component.register(() => {
    calls.push('outer'); component.unload(); component.register(() => calls.push('inner'));
  });
  component.unload();
  assert.deepEqual(calls, ['load:parent', 'outer', 'inner', 'clean:parent', 'unload:parent']);
});

test('reentrant load during cleanup is permitted and does not cancel the outer unload', () => {
  const calls: string[] = [], component = new Tracked('parent', calls);
  component.load(); component.register(() => { calls.push('reload'); component.load(); });
  component.unload(); component.unload();
  assert.deepEqual(calls, ['load:parent', 'reload', 'load:parent', 'clean:parent', 'clean:parent', 'unload:parent', 'unload:parent']);
});

test('synchronous load failures throw directly and rejected hooks leave resources until explicit unload', async () => {
  const failure = new Error('loading'), calls: string[] = [];
  class SyncFailure extends Component { onload() { this.register(() => calls.push('sync cleanup')); throw failure; } }
  const sync = new SyncFailure();
  assert.throws(() => sync.load(), error => error === failure);
  assert.equal(sync.load(), undefined); assert.deepEqual(calls, []); sync.unload();
  class AsyncFailure extends Component { async onload() { this.register(() => calls.push('async cleanup')); throw failure; } }
  const async = new AsyncFailure(); await assert.rejects(async.load()!, error => error === failure);
  assert.deepEqual(calls, ['sync cleanup']); async.unload();
  assert.deepEqual(calls, ['sync cleanup', 'async cleanup']);
});

test('registrations after unload remain queued until a later loaded unload', async () => {
  const gate = deferred(), calls: string[] = [], events = new Events();
  class AsyncComponent extends Component {
    async onload() { await gate.promise; this.registerEvent(events.on('change', () => calls.push('event'))); }
  }
  const component = new AsyncComponent(), loading = component.load();
  component.unload(); gate.resolve(); await loading;
  events.trigger('change'); component.unload(); events.trigger('change');
  assert.deepEqual(calls, ['event', 'event']);
  await component.load(); component.unload(); events.trigger('change');
  assert.deepEqual(calls, ['event', 'event']);
});

test('event, DOM, scope and interval registrations release resources on unload', t => {
  const cleared: unknown[] = [], unregistered: unknown[] = [];
  t.mock.method(globalThis, 'clearInterval', (id: unknown) => { cleared.push(id); });
  const component = new Component(), emitter = new Events(), target = new EventTarget();
  let events = 0, dom = 0;
  component.load(); component.registerEvent(emitter.on('change', () => events++));
  component.registerDomEvent(target, 'change', () => dom++);
  const scopeRef = { scope: { unregister(ref: unknown) { unregistered.push(ref); } } };
  component.registerScopeEvent(scopeRef); assert.equal(component.registerInterval(42), 42);
  emitter.trigger('change'); target.dispatchEvent(new Event('change')); component.unload(); component.unload();
  emitter.trigger('change'); target.dispatchEvent(new Event('change'));
  assert.equal(events, 1); assert.equal(dom, 1); assert.deepEqual(cleared, [42]); assert.deepEqual(unregistered, [scopeRef]);
});

test('plugin load waits for its own hook but resolves without waiting for async children', async () => {
  const { host, manifest } = hostFixture(), own = deferred(), child = deferred(), calls: string[] = [];
  class AsyncPlugin extends Plugin { onload() { calls.push('plugin'); return own.promise; } }
  class Child extends Component { onload() { calls.push('child'); return child.promise; } }
  const plugin = new AsyncPlugin(host, manifest); plugin.addChild(new Child());
  const loading = plugin.load(); assert.deepEqual(calls, ['plugin']);
  await plugin.load(); assert.deepEqual(calls, ['plugin']);
  own.resolve(); await loading; assert.deepEqual(calls, ['plugin', 'child']);
  child.resolve(); plugin.unload();
});

test('plugin load rejects a synchronous hook failure without automatic cleanup', async () => {
  const { host, manifest } = hostFixture(), calls: string[] = [], failure = new Error('plugin load');
  class FailingPlugin extends Plugin { onload() { this.register(() => calls.push('cleanup')); throw failure; } }
  const plugin = new FailingPlugin(host, manifest);
  await assert.rejects(plugin.load(), error => error === failure);
  await plugin.load(); assert.deepEqual(calls, []); plugin.unload(); assert.deepEqual(calls, ['cleanup']);
});

test('plugin retains manifest identity and mutates/returns the input command', async () => {
  const { host, manifest, commands, removed } = hostFixture(), plugin = new Plugin(host, manifest);
  assert.equal(plugin.manifest, manifest); await plugin.load();
  const command = { id: 'hello', name: 'Hello' };
  assert.equal(plugin.addCommand(command), command); assert.equal(commands.get('example:hello'), command);
  assert.deepEqual(command, { id: 'example:hello', name: 'Example: Hello' });
  plugin.removeCommand('hello'); plugin.removeCommand('hello'); plugin.unload();
  assert.deepEqual(removed, ['example:hello', 'example:hello', 'example:hello']);
});

test('command collisions delegate to the host and cleanup reads the command current ID', async () => {
  const { host, manifest, removed, commands } = hostFixture(), plugin = new Plugin(host, manifest);
  await plugin.load(); const first = { id: 'same', name: 'First' }, second = { id: 'same', name: 'Second' };
  plugin.addCommand(first); plugin.addCommand(second); assert.equal(commands.get('example:same'), second);
  first.id = 'changed'; plugin.addCommand(second); // Reusing the same object prefixes it again.
  assert.equal(second.id, 'example:example:same'); assert.equal(second.name, 'Example: Example: Second');
  plugin.unload(); assert.deepEqual(removed, ['example:example:same', 'example:example:same', 'changed']);
});

test('existing narrow host data and settings delegation continues to work', async () => {
  const { host, manifest, tabs, data } = hostFixture(), plugin = new Plugin(host, manifest);
  await plugin.load(); let hides = 0;
  plugin.addSettingTab({ display() {}, hide() { hides++; } });
  await plugin.saveData({ color: 'purple' }); assert.deepEqual(await plugin.loadData(), { color: 'purple' });
  assert.equal(data.has('example'), true); plugin.unload(); plugin.unload();
  assert.equal(tabs.size, 0); assert.equal(hides, 1);
});
