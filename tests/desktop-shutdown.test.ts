import { describe, expect, it, vi } from 'vitest';

describe('desktop shutdown runtime disposal', () => {
  it('prevents quit until runtimes are disposed and resumes quit once cleanup finishes', async () => {
    const { installRuntimeShutdown } = await import('../apps/desktop/src/main/shutdown');
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const app = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
        return app;
      }),
      quit: vi.fn(),
    };
    let releaseDispose!: () => void;
    const disposeAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDispose = resolve;
        }),
    );
    installRuntimeShutdown(app, { disposeAll }, 'linux');
    const preventDefault = vi.fn();

    handlers.get('before-quit')?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(disposeAll).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    releaseDispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.quit).toHaveBeenCalledOnce();
    handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    expect(disposeAll).toHaveBeenCalledOnce();
  });

  it('disposes when all windows close and quits on non-macOS', async () => {
    const { installRuntimeShutdown } = await import('../apps/desktop/src/main/shutdown');
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const app = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
        return app;
      }),
      quit: vi.fn(),
    };
    const disposeAll = vi.fn(async () => undefined);
    installRuntimeShutdown(app, { disposeAll }, 'linux');

    handlers.get('window-all-closed')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disposeAll).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
