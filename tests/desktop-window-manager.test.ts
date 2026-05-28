import { describe, expect, it, vi } from 'vitest';
import type { VaultProfile } from '../packages/platform-api/src/index';
import type { DisposableLike, ManagedRuntime, ManagedWindow, VaultWindowRole } from '../apps/desktop/src/main/vault-window-manager';

class FakeEvents {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: 'metadata:index-updated' | 'metadata:index-status' | 'vault:opened', listener: (payload: unknown) => void): DisposableLike {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return { dispose: () => listeners.delete(listener) };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  count(event: string): number { return this.listeners.get(event)?.size ?? 0; }
}

class FakeRuntime implements ManagedRuntime {
  readonly events = new FakeEvents();
  readonly kernel = { events: this.events };
  readonly openVault = vi.fn(async (root: string) => {
    this.profile = { id: `folder:${root}`, kind: 'folder', rootLabel: root.split('/').pop() || root };
    this.events.emit('vault:opened', this.profile);
    return this.profile;
  });
  readonly getIndexStatus = vi.fn(async () => ({ state: 'idle', fileCount: 0, diagnostics: [] }));
  readonly dispose = vi.fn(async () => undefined);
  profile?: VaultProfile;
  vaultProfile(): VaultProfile | undefined { return this.profile; }
}

