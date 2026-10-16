import { Component } from './component.ts';
import type { ErrorReporter } from './events.ts';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  hotkeys?: { modifiers: ('Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt')[]; key: string }[];
}

export interface SettingTab {
  id?: string;
  name?: string;
  display(): void;
  hide?(): void;
}

/** The host owns UI and persistence. This does not claim to implement Obsidian's App. */
export interface PluginHost {
  registerCommand(command: Command, plugin: Plugin): () => void;
  registerSettingTab(tab: SettingTab, plugin: Plugin): () => void;
  loadPluginData(pluginId: string): Promise<unknown>;
  savePluginData(pluginId: string, data: unknown): Promise<void>;
  reportError?: ErrorReporter;
}

/** Original plugin base covering registration cleanup and data/command/settings hooks. */
export class Plugin extends Component {
  app: PluginHost;
  manifest: PluginManifest;
  settings?: unknown;
  private commands = new Map<string, () => void>();

  constructor(app: PluginHost, manifest: PluginManifest) {
    super(app.reportError);
    if (!manifest.id || /[\s:/\\]/.test(manifest.id)) throw new Error('A plugin manifest needs a valid ID');
    this.app = app;
    this.manifest = { ...manifest };
  }

  addCommand(command: Command): Command {
    if (!command.id || command.id.includes(':')) throw new Error('Command IDs must be nonempty and local to the plugin');
    if (this.commands.has(command.id)) throw new Error(`Command already registered: ${command.id}`);
    const registered = { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` };
    const release = this.app.registerCommand(registered, this);
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      this.commands.delete(command.id);
      release();
    };
    this.commands.set(command.id, cleanup);
    this.register(cleanup);
    return registered;
  }

  removeCommand(commandId: string): void { this.commands.get(commandId)?.(); }

  addSettingTab(tab: SettingTab): void {
    const release = this.app.registerSettingTab(tab, this);
    this.register(() => { try { tab.hide?.(); } finally { release(); } });
  }

  loadData(): Promise<unknown> { return this.app.loadPluginData(this.manifest.id); }
  saveData(data: unknown): Promise<void> { return this.app.savePluginData(this.manifest.id, data); }
}
