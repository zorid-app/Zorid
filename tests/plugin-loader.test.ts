import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from '@codemirror/state';
import { Plugin } from '../src/plugins/plugin.ts';
import { Component } from '../src/plugins/component.ts';
import { Events } from '../src/plugins/events.ts';
import type { PluginHost, PluginManifest, Command } from '../src/plugins/plugin.ts';
import { createPluginRequire, sharedModuleNames } from '../src/plugins/module-resolver.ts';
import type { SharedPluginModules } from '../src/plugins/module-resolver.ts';
import { PluginLoader } from '../src/plugins/loader.ts';
import type { PluginLoadPolicy } from '../src/plugins/manifest.ts';
import { isApiVersionSupported, parsePluginManifest, pluginLoadBlockReason } from '../src/plugins/manifest.ts';

// Original fixtures. Static expectations: docs/plugin-api-reference.md; cleanup,
// stricter validation, queueing and opt-in minimum-version policy are Zorid choices.
const manifest: PluginManifest = { id: 'fixture', name: 'Fixture', version: '1.0.0', minAppVersion: '1.14.4', description: '', author: '', dir: '.zorid/plugins/fixture' };
const directSource = `const { Plugin } = require('obsidian'); module.exports = class extends Plugin {
  onload() { this.addCommand({id: 'hello', name: 'Hello', callback() {}}); }
};`;

function fixture(source = directSource, css: string | null = '.fixture {}') {
  const commands = new Map<string, Command>(), mounted = new Set<string>(), calls: string[] = [];
  const modules: SharedPluginModules = { obsidian: { Plugin, Component, Events }, '@codemirror/state': state };
  const app: PluginHost = {
    registerCommand(command) { commands.set(command.id, command); },
    removeCommand(id) { commands.delete(id); },
    registerSettingTab() { return () => {}; },
    async loadPluginData() { return null; }, async savePluginData() {},
  };
  const policy: PluginLoadPolicy = { communityPluginsEnabled: true, allowedPlugins: true, isDesktopApp: true };
  let sourceReads = 0;
  const host = {
    app, require: createPluginRequire({ modules }), policy: () => policy,
    async readText(directory: string, file: 'main.js' | 'styles.css') {
      assert.equal(directory, manifest.dir); calls.push(file);
      if (file === 'main.js') { sourceReads++; return source; } return css;
    },
    mountStyles(text: string) { mounted.add(text); return () => { calls.push('removeStyles'); mounted.delete(text); }; },
  };
  return { host, policy, modules, app, commands, mounted, calls, sourceReads: () => sourceReads };
}

test('resolver preserves canonical/alias namespaces and actual CodeMirror extension identity', async () => {
  const f = fixture(`const {Plugin} = require('obsidian'); const {StateField} = require('@codemirror/state');
    exports.default = class extends Plugin { onload() { this.field = StateField.define({create: () => 7, update: x => x}); } };`);
  const aliases = {
    '@codemirror/text': '@codemirror/state', '@codemirror/rangeset': '@codemirror/state',
    '@codemirror/gutter': '@codemirror/view', '@codemirror/panel': '@codemirror/view',
    '@codemirror/rectangular-selection': '@codemirror/view', '@codemirror/tooltip': '@codemirror/view',
    '@codemirror/fold': '@codemirror/language', '@codemirror/highlight': '@codemirror/language',
    '@codemirror/matchbrackets': '@codemirror/language', '@codemirror/stream-parser': '@codemirror/language',
    '@codemirror/comment': '@codemirror/commands', '@codemirror/history': '@codemirror/commands',
    '@codemirror/closebrackets': '@codemirror/autocomplete',
  };
  for (const name of sharedModuleNames) if (name !== 'obsidian' && !f.modules[name]) f.modules[name] = {};
  const diagnostics: string[] = [];
  f.host.require = createPluginRequire({ modules: f.modules, diagnostic: message => diagnostics.push(message) });
  for (const [alias, target] of Object.entries(aliases)) assert.equal(f.host.require(alias), f.host.require(target));
  assert.equal(diagnostics.length, Object.keys(aliases).length - 1);
  for (const name of sharedModuleNames) assert.equal(f.host.require(name), f.modules[name]);
  const loader = new PluginLoader(f.host), plugin = await loader.load(manifest) as Plugin & { field: state.StateField<number> };
  assert.equal(plugin instanceof Plugin, true);
  assert.equal(plugin.app, f.app); assert.equal(plugin.manifest, manifest);
  const editorState = state.EditorState.create({ extensions: [plugin.field] });
  assert.equal(editorState.field(plugin.field), 7);
  await loader.unload(manifest.id);
});

