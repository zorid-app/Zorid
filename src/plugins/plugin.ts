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
  registerCommand(command: Command, plugin: Plugin): void;
  removeCommand(commandId: string, plugin: Plugin): void;
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

  constructor(app: PluginHost, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  override async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.onload();
    // Plugin loading waits for its own hook, but does not await child loads.
    for (const child of this.children.slice()) child.load();
  }

  addCommand(command: Command): Command {
    command.id = `${this.manifest.id}:${command.id}`;
    command.name = `${this.manifest.name}: ${command.name}`;
    this.app.registerCommand(command, this);
    this.register(() => this.app.removeCommand(command.id, this));
    return command;
  }

  removeCommand(commandId: string): void {
    this.app.removeCommand(`${this.manifest.id}:${commandId}`, this);
  }

  addSettingTab(tab: SettingTab): void {
    const release = this.app.registerSettingTab(tab, this);
    this.register(() => { try { tab.hide?.(); } finally { release(); } });
  }

  loadData(): Promise<unknown> { return this.app.loadPluginData(this.manifest.id); }
  saveData(data: unknown): Promise<void> { return this.app.savePluginData(this.manifest.id, data); }
}
