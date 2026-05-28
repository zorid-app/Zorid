import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultProfile } from '@zorid/platform-api';

export type VaultWindowRole = 'launcher' | 'editor';

export interface DisposableLike {
  dispose(): void | Promise<void>;
}

export interface ManagedWebContents {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export interface ManagedWindow {
  readonly webContents: ManagedWebContents;
  once(event: 'ready-to-show', listener: () => void): void;
  on(event: 'closed', listener: () => void): void;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
}

export interface ManagedRuntimeEvents {
  on(event: 'metadata:index-updated' | 'metadata:index-status' | 'vault:opened', listener: (payload: unknown) => void): DisposableLike;
}

export interface ManagedRuntime {
  readonly kernel: { readonly events: ManagedRuntimeEvents };
  openVault(root: string): Promise<VaultProfile>;
  vaultProfile(): VaultProfile | undefined;
  getIndexStatus(): unknown | Promise<unknown>;
  dispose(): Promise<void> | void;
}

export interface VaultWindowManagerOptions<TWindow extends ManagedWindow = ManagedWindow, TRuntime extends ManagedRuntime = ManagedRuntime> {
  readonly createWindow: (role: VaultWindowRole) => TWindow;
  readonly loadWindow: (window: TWindow, role: VaultWindowRole) => Promise<void>;
  readonly createRuntime: () => TRuntime;
}

interface EditorEntry<TRuntime extends ManagedRuntime, TWindow extends ManagedWindow> {
  readonly root: string;
  readonly senderId: number;
  readonly window: TWindow;
  readonly runtime: TRuntime;
  readonly eventDisposables: DisposableLike[];
  profile?: VaultProfile;
  opening?: Promise<VaultProfile>;
  disposing?: Promise<void>;
}

async function normalizeVaultRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function canSend(window: ManagedWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed();
}

function sendIfLive(window: ManagedWindow, channel: string, payload: unknown): void {
  if (canSend(window)) window.webContents.send(channel, payload);
}

export class VaultWindowManager<TWindow extends ManagedWindow = ManagedWindow, TRuntime extends ManagedRuntime = ManagedRuntime> {
  readonly #createWindow: (role: VaultWindowRole) => TWindow;
  readonly #loadWindow: (window: TWindow, role: VaultWindowRole) => Promise<void>;
  readonly #createRuntime: () => TRuntime;
  readonly #launchersBySender = new Map<number, TWindow>();
  readonly #editorsBySender = new Map<number, EditorEntry<TRuntime, TWindow>>();
  readonly #editorsByRoot = new Map<string, EditorEntry<TRuntime, TWindow>>();

  constructor(options: VaultWindowManagerOptions<TWindow, TRuntime>) {
    this.#createWindow = options.createWindow;
    this.#loadWindow = options.loadWindow;
    this.#createRuntime = options.createRuntime;
  }

  async openLauncherWindow(): Promise<TWindow> {
    const existing = [...this.#launchersBySender.values()].find((window) => !window.isDestroyed());
    if (existing) {
      existing.focus();
      return existing;
    }
    const window = this.#createWindow('launcher');
    this.#launchersBySender.set(window.webContents.id, window);
    this.#prepareWindow(window, 'launcher');
    await this.#loadWindow(window, 'launcher');
    return window;
  }

  async openVault(root: string): Promise<VaultProfile> {
    const normalizedRoot = await normalizeVaultRoot(root);
    const existing = this.#editorsByRoot.get(normalizedRoot);
    if (existing && !existing.window.isDestroyed()) {
      existing.window.focus();
      const profile = existing.profile ?? existing.runtime.vaultProfile() ?? await existing.opening;
      if (!profile) throw new Error('Existing editor runtime has no open vault profile.');
      await this.#sendSnapshot(existing);
      return profile;
    }

    const window = this.#createWindow('editor');
    const runtime = this.#createRuntime();
    const senderId = window.webContents.id;
    const entry: EditorEntry<TRuntime, TWindow> = { root: normalizedRoot, senderId, window, runtime, eventDisposables: [] };
    this.#editorsBySender.set(senderId, entry);
    this.#editorsByRoot.set(normalizedRoot, entry);
    this.#prepareWindow(window, 'editor');
    this.#forwardRuntimeEvents(entry);

    entry.opening = (async () => {
      await this.#loadWindow(window, 'editor');
      const profile = await runtime.openVault(normalizedRoot);
      entry.profile = profile;
      await this.#sendSnapshot(entry);
      return profile;
    })();
    try {
      return await entry.opening;
    } catch (error) {
      try {
        await this.#disposeEditor(entry);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Vault editor failed to open and cleanup failed.');
      }
      throw error;
    }
  }

  runtimeForSender(senderId: number): TRuntime {
    const entry = this.#editorsBySender.get(senderId);
    if (!entry || entry.window.isDestroyed()) throw new Error('No editor runtime is associated with this window.');
    return entry.runtime;
  }

  roleForSender(senderId: number): VaultWindowRole | undefined {
    if (this.#editorsBySender.has(senderId)) return 'editor';
    if (this.#launchersBySender.has(senderId)) return 'launcher';
    return undefined;
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#editorsBySender.values()].map((entry) => this.#disposeEditor(entry)));
    this.#launchersBySender.clear();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), 'One or more editor runtimes failed to dispose.');
  }

  #prepareWindow(window: TWindow, role: VaultWindowRole): void {
    const senderId = window.webContents.id;
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (role === 'launcher') this.#launchersBySender.delete(senderId);
      else {
        const entry = this.#editorsBySender.get(senderId);
        if (entry) {
          void this.#disposeEditor(entry)
            .catch((error: unknown) => { console.error('Failed to dispose Zorid editor runtime after window closed.', error); });
        }
      }
    });
  }

  #forwardRuntimeEvents(entry: EditorEntry<TRuntime, TWindow>): void {
    const forward = (channel: string) => (payload: unknown) => sendIfLive(entry.window, channel, payload);
    entry.eventDisposables.push(entry.runtime.kernel.events.on('metadata:index-updated', forward('zorid:index-updated')));
    entry.eventDisposables.push(entry.runtime.kernel.events.on('metadata:index-status', forward('zorid:index-status')));
    entry.eventDisposables.push(entry.runtime.kernel.events.on('vault:opened', forward('zorid:vault-opened')));
  }

  async #sendSnapshot(entry: EditorEntry<TRuntime, TWindow>): Promise<void> {
    const profile = entry.profile ?? entry.runtime.vaultProfile();
    const indexStatus = await entry.runtime.getIndexStatus();
    sendIfLive(entry.window, 'zorid:editor-snapshot', { profile, indexStatus });
  }

  async #disposeEditor(entry: EditorEntry<TRuntime, TWindow>): Promise<void> {
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      const cleanupTasks = [
        ...entry.eventDisposables.map((disposable) => () => disposable.dispose()),
        () => entry.runtime.dispose(),
      ];
      const cleanupResults = await Promise.allSettled(cleanupTasks.map((task) => Promise.resolve().then(task)));
      this.#editorsBySender.delete(entry.senderId);
      if (this.#editorsByRoot.get(entry.root) === entry) this.#editorsByRoot.delete(entry.root);
      const failures = cleanupResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), 'Editor runtime disposal failed.');
    })();
    return entry.disposing;
  }
}
