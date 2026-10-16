import { Plugin } from './plugin.ts';
import type { PluginHost, PluginManifest } from './plugin.ts';
import { pluginLoadBlockReason, validatePluginManifest } from './manifest.ts';
import type { PluginLoadPolicy } from './manifest.ts';
import type { PluginRequire } from './module-resolver.ts';

export interface CommonJsModule { exports: unknown }
export type CommonJsEvaluator = (source: string, require: PluginRequire, module: CommonJsModule, sourceUrl: string) => void;

/** Executes trusted, explicitly selected code in this realm. This is not a sandbox. */
export const evaluateCommonJs: CommonJsEvaluator = (source, require, module, sourceUrl) => {
  const execute = new Function('require', 'module', 'exports', `${source}\n//# sourceURL=${sourceUrl}\n`);
  execute(require, module, module.exports);
};

export interface PluginLoaderHost {
  /** Passed by identity; the narrow existing type does not claim an App facade. */
  app: PluginHost;
  require: PluginRequire;
  policy: () => PluginLoadPolicy;
  /** Return null only for a missing file. Other failures must reject. */
  readText: (directory: string, file: 'main.js' | 'styles.css') => Promise<string | null>;
  /** Mount before custom CSS in the real host. Must clean up internally if it throws. */
  mountStyles: (css: string, manifest: PluginManifest) => () => void;
  evaluate?: CommonJsEvaluator;
}

type LoadablePlugin = Plugin & { onUserEnable?: () => void | Promise<void>; _userDisabled?: boolean };
interface LoadedPlugin { plugin: LoadablePlugin; removeStyles?: () => void }

/** Isolated loader foundation. Discovery, persistent enabled IDs and real App services belong to the host. */
export class PluginLoader {
  private host: PluginLoaderHost;
  private loaded = new Map<string, LoadedPlugin>();
  private operations = new Map<string, Promise<unknown>>();

  constructor(host: PluginLoaderHost) {
    if ((host.require('obsidian') as { Plugin?: unknown } | null)?.Plugin !== Plugin) {
      throw new Error('Plugin loader requires the shared Plugin constructor');
    }
    this.host = host;
  }

  /** An instance becomes visible before its onload completes, as in the static trace. */
  getPlugin(id: string): Plugin | undefined { return this.loaded.get(id)?.plugin; }

  async load(manifest: PluginManifest, userEnable = false): Promise<Plugin> {
    validatePluginManifest(manifest);
    if (!manifest.dir?.trim()) return Promise.reject(new Error('Plugin manifest has no discovered directory'));
    const id = manifest.id, directory = manifest.dir;
    const assertAllowed = () => {
      if (manifest.id !== id || manifest.dir !== directory) throw new Error('Plugin identity changed during loading');
      const reason = pluginLoadBlockReason(manifest, this.host.policy());
      if (reason) throw new Error(reason);
    };
    return this.enqueue(id, async () => {
      assertAllowed();
      const existing = this.loaded.get(id);
      if (existing) return existing.plugin;
      const source = await this.host.readText(directory, 'main.js');
      assertAllowed();
      if (source === null) throw new Error(`Missing main.js for plugin ${id}`);
      const module: CommonJsModule = { exports: {} };
      (this.host.evaluate ?? evaluateCommonJs)(source, this.host.require, module, `plugin:${encodeURIComponent(id)}`);
      const exported = module.exports;
      const constructor = (exported as { default?: unknown } | null)?.default || exported;
      if (typeof constructor !== 'function') throw new Error(`Plugin ${id} does not export a constructor`);
      assertAllowed();
      const plugin = new (constructor as new (app: PluginHost, manifest: PluginManifest) => LoadablePlugin)(this.host.app, manifest);
      if (!(plugin instanceof Plugin)) throw new Error(`Plugin ${id} must extend the shared Plugin constructor`);
      const entry: LoadedPlugin = { plugin };
      this.loaded.set(id, entry);
      try {
        assertAllowed();
        await plugin.load();
        assertAllowed();
        const css = await this.host.readText(directory, 'styles.css');
        assertAllowed();
        if (css !== null) entry.removeStyles = this.host.mountStyles(css, manifest);
        assertAllowed();
        if (userEnable) await plugin.onUserEnable?.();
        assertAllowed();
        return plugin;
      } catch (error) {
        try { this.dispose(id, entry, false); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `Plugin ${id} failed to load and clean up`); }
        throw error;
      }
    });
  }

  unload(id: string, userDisabled = false): Promise<void> {
    return this.enqueue(id, async () => {
      const entry = this.loaded.get(id);
      if (entry) this.dispose(id, entry, userDisabled);
    });
  }

  private dispose(id: string, entry: LoadedPlugin, userDisabled: boolean): void {
    const errors: unknown[] = [];
    try { entry.plugin._userDisabled = userDisabled; } catch (error) { errors.push(error); }
    try { entry.plugin.unload(); } catch (error) { errors.push(error); }
    try { entry.removeStyles?.(); } catch (error) { errors.push(error); }
    finally { this.loaded.delete(id); }
    if (errors.length) throw new AggregateError(errors, `Plugin ${id} cleanup failed`);
  }

  /** Serializes per plugin, allowing independent plugins to load concurrently. */
  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.operations.set(id, next);
    const finish = () => { if (this.operations.get(id) === next) this.operations.delete(id); };
    void next.then(finish, finish);
    return next;
  }
}
