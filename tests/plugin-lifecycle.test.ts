import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from '../src/plugins/events.ts';
import { Component } from '../src/plugins/component.ts';
import { Plugin } from '../src/plugins/plugin.ts';
import type { Command, PluginHost, SettingTab } from '../src/plugins/plugin.ts';

test('event subscriptions preserve context/order, detach individually and isolate listener errors', () => {
  const errors: unknown[] = [], received: string[] = [];
  const events = new Events(error => errors.push(error));
  const context = { prefix: 'context' };
  const first = events.on('change', function (this: typeof context, value: string) { received.push(`${this.prefix}:${value}`); }, context);
  events.on('change', () => { throw new Error('bad listener'); });
  const lastCallback = (value: string) => received.push(`last:${value}`);
  events.on('change', lastCallback);
  events.trigger('change', 'one');
  assert.deepEqual(received, ['context:one', 'last:one']);
  assert.equal(errors.length, 1);
  events.offref(first);
  events.off('change', lastCallback);
  events.trigger('change', 'two');
  assert.equal(received.length, 2);
  assert.equal(errors.length, 2);
});

test('event removals during dispatch apply immediately and additions wait until next dispatch', () => {
  const events = new Events(), received: string[] = [];
  const first = events.on('change', () => {
    received.push('first');
    events.offref(second);
    events.on('change', () => received.push('new'));
  });
  const second = events.on('change', () => received.push('second'));
  events.trigger('change');
  assert.deepEqual(received, ['first']);
  events.offref(first);
  events.trigger('change');
  assert.deepEqual(received, ['first', 'new']);
  new Events().offref(second); // Foreign/already detached references are harmless.
});

test('component load/unload is idempotent, orders children/cleanup and supports reload', () => {
  const calls: string[] = [];
  class Tracked extends Component {
    label: string;
    constructor(label: string) { super(); this.label = label; }
    onload(): void { calls.push(`load:${this.label}`); this.register(() => calls.push(`clean:${this.label}`)); }
    onunload(): void { calls.push(`unload:${this.label}`); }
  }
  const parent = new Tracked('parent'), first = new Tracked('first'), second = new Tracked('second');
  assert.equal(parent.addChild(first), first);
  parent.load(); parent.load();
  parent.addChild(second);
  parent.unload(); parent.unload();
  assert.deepEqual(calls, ['load:parent', 'load:first', 'load:second', 'unload:parent', 'unload:second', 'clean:second', 'unload:first', 'clean:first', 'clean:parent']);
  parent.load();
  assert.deepEqual(calls.slice(-3), ['load:parent', 'load:first', 'load:second']);
  parent.removeChild(first);
  assert.deepEqual(calls.slice(-2), ['unload:first', 'clean:first']);
  parent.unload();
  assert.equal(calls.filter(call => call === 'unload:first').length, 2);
});

test('component rejects cycles and multiple parents and drains all cleanup despite failures', () => {
  const errors: unknown[] = [], calls: string[] = [];
  const parent = new Component(error => errors.push(error)), child = new Component();
  parent.addChild(child);
  assert.throws(() => child.addChild(parent), /cycle/);
  assert.throws(() => new Component().addChild(child), /already has a parent/);
  parent.load();
  parent.register(() => calls.push('one'));
  parent.register(() => { throw new Error('cleanup failed'); });
  parent.register(() => calls.push('three'));
  parent.unload();
  assert.deepEqual(calls, ['three', 'one']);
  assert.equal(errors.length, 1);
});

test('disable during asynchronous load immediately releases late registrations', async () => {
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const events = new Events(), calls: string[] = [];
  class AsyncComponent extends Component {
    async onload(): Promise<void> {
      await barrier;
      this.registerEvent(events.on('change', () => calls.push('leaked')));
      this.register(() => calls.push('late cleanup'));
    }
  }
  const component = new AsyncComponent();
  component.load(); component.unload(); finish();
  await component.whenLoaded();
  events.trigger('change');
  assert.deepEqual(calls, ['late cleanup']);
});

test('failed asynchronous load releases resources and reports the failure', async () => {
  const errors: unknown[] = [], calls: string[] = [];
  class Failing extends Component {
    async onload(): Promise<void> { this.register(() => calls.push('cleanup')); throw new Error('loading failed'); }
    onunload(): void { calls.push('unload'); }
  }
  const component = new Failing(error => errors.push(error));
  component.load();
  await assert.rejects(component.whenLoaded(), /loading failed/);
  assert.deepEqual(calls, ['unload', 'cleanup']);
  assert.equal(errors.length, 1);
});

test('registered event, DOM listener and interval are removed on unload', t => {
  const cleared: unknown[] = [];
  t.mock.method(globalThis, 'clearInterval', (id: unknown) => { cleared.push(id); });
  const component = new Component(), emitter = new Events(), target = new EventTarget();
  let events = 0, dom = 0;
  component.load();
  component.registerEvent(emitter.on('change', () => events++));
  component.registerDomEvent(target, 'change', () => dom++);
  assert.equal(component.registerInterval(42), 42);
  emitter.trigger('change'); target.dispatchEvent(new Event('change'));
  component.unload(); component.unload();
  emitter.trigger('change'); target.dispatchEvent(new Event('change'));
  assert.equal(events, 1); assert.equal(dom, 1);
  assert.deepEqual(cleared, [42]);
});

test('plugin scopes commands/data and removes command/settings registrations exactly once', async () => {
  const commands = new Map<string, Command>(), tabs = new Set<SettingTab>(), data = new Map<string, unknown>();
  const removed: string[] = [];
  const host: PluginHost = {
    registerCommand(command) { commands.set(command.id, command); return () => { removed.push(command.id); commands.delete(command.id); }; },
    registerSettingTab(tab) { tabs.add(tab); return () => { tabs.delete(tab); }; },
    async loadPluginData(id) { return data.get(id) ?? null; },
    async savePluginData(id, value) { data.set(id, structuredClone(value)); },
  };
  const plugin = new Plugin(host, { id: 'example', name: 'Example', version: '1.0.0', minAppVersion: '1.0.0', description: '', author: 'Test' });
  plugin.load();
  const input = { id: 'hello', name: 'Hello' };
  const command = plugin.addCommand(input);
  assert.equal(command.id, 'example:hello'); assert.equal(command.name, 'Example: Hello');
  assert.equal(input.id, 'hello');
  assert.throws(() => plugin.addCommand(input), /already registered/);
  plugin.removeCommand('hello'); plugin.removeCommand('hello');
  plugin.addCommand(input);
  let hides = 0;
  plugin.addSettingTab({ display() {}, hide() { hides++; } });
  await plugin.saveData({ color: 'purple' });
  assert.deepEqual(await plugin.loadData(), { color: 'purple' });
  assert.equal(data.has('example'), true);
  plugin.unload(); plugin.unload();
  assert.equal(commands.size, 0); assert.equal(tabs.size, 0); assert.equal(hides, 1);
  assert.deepEqual(removed, ['example:hello', 'example:hello']);
});