test('resolver delegates only unknown modules and guards missing shared packages and constructor copies', () => {
  const f = fixture(), requests: string[] = [], native = {};
  const require = createPluginRequire({ modules: f.modules, nativeRequire: name => { requests.push(name); return native; } });
  assert.equal(require('node:fs'), native);
  assert.equal(require('toString'), native); // Map lookup must not resolve Object.prototype.
  assert.throws(() => require('@codemirror/view'), /not supplied shared module/);
  assert.deepEqual(requests, ['node:fs', 'toString']);
  assert.throws(() => createPluginRequire({ modules: { obsidian: { Plugin: class {} as unknown as typeof Plugin } } }), /shared Plugin/);
  assert.throws(() => new PluginLoader({ ...f.host, require: () => ({ Plugin: class {} }) }), /shared Plugin/);
  const mobile = createPluginRequire({ modules: f.modules, emulateMobile: true, diagnostic() {}, nativeRequire: () => { throw new Error('must not run'); } });
  assert.equal(mobile('node:fs'), null); assert.equal(mobile('obsidian'), f.modules.obsidian);
  assert.throws(() => createPluginRequire({ modules: f.modules })('node:fs'), /unavailable/);
});

test('manifest parsing binds host directory and normalizes author, with explicitly stricter schema validation', () => {
  const parsed = parsePluginManifest(JSON.stringify({ ...manifest, dir: '/untrusted', author: 'Obsidian' }), '.host/plugin');
  assert.equal(parsed.dir, '.host/plugin'); assert.equal(parsed.author, '');
  const { author: _author, ...missingAuthor } = manifest;
  assert.equal(parsePluginManifest(JSON.stringify(missingAuthor), '.host/plugin').author, '');
  for (const value of [null, [], { ...manifest, id: '' }, { ...manifest, version: 1 }, { ...manifest, isDesktopOnly: 'false' }]) {
    assert.throws(() => parsePluginManifest(JSON.stringify(value), '.host/plugin'));
  }
  assert.throws(() => parsePluginManifest('{broken', '.host/plugin'));
  assert.throws(() => parsePluginManifest(JSON.stringify(manifest), ' '));
});

test('runtime restrictions, host exclusions and opt-in minimum version remain distinct', () => {
  const policy: PluginLoadPolicy = { communityPluginsEnabled: true, allowedPlugins: ['fixture'], isDesktopApp: true };
  assert.equal(pluginLoadBlockReason(manifest, policy), undefined);
  assert.match(pluginLoadBlockReason(manifest, { ...policy, communityPluginsEnabled: false })!, /disabled/);
  assert.match(pluginLoadBlockReason(manifest, { ...policy, allowedPlugins: false })!, /policy/);
  assert.match(pluginLoadBlockReason({ ...manifest, isDesktopOnly: true }, { ...policy, isDesktopApp: false })!, /desktop/);
  assert.equal(pluginLoadBlockReason(manifest, { ...policy, incompatibility: () => 'release exclusion' }), 'release exclusion');
  assert.equal(pluginLoadBlockReason(manifest, { ...policy, minimumVersion: { currentVersion: '0.1.0', enforce: false } }), undefined);
  assert.match(pluginLoadBlockReason(manifest, { ...policy, minimumVersion: { currentVersion: '0.1.0', enforce: true } })!, /version/);
  assert.equal(isApiVersionSupported('1.14.4', '1.14'), true);
  assert.equal(isApiVersionSupported('1.14.4', '1.15.0'), false);
  assert.equal(isApiVersionSupported('1.14.4', '1.14.4-beta'), true);
  assert.equal(isApiVersionSupported('bad', '1.0'), false);
});

