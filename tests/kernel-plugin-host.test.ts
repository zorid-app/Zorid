import { describe, expect, it } from 'vitest';
import { CommandRegistry, createZoridKernel, EventBus, ServiceRegistry } from '../packages/app-kernel/src/index';
import type { PluginManifest, ZoridPluginContext } from '../packages/plugin-api/src/index';
import {
  createLazyTriggerIndex,
  createPluginRegistryAPI,
  PluginHost,
  resolveFileRendererContribution,
  resolvePluginOrder,
  validatePluginManifest,
} from '../packages/plugin-host/src/index';
import { asPluginId, type DisposableStack, normalizeVaultPath } from '../packages/shared/src/index';

const fieldsManifest: PluginManifest = {
  schemaVersion: 1,
  id: 'zorid.core.fields',
  name: 'Fields',
  version: '0.1.0',
  kind: 'core',
  entry: './src/index.ts',
  zoridApi: '^0.1.0',
  platforms: ['desktop'],
  capabilities: { required: ['metadata.read', 'commands.register'], optional: [] },
  activation: ['onCommand:fields.open'],
};

const dataViewsManifest: PluginManifest = {
  schemaVersion: 1,
  id: 'zorid.core.data-views',
  name: 'Data Views',
  version: '0.1.0',
  kind: 'core',
  entry: './src/index.ts',
  rendererEntry: './src/file-renderers.ts',
  zoridApi: '^0.1.0',
  platforms: ['desktop'],
  capabilities: {
    required: ['metadata.read', 'workspace.views', 'workspace.fileRenderers', 'vault.read', 'commands.register'],
    optional: [],
  },
  dependsOn: { 'zorid.core.fields': '^0.1.0' },
  activation: ['onMarkdownEmbed:.zbase', 'onFileRenderer:.zbase'],
  contributes: {
    fileRenderers: [
      {
        id: 'zorid.core.data-views.zbase',
        title: 'Zbase Data View',
        extensions: ['.zbase'],
        surfaces: ['full-page', 'markdown-embed'],
        priority: 100,
        rendererExport: 'zbaseFileRenderer',
      },
    ],
  },
};

describe('kernel registries', () => {
  it('registers services, events, and commands with disposable cleanup', async () => {
    const services = new ServiceRegistry();
    const disposable = services.register('answer', 42);
    expect(services.require<number>('answer')).toBe(42);
    disposable.dispose();
    expect(services.optional('answer')).toBeUndefined();

    const events = new EventBus();
    const seen: number[] = [];
    const sub = events.on<number>('tick', (value) => seen.push(value));
    events.emit('tick', 1);
    sub.dispose();
    events.emit('tick', 2);
    expect(seen).toEqual([1]);

    const commands = new CommandRegistry();
    commands.register({ id: 'demo', title: 'Demo', callback: () => 'ok' });
    await expect(commands.execute('demo')).resolves.toBe('ok');
  });

  it('creates metadata-only AppAPI and capability diagnostics', () => {
    const kernel = createZoridKernel({ capabilities: ['metadata.read'] });
    expect(kernel.app.apiInfo().namespaces.app.functions).toHaveProperty('apiInfo');
    expect(JSON.stringify(kernel.app)).not.toContain('getService');
    expect(kernel.capabilities.requireAll(['metadata.read', 'workspace.views'], 'zorid.core.data-views')).toEqual([
      'workspace.views',
    ]);
    expect(kernel.capabilities.diagnostics()[0]).toMatchObject({
      code: 'plugin.capability.missing',
      capability: 'workspace.views',
    });
  });
});