let nextWindowId = 1;
class FakeWindow implements ManagedWindow {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly handlers = new Map<string, Array<() => void>>();
  destroyed = false;
  focused = false;
  readonly #webContents = {
    id: nextWindowId++,
    send: (channel: string, payload: unknown) => { this.sent.push({ channel, payload }); },
    isDestroyed: () => this.destroyed,
  };

  get webContents(): ManagedWindow['webContents'] { return this.#webContents; }
  once(event: 'ready-to-show', listener: () => void): void { this.on(event, listener); }
  on(event: 'closed' | 'ready-to-show', listener: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  show = vi.fn();
  focus = vi.fn(() => { this.focused = true; });
  isDestroyed(): boolean { return this.destroyed; }
  loadURL = vi.fn(async () => undefined);
  loadFile = vi.fn(async () => undefined);
  close(): void {
    this.destroyed = true;
    for (const listener of this.handlers.get('closed') ?? []) listener();
  }
}

class ThrowingWebContentsAfterDestroyWindow extends FakeWindow {
  override get webContents(): ManagedWindow['webContents'] {
    if (this.destroyed) throw new Error('Object has been destroyed');
    return super.webContents;
  }
}

function managerFixture() {
  const windows: FakeWindow[] = [];
  const runtimes: FakeRuntime[] = [];
  return {
    windows,
    runtimes,
    async createManager() {
      const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
      return new VaultWindowManager<FakeWindow, FakeRuntime>({
        createWindow: (_role: VaultWindowRole) => { const win = new FakeWindow(); windows.push(win); return win; },
        loadWindow: async (win, role) => { await win.loadURL(`app://zorid/?zoridWindow=${role}`); },
        createRuntime: () => { const runtime = new FakeRuntime(); runtimes.push(runtime); return runtime; },
      });
    },
  };
}

describe('VaultWindowManager', () => {
  it('opens launchers without creating a runtime and reuses the launcher window', async () => {
    const fixture = managerFixture();
    const manager = await fixture.createManager();

    const first = await manager.openLauncherWindow();
    const second = await manager.openLauncherWindow();

    expect(first).toBe(second);
    expect(first.focus).toHaveBeenCalled();
    expect(fixture.runtimes).toHaveLength(0);
    expect(manager.roleForSender(first.webContents.id)).toBe('launcher');
    expect(() => manager.runtimeForSender(first.webContents.id)).toThrow('No editor runtime');
  });

  it('creates one runtime per editor vault and focuses duplicate same-vault opens', async () => {
    const fixture = managerFixture();
    const manager = await fixture.createManager();

    const first = await manager.openVault('/tmp/VaultA');
    const duplicate = await manager.openVault('/tmp/VaultA');
    const second = await manager.openVault('/tmp/VaultB');

    expect(duplicate).toBe(first);
    expect(second).not.toBe(first);
    expect(fixture.runtimes).toHaveLength(2);
    expect(fixture.windows[0]!.focus).toHaveBeenCalled();
    expect(manager.runtimeForSender(fixture.windows[0]!.webContents.id)).toBe(fixture.runtimes[0]);
    expect(manager.runtimeForSender(fixture.windows[1]!.webContents.id)).toBe(fixture.runtimes[1]);
  });

  it('forwards runtime events only to the owning editor and sends an initial snapshot', async () => {
    const fixture = managerFixture();
    const manager = await fixture.createManager();
    await manager.openVault('/tmp/VaultA');
    await manager.openVault('/tmp/VaultB');

    fixture.runtimes[0]!.events.emit('metadata:index-status', { state: 'ready' });
    fixture.runtimes[1]!.events.emit('metadata:index-updated', { path: 'Note.md' });

    expect(fixture.windows[0]!.sent.map((message) => message.channel)).toContain('zorid:vault-opened');
    expect(fixture.windows[0]!.sent.map((message) => message.channel)).toContain('zorid:editor-snapshot');
    expect(fixture.windows[0]!.sent).toContainEqual({ channel: 'zorid:index-status', payload: { state: 'ready' } });
    expect(fixture.windows[0]!.sent).not.toContainEqual({ channel: 'zorid:index-updated', payload: { path: 'Note.md' } });
    expect(fixture.windows[1]!.sent).toContainEqual({ channel: 'zorid:index-updated', payload: { path: 'Note.md' } });
  });


  it('focuses and awaits an in-flight same-vault open instead of creating a duplicate runtime', async () => {
    const fixture = managerFixture();
    let releaseLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
    const manager = new VaultWindowManager<FakeWindow, FakeRuntime>({
      createWindow: () => { const win = new FakeWindow(); fixture.windows.push(win); return win; },
      loadWindow: async () => loadStarted,
      createRuntime: () => { const runtime = new FakeRuntime(); fixture.runtimes.push(runtime); return runtime; },
    });

    const firstOpen = manager.openVault('/tmp/PendingVault');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicateOpen = manager.openVault('/tmp/PendingVault');
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseLoad();

    await expect(firstOpen).resolves.toMatchObject({ rootLabel: 'PendingVault' });
    await expect(duplicateOpen).resolves.toMatchObject({ rootLabel: 'PendingVault' });
    expect(fixture.runtimes).toHaveLength(1);
    expect(fixture.runtimes[0]!.openVault).toHaveBeenCalledOnce();
    expect(fixture.windows[0]!.focus).toHaveBeenCalled();
  });



  it('allSettles editor cleanup tasks when an event disposable throws synchronously', async () => {
    const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
    const win = new FakeWindow();
    const runtime = new FakeRuntime();
    let registered = 0;
    runtime.events.on = vi.fn((event, listener) => {
      FakeEvents.prototype.on.call(runtime.events, event, listener);
      registered += 1;
      return registered === 1 ? { dispose: () => { throw new Error('sync disposable failed'); } } : { dispose: vi.fn() };
    }) as FakeEvents['on'];
    const manager = new VaultWindowManager<FakeWindow, FakeRuntime>({
      createWindow: () => win,
      loadWindow: async () => undefined,
      createRuntime: () => runtime,
    });

    await manager.openVault('/tmp/SyncThrowVault');
    await manager.disposeAll().catch(() => undefined);

    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(() => manager.runtimeForSender(win.webContents.id)).toThrow('No editor runtime');
  });

  it('preserves the original open failure when cleanup also fails', async () => {
    const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
    const runtime = new FakeRuntime();
    runtime.openVault.mockRejectedValueOnce(new Error('open failed'));
    runtime.dispose.mockRejectedValueOnce(new Error('cleanup failed'));
    const manager = new VaultWindowManager<FakeWindow, FakeRuntime>({
      createWindow: () => new FakeWindow(),
      loadWindow: async () => undefined,
      createRuntime: () => runtime,
    });

    await expect(manager.openVault('/tmp/FailingVault')).rejects.toMatchObject({
      message: 'Vault editor failed to open and cleanup failed.',
      errors: [expect.objectContaining({ message: 'open failed' }), expect.objectContaining({ message: 'Editor runtime disposal failed.' })],
    });
  });

  it('waits for every editor disposal before disposeAll rejects', async () => {
    const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
    const windows: FakeWindow[] = [];
    const runtimes: FakeRuntime[] = [];
    const manager = new VaultWindowManager<FakeWindow, FakeRuntime>({
      createWindow: () => { const win = new FakeWindow(); windows.push(win); return win; },
      loadWindow: async () => undefined,
      createRuntime: () => { const runtime = new FakeRuntime(); runtimes.push(runtime); return runtime; },
    });
    await manager.openVault('/tmp/DisposeA');
    await manager.openVault('/tmp/DisposeB');
    let releaseSecond!: () => void;
    const secondFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
    runtimes[0]!.dispose.mockRejectedValueOnce(new Error('first failed'));
    runtimes[1]!.dispose.mockImplementationOnce(async () => { await secondFinished; });

    const disposeAll = manager.disposeAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(Promise.race([disposeAll.then(() => 'done', () => 'rejected'), Promise.resolve('pending')])).resolves.toBe('pending');
    releaseSecond();

    await expect(disposeAll).rejects.toThrow('One or more editor runtimes failed to dispose.');
    expect(runtimes[0]!.dispose).toHaveBeenCalledOnce();
    expect(runtimes[1]!.dispose).toHaveBeenCalledOnce();
    expect(() => manager.runtimeForSender(windows[0]!.webContents.id)).toThrow('No editor runtime');
    expect(() => manager.runtimeForSender(windows[1]!.webContents.id)).toThrow('No editor runtime');
  });

  it('disposes only the closed editor runtime and does not send to destroyed windows', async () => {
    const fixture = managerFixture();
    const manager = await fixture.createManager();
    await manager.openVault('/tmp/VaultA');
    await manager.openVault('/tmp/VaultB');
    const closed = fixture.windows[0]!;

    closed.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.runtimes[0]!.events.emit('metadata:index-status', { state: 'closed' });
    fixture.runtimes[1]!.events.emit('metadata:index-status', { state: 'open' });

    expect(fixture.runtimes[0]!.dispose).toHaveBeenCalled();
    expect(fixture.runtimes[1]!.dispose).not.toHaveBeenCalled();
    expect(closed.sent).not.toContainEqual({ channel: 'zorid:index-status', payload: { state: 'closed' } });
    expect(fixture.windows[1]!.sent).toContainEqual({ channel: 'zorid:index-status', payload: { state: 'open' } });
    expect(() => manager.runtimeForSender(closed.webContents.id)).toThrow('No editor runtime');
    expect(fixture.runtimes[0]!.events.count('metadata:index-status')).toBe(0);
  });

  it('does not read webContents after Electron destroys a closing editor window', async () => {
    const { VaultWindowManager } = await import('../apps/desktop/src/main/vault-window-manager');
    const win = new ThrowingWebContentsAfterDestroyWindow();
    const runtime = new FakeRuntime();
    const manager = new VaultWindowManager<ThrowingWebContentsAfterDestroyWindow, FakeRuntime>({
      createWindow: () => win,
      loadWindow: async () => undefined,
      createRuntime: () => runtime,
    });

    await manager.openVault('/tmp/DestroyedCloseVault');

    expect(() => win.close()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