test('blocked load performs no file reads, module evaluation or registrations', async () => {
  const f = fixture(); f.policy.communityPluginsEnabled = false;
  const loader = new PluginLoader(f.host);
  await assert.rejects(loader.load(manifest), /disabled/);
  assert.deepEqual(f.calls, []); assert.equal(f.commands.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('policy revocation during an entry read prevents evaluation and onload', async () => {
  let release!: (source: string) => void, entered!: () => void;
  const source = new Promise<string>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(); let evaluated = false;
  const loader = new PluginLoader({ ...f.host, readText: async () => { entered(); return source; }, evaluate() { evaluated = true; } });
  const load = loader.load(manifest); await reading;
  f.policy.communityPluginsEnabled = false; release(directSource);
  await assert.rejects(load, /disabled/); assert.equal(evaluated, false); assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('queued loads reject changed manifest ID or directory instead of mixing policy and storage identities', async () => {
  for (const field of ['id', 'dir'] as const) {
    const f = fixture(), changing = { ...manifest }, loader = new PluginLoader(f.host);
    f.policy.allowedPlugins = ['allowed'];
    const load = loader.load(changing); changing[field] = 'allowed';
    await assert.rejects(load, /identity changed/);
    assert.deepEqual(f.calls, []); assert.equal(loader.getPlugin(manifest.id), undefined); assert.equal(loader.getPlugin('allowed'), undefined);
  }
});

test('policy revocation during stylesheet read cleans up onload and never mounts CSS', async () => {
  let release!: (css: string) => void, entered!: () => void;
  const css = new Promise<string>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(), loader = new PluginLoader({ ...f.host, readText: async (_directory, file) => {
    if (file === 'main.js') return directSource;
    entered(); return css;
  } });
  const load = loader.load(manifest); await reading; assert.equal(f.commands.size, 1);
  f.policy.communityPluginsEnabled = false; release('.fixture {}');
  await assert.rejects(load, /disabled/);
  assert.equal(f.commands.size, 0); assert.equal(f.mounted.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('direct CommonJS export loads once, optional CSS mounts and unload removes registrations', async () => {
  const f = fixture(), loader = new PluginLoader(f.host);
  const [first, second] = await Promise.all([loader.load(manifest), loader.load(manifest)]);
  assert.equal(first, second); assert.equal(f.sourceReads(), 1);
  assert.equal(f.commands.has('fixture:hello'), true); assert.equal(f.mounted.size, 1);
  await loader.unload(manifest.id, true);
  assert.equal((first as Plugin & { _userDisabled: boolean })._userDisabled, true);
  assert.equal(f.commands.size, 0); assert.equal(f.mounted.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
  await loader.load(manifest); assert.equal(f.sourceReads(), 2); await loader.unload(manifest.id);
});

test('no stylesheet is valid and onUserEnable runs only after styles for explicit user enable', async () => {
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    onUserEnable() { this.app.enabled(); }
  };`, null);
  let enabled = 0;
  Object.assign(f.app, { enabled() { assert.equal(f.calls.at(-1), 'styles.css'); enabled++; } });
  const loader = new PluginLoader(f.host);
  await loader.load(manifest); assert.equal(enabled, 0); await loader.unload(manifest.id);
  await loader.load(manifest, true); assert.equal(enabled, 1); assert.equal(f.mounted.size, 0);
  await loader.unload(manifest.id);
});

test('missing entry, invalid export, foreign class, syntax and runtime errors leave no instance', async () => {
  for (const source of ['module.exports = {};', 'module.exports = class {};', 'syntax }', 'throw new Error("module failure");', 'module.exports = () => {};']) {
    const f = fixture(source), loader = new PluginLoader(f.host);
    await assert.rejects(loader.load(manifest)); assert.equal(loader.getPlugin(manifest.id), undefined); assert.equal(f.mounted.size, 0);
  }
  const f = fixture(), loader = new PluginLoader({ ...f.host, readText: async () => null });
  await assert.rejects(loader.load(manifest), /Missing main.js/);
});

test('source URL encodes the plugin ID and CommonJS exports starts as module.exports', async () => {
  const f = fixture(), id = 'fixture\n/with spaces';
  const loader = new PluginLoader({ ...f.host, evaluate(_source, require, module, url) {
    assert.equal(url, `plugin:${encodeURIComponent(id)}`); assert.equal(require('obsidian'), f.modules.obsidian);
    module.exports = class extends Plugin {};
  } });
  await loader.load({ ...manifest, id }); await loader.unload(id);
});

test('onload rejection and stylesheet read failure clean up registered commands and permit retry', async () => {
  for (const failOnload of [true, false]) {
    const f = fixture(`module.exports = class extends require('obsidian').Plugin {
      async onload() { this.addCommand({ id: 'hello', name: 'Hello' }); ${failOnload ? 'throw new Error("hook failed");' : ''} }
    };`);
    if (!failOnload) f.host.readText = async (_directory, file) => { if (file === 'styles.css') throw new Error('CSS failed'); return directSource; };
    const loader = new PluginLoader(f.host);
    await assert.rejects(loader.load(manifest), /failed/);
    assert.equal(f.commands.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
    f.host.readText = async (_directory, file) => file === 'main.js' ? directSource : null;
    await loader.load(manifest); assert.equal(f.commands.size, 1); await loader.unload(manifest.id);
  }
});

test('user-enable failure releases mounted styles and registrations', async () => {
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    onload() { this.addCommand({id: 'hello', name: 'Hello'}); }
    onUserEnable() { throw new Error('enable failed'); }
  };`), loader = new PluginLoader(f.host);
  await assert.rejects(loader.load(manifest, true), /enable failed/);
  assert.equal(f.commands.size, 0); assert.equal(f.mounted.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('cleanup error still removes styles and manager state without claiming all Component callbacks ran', async () => {
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    onload() { this.addCommand({id: 'hello', name: 'Hello'}); this.register(() => {throw new Error('cleanup failed')}); }
  };`), loader = new PluginLoader(f.host);
  await loader.load(manifest);
  await assert.rejects(loader.unload(manifest.id), AggregateError);
  assert.equal(f.mounted.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
  assert.equal(f.commands.size, 1); // Audited Component stops at the throwing cleanup.
});

test('a nonwritable compatibility flag does not prevent plugin cleanup or style/manager removal', async () => {
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    onload() { this.addCommand({id: 'hello', name: 'Hello'}); Object.defineProperty(this, '_userDisabled', {value: false}); }
  };`), loader = new PluginLoader(f.host);
  await loader.load(manifest);
  await assert.rejects(loader.unload(manifest.id, true), AggregateError);
  assert.equal(f.commands.size, 0); assert.equal(f.mounted.size, 0); assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('load failure preserves both original and cleanup errors', async () => {
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    onload() { this.register(() => {throw new Error('cleanup failed')}); throw new Error('load failed'); }
  };`), loader = new PluginLoader(f.host);
  await assert.rejects(loader.load(manifest), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.match(String(error.errors[0]), /load failed/);
    assert.ok(error.errors[1] instanceof AggregateError); return true;
  });
  assert.equal(loader.getPlugin(manifest.id), undefined);
});

test('unload requested during async load waits for it, and later load creates a fresh instance', async () => {
  let release!: () => void, entered!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(`module.exports = class extends require('obsidian').Plugin {
    async onload() { this.app.entered(); await this.app.loading; this.addCommand({id: 'hello', name: 'Hello'}); }
  };`);
  Object.assign(f.app, { loading, entered });
  const loader = new PluginLoader(f.host), firstLoad = loader.load(manifest);
  await started; assert.ok(loader.getPlugin(manifest.id));
  const unload = loader.unload(manifest.id), reload = loader.load(manifest);
  release(); const first = await firstLoad; await unload; const second = await reload;
  assert.notEqual(first, second); assert.equal(f.sourceReads(), 2); assert.equal(f.commands.size, 1);
  await loader.unload(manifest.id); assert.equal(f.commands.size, 0);
});