describe('plugin host', () => {
  it('validates manifests and optional activation/contributes', () => {
    expect(validatePluginManifest(fieldsManifest)).toEqual({ ok: true, errors: [] });
    expect(validatePluginManifest(dataViewsManifest)).toEqual({ ok: true, errors: [] });
    expect(validatePluginManifest({ ...fieldsManifest, id: 'Bad ID' }).ok).toBe(false);
    expect(validatePluginManifest({ ...dataViewsManifest, rendererEntry: undefined }).errors).toContain(
      'rendererEntry is required when contributes.fileRenderers exists',
    );
    expect(validatePluginManifest({ ...dataViewsManifest, kind: 'community' }).errors).toContain(
      'community plugins cannot contribute trusted fileRenderers',
    );
    expect(
      validatePluginManifest({
        ...dataViewsManifest,
        capabilities: { required: ['metadata.read', 'workspace.views', 'vault.read'], optional: [] },
      }).errors,
    ).toContain('workspace.fileRenderers capability is required when contributes.fileRenderers exists');
  });

  it('orders dependencies and rejects cycles', () => {
    expect(resolvePluginOrder([dataViewsManifest, fieldsManifest])).toEqual([
      'zorid.core.fields',
      'zorid.core.data-views',
    ]);
    expect(() =>
      resolvePluginOrder([{ ...fieldsManifest, dependsOn: { 'zorid.core.data-views': '^0.1.0' } }, dataViewsManifest]),
    ).toThrow(/cycle/i);
  });

  it('exposes plugin load status through registry API without activation', () => {
    const host = new PluginHost({
      manifests: [fieldsManifest],
      platform: 'desktop',
      capabilities: new Set(['metadata.read', 'commands.register']),
      load: () => ({ activate: () => undefined }),
      createBaseContext: (manifest, stack: DisposableStack) =>
        ({
          pluginId: asPluginId(manifest.id),
          register: {
            command: (command) => stack.use({ dispose: () => undefined }),
            disposable: (disposable) => stack.use(disposable),
          },
        }) as ZoridPluginContext,
    });
    const registry = createPluginRegistryAPI(host);
    const status = registry.getStatus('zorid.core.fields');
    expect(status?.status).toBe('placeholder');
    expect(status?.dependencyChain).toEqual([]);
    expect(status?.capabilityDiagnostics).toEqual([]);
    expect(registry.listStatuses()).toHaveLength(1);
  });

  it('emits lazy-load lifecycle events for placeholders, loads, failures, and unloads', async () => {
    const events: string[] = [];
    const host = new PluginHost({
      manifests: [fieldsManifest],
      platform: 'desktop',
      capabilities: new Set(['metadata.read', 'commands.register']),
      events: {
        emit: (event) => {
          events.push(event);
        },
      },
      load: () => ({ activate: () => undefined }),
      createBaseContext: (manifest, stack: DisposableStack) =>
        ({
          pluginId: asPluginId(manifest.id),
          register: { disposable: (disposable) => stack.use(disposable) },
        }) as ZoridPluginContext,
      now: () => 10,
    });
    expect(events).toContain('plugin:placeholder-registered');
    await host.activate('zorid.core.fields');
    await host.deactivate('zorid.core.fields');
    expect(events).toEqual(expect.arrayContaining(['plugin:load-started', 'plugin:loaded', 'plugin:unloaded']));
    expect(host.record('zorid.core.fields')?.loadedAtMs).toBe(10);
  });

  it('creates lazy trigger indexes without importing runtimes', () => {
    const index = createLazyTriggerIndex([fieldsManifest, dataViewsManifest]);
    expect(index.onCommand.get('fields.open')).toEqual(['zorid.core.fields']);
    expect(index.onMarkdownEmbed.get('.zbase')).toEqual(['zorid.core.data-views']);
    expect(index.onFileRenderer.get('.zbase')).toEqual(['zorid.core.data-views']);
    expect(resolveFileRendererContribution([dataViewsManifest], 'views/tasks.zbase', 'markdown-embed')).toMatchObject({
      id: 'zorid.core.data-views.zbase',
      pluginId: 'zorid.core.data-views',
    });
  });

  it('disables plugins with missing required capabilities before runtime import', () => {
    let imported = false;
    const host = new PluginHost({
      manifests: [fieldsManifest, dataViewsManifest],
      platform: 'desktop',
      capabilities: new Set(['metadata.read']),
      load: () => {
        imported = true;
        return { activate: () => undefined };
      },
      createBaseContext: () => ({ pluginId: asPluginId('zorid.core.data-views') }) as ZoridPluginContext,
    });
    expect(host.record('zorid.core.data-views')?.status).toBe('disabled');
    expect(imported).toBe(false);
  });

  it('wraps direct commands/settings/objects APIs and records optional missing capabilities without failing activation', async () => {
    const optionalCommandsManifest = {
      ...fieldsManifest,
      capabilities: { required: ['metadata.read'], optional: ['commands.register', 'settings.register'] },
    } as PluginManifest;
    const calls: string[] = [];
    const host = new PluginHost({
      manifests: [optionalCommandsManifest],
      platform: 'desktop',
      capabilities: new Set(['metadata.read']),
      load: () => ({
        activate: (ctx) => {
          try {
            ctx.commands.register({ id: 'x', title: 'X' });
          } catch (error) {
            calls.push((error as { code?: string }).code ?? 'command-error');
          }
          try {
            ctx.settings.register({ id: 's', title: 'S', schema: {} });
          } catch (error) {
            calls.push((error as { code?: string }).code ?? 'settings-error');
          }
          calls.push('activated');
        },
      }),
      createBaseContext: () =>
        ({
          pluginId: asPluginId('zorid.core.fields'),
          commands: {
            register: () => {
              calls.push('command-registered');
              return { dispose: () => undefined };
            },
            execute: async () => undefined,
            list: () => [],
          },
          settings: {
            register: () => {
              calls.push('setting-registered');
              return { dispose: () => undefined };
            },
          },
        }) as ZoridPluginContext,
    });
    await expect(host.activate('zorid.core.fields')).resolves.toBeUndefined();
    expect(calls).toEqual(['plugin.capability.unavailable', 'plugin.capability.unavailable', 'activated']);
    expect(host.record('zorid.core.fields')?.capabilityDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'plugin.capability.missing', capability: 'commands.register' }),
        expect.objectContaining({ code: 'plugin.capability.missing', capability: 'settings.register' }),
      ]),
    );
  });

  it('injects host-derived plugin identity into DataViews render contexts', async () => {
    let caller = '';
    const host = new PluginHost({
      manifests: [dataViewsManifest, fieldsManifest],
      platform: 'desktop',
      capabilities: new Set([
        'metadata.read',
        'workspace.views',
        'workspace.fileRenderers',
        'vault.read',
        'commands.register',
      ]),
      load: (manifest) => ({
        activate: async (ctx) => {
          if (manifest.id === 'zorid.core.data-views')
            await ctx.dataViews.renderEmbed(
              { innerHTML: '' } as HTMLElement,
              normalizeVaultPath('.zorid/views/tasks.zbase'),
            );
        },
      }),
      createBaseContext: (manifest) =>
        ({
          pluginId: asPluginId(manifest.id),
          dataViews: {
            registerRenderer: () => ({ dispose: () => undefined }),
            evaluateFilters: async () => [],
            openBase: async () => undefined,
            renderEmbed: async () => ({ dispose: () => undefined }),
            renderEmbedForPlugin: async (
              _container: HTMLElement,
              _path: unknown,
              callerPluginId: ReturnType<typeof asPluginId>,
            ) => {
              caller = callerPluginId;
              return { dispose: () => undefined };
            },
          },
          register: { disposable: (disposable) => disposable },
        }) as ZoridPluginContext,
    });
    await host.activate('zorid.core.data-views');
    expect(caller).toBe('zorid.core.data-views');
  });

  it('denies undeclared capability use through host-owned context wrappers', async () => {
    const underDeclared = {
      ...fieldsManifest,
      capabilities: { required: ['metadata.read'], optional: [] },
    } as PluginManifest;
    const host = new PluginHost({
      manifests: [underDeclared],
      platform: 'desktop',
      capabilities: new Set(['metadata.read', 'commands.register']),
      load: () => ({ activate: (ctx) => ctx.register.command({ id: 'x', title: 'X' }) }),
      createBaseContext: (manifest, stack: DisposableStack) =>
        ({
          pluginId: asPluginId(manifest.id),
          register: {
            command: (command) => stack.use({ dispose: () => undefined }),
            disposable: (disposable) => stack.use(disposable),
          },
        }) as ZoridPluginContext,
    });
    await expect(host.activate('zorid.core.fields')).rejects.toThrow(/did not declare/);
    expect(host.record('zorid.core.fields')?.capabilityDiagnostics?.[0]).toMatchObject({
      code: 'plugin.capability.undeclared',
      capability: 'commands.register',
    });
  });

  it('activates dependencies, records status, and disposes lifecycle resources', async () => {
    const activated: string[] = [];
    const disposed: string[] = [];
    const host = new PluginHost({
      manifests: [dataViewsManifest, fieldsManifest],
      platform: 'desktop',
      capabilities: new Set([
        'metadata.read',
        'workspace.views',
        'workspace.fileRenderers',
        'vault.read',
        'commands.register',
      ]),
      load: (manifest) => ({
        activate: (ctx) => {
          activated.push(manifest.id);
          ctx.register.disposable(() => disposed.push(manifest.id));
        },
      }),
      createBaseContext: (manifest, stack: DisposableStack) =>
        ({
          pluginId: asPluginId(manifest.id),
          register: { disposable: (disposable) => stack.use(disposable) },
        }) as ZoridPluginContext,
      now: () => 100,
    });
    await host.activate('zorid.core.data-views', 'trigger', 'onMarkdownEmbed:.zbase');
    expect(activated).toEqual(['zorid.core.fields', 'zorid.core.data-views']);
    expect(host.record('zorid.core.data-views')?.status).toBe('active');
    await host.deactivate('zorid.core.data-views');
    expect(disposed).toEqual(['zorid.core.data-views']);
  });
});
