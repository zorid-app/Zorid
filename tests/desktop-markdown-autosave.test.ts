import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownAutosave, MARKDOWN_AUTOSAVE_DELAY_MS } from '../apps/desktop/src/renderer/src/markdown-autosave';

describe('markdown autosave debounce controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces rapid edits and writes the latest snapshot after 500 ms', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    const autosave = createMarkdownAutosave({ write: async (snapshot) => void writes.push(snapshot) });

    autosave.schedule({ path: 'A.md', text: 'first' });
    autosave.schedule({ path: 'A.md', text: 'second' });

    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS - 1);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ path: 'A.md', text: 'second' }]);
  });

  it('flushes a pending old-path edit before navigation can replace editor state', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    const autosave = createMarkdownAutosave({ write: async (snapshot) => void writes.push(snapshot) });

    autosave.schedule({ path: 'A.md', text: 'A2' });
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);

    expect(writes).toEqual([{ path: 'A.md', text: 'A2' }]);
  });

  it('keeps a failed background autosave retryable for the next flush', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    let shouldFail = true;
    const autosave = createMarkdownAutosave({
      write: async (snapshot) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('disk busy');
        }
        writes.push(snapshot);
      },
    });

    autosave.schedule({ path: 'A.md', text: 'retry me' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);
    expect(autosave.pending()).toEqual({ path: 'A.md', text: 'retry me' });

    await autosave.flush();
    expect(writes).toEqual([{ path: 'A.md', text: 'retry me' }]);
    expect(autosave.pending()).toBeUndefined();
  });

  it('clears a failed same-path snapshot when clean state is saved', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    let shouldFail = true;
    const autosave = createMarkdownAutosave({
      write: async (snapshot) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('disk busy');
        }
        writes.push(snapshot);
      },
    });

    autosave.schedule({ path: 'A.md', text: 'stale failed text' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);
    expect(autosave.pending()).toEqual({ path: 'A.md', text: 'stale failed text' });

    await autosave.saveNow({ path: 'A.md', text: 'saved text' });
    await autosave.flush();

    expect(writes).toEqual([{ path: 'A.md', text: 'saved text' }]);
    expect(autosave.pending()).toBeUndefined();
  });

  it('saves clean text after an in-flight dirty autosave fails', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    let markDirtyWriteStarted!: () => void;
    let releaseDirtyWrite!: () => void;
    const dirtyWriteStarted = new Promise<void>((resolve) => {
      markDirtyWriteStarted = resolve;
    });
    const autosave = createMarkdownAutosave({
      write: async (snapshot) => {
        if (snapshot.text === 'dirty text') {
          markDirtyWriteStarted();
          await new Promise<void>((resolve) => {
            releaseDirtyWrite = resolve;
          });
          throw new Error('disk busy');
        }
        writes.push(snapshot);
      },
    });

    autosave.schedule({ path: 'A.md', text: 'dirty text' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);
    await dirtyWriteStarted;

    const cleanSave = autosave.saveNow({ path: 'A.md', text: 'saved text' });
    await Promise.resolve();
    expect(writes).toEqual([]);

    releaseDirtyWrite();
    await cleanSave;
    await autosave.flush();

    expect(writes).toEqual([{ path: 'A.md', text: 'saved text' }]);
    expect(autosave.pending()).toBeUndefined();
  });

  it('retries an in-flight background failure before flush resolves', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    let markFirstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    let attempt = 0;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const autosave = createMarkdownAutosave({
      write: async (snapshot) => {
        attempt += 1;
        if (attempt === 1) {
          markFirstWriteStarted();
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
          throw new Error('disk busy');
        }
        writes.push(snapshot);
      },
    });

    autosave.schedule({ path: 'A.md', text: 'A2' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);
    await firstWriteStarted;

    const flush = autosave.flush();
    await Promise.resolve();
    expect(writes).toEqual([]);

    releaseFirstWrite();
    await flush;

    expect(writes).toEqual([{ path: 'A.md', text: 'A2' }]);
    expect(autosave.pending()).toBeUndefined();
  });

  it('serializes an immediate save after an in-flight debounced write', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    let markFirstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const autosave = createMarkdownAutosave({
      write: async (snapshot) => {
        if (snapshot.text === 'old') {
          markFirstWriteStarted();
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        writes.push(snapshot);
      },
    });

    autosave.schedule({ path: 'A.md', text: 'old' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);
    await firstWriteStarted;

    const immediateSave = autosave.saveNow({ path: 'A.md', text: 'new' });
    await Promise.resolve();
    expect(writes).toEqual([]);

    releaseFirstWrite();
    await immediateSave;

    expect(writes).toEqual([
      { path: 'A.md', text: 'old' },
      { path: 'A.md', text: 'new' },
    ]);
  });

  it('clears pending debounce work when an immediate save supersedes it', async () => {
    vi.useFakeTimers();
    const writes: Array<{ path: string; text: string }> = [];
    const autosave = createMarkdownAutosave({ write: async (snapshot) => void writes.push(snapshot) });

    autosave.schedule({ path: 'A.md', text: 'pending' });
    await autosave.saveNow({ path: 'A.md', text: 'manual' });
    await vi.advanceTimersByTimeAsync(MARKDOWN_AUTOSAVE_DELAY_MS);

    expect(writes).toEqual([{ path: 'A.md', text: 'manual' }]);
  });
});
