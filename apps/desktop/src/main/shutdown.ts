import type { App } from 'electron';

export interface RuntimeDisposer {
  disposeAll(): Promise<void>;
}

export function installRuntimeShutdown(app: Pick<App, 'on' | 'quit'>, runtimeDisposer: RuntimeDisposer, platform = process.platform): void {
  let disposal: Promise<void> | undefined;
  let quittingAfterDispose = false;

  async function disposeOnce(): Promise<void> {
    disposal ??= runtimeDisposer.disposeAll();
    await disposal;
  }

  app.on('before-quit', (event) => {
    if (quittingAfterDispose) return;
    event.preventDefault();
    void disposeOnce()
      .catch((error: unknown) => { console.error('Failed to dispose Zorid desktop runtimes before quit.', error); })
      .finally(() => {
        quittingAfterDispose = true;
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    void disposeOnce().catch((error: unknown) => { console.error('Failed to dispose Zorid desktop runtimes after windows closed.', error); });
    if (platform !== 'darwin') app.quit();
  });
}
