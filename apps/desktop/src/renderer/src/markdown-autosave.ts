export const MARKDOWN_AUTOSAVE_DELAY_MS = 500;

export interface MarkdownAutosaveSnapshot {
  readonly path: string;
  readonly text: string;
}

interface PendingMarkdownAutosave {
  readonly snapshot: MarkdownAutosaveSnapshot;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface MarkdownAutosaveOptions {
  readonly write: (snapshot: MarkdownAutosaveSnapshot) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface MarkdownAutosaveController {
  schedule(snapshot: MarkdownAutosaveSnapshot): void;
  saveNow(snapshot: MarkdownAutosaveSnapshot): Promise<void>;
  flush(): Promise<void>;
  clear(): void;
  pending(): MarkdownAutosaveSnapshot | undefined;
}

function samePath(left: MarkdownAutosaveSnapshot | undefined, right: MarkdownAutosaveSnapshot): boolean {
  return left?.path === right.path;
}

export function createMarkdownAutosave(options: MarkdownAutosaveOptions): MarkdownAutosaveController {
  let pendingAutosave: PendingMarkdownAutosave | undefined;
  let failedSnapshot: MarkdownAutosaveSnapshot | undefined;
  let writeChain = Promise.resolve();

  function clearPendingTimer(): void {
    if (!pendingAutosave) return;
    clearTimeout(pendingAutosave.timer);
    pendingAutosave = undefined;
  }

  async function writeSnapshot(snapshot: MarkdownAutosaveSnapshot, rethrow = false): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await options.write(snapshot);
        if (samePath(failedSnapshot, snapshot)) failedSnapshot = undefined;
      } catch (error) {
        failedSnapshot = snapshot;
        options.onError?.(error);
        if (rethrow) throw error;
      }
    };
    const result = writeChain.then(run, run);
    writeChain = result.catch(() => undefined);
    await result;
  }

  async function flush(): Promise<void> {
    const autosave = pendingAutosave;
    clearPendingTimer();
    const snapshot = autosave?.snapshot ?? failedSnapshot;
    if (snapshot) await writeSnapshot(snapshot, true);
    await writeChain;
    if (failedSnapshot) await writeSnapshot(failedSnapshot, true);
  }

  return {
    schedule(snapshot) {
      clearPendingTimer();
      if (samePath(failedSnapshot, snapshot)) failedSnapshot = undefined;
      pendingAutosave = {
        snapshot,
        timer: setTimeout(() => {
          const autosave = pendingAutosave;
          pendingAutosave = undefined;
          if (autosave) void writeSnapshot(autosave.snapshot);
        }, MARKDOWN_AUTOSAVE_DELAY_MS),
      };
    },
    async saveNow(snapshot) {
      if (pendingAutosave && pendingAutosave.snapshot.path !== snapshot.path) await flush();
      else clearPendingTimer();
      await writeSnapshot(snapshot, true);
    },
    flush,
    clear: clearPendingTimer,
    pending() {
      return pendingAutosave?.snapshot ?? failedSnapshot;
    },
  };
}
