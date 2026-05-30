import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('desktop debug log wiring', () => {
  it('exposes a reusable saveDebugLog bridge and installs renderer error capture', async () => {
    const desktopApi = await readFile('apps/desktop/src/index.ts', 'utf8');
    const preload = await readFile('apps/desktop/src/preload/index.ts', 'utf8');
    const main = await readFile('apps/desktop/src/main/index.ts', 'utf8');
    const rendererMain = await readFile('apps/desktop/src/renderer/src/main.ts', 'utf8');
    const markdownEditor = await readFile('apps/desktop/src/renderer/src/components/MarkdownEditor.vue', 'utf8');

    expect(desktopApi).toContain('saveDebugLog(entry: DesktopDebugLogEntry): Promise<string>');
    expect(preload).toContain("ipcRenderer.invoke('zorid:save-debug-log', entry)");
    expect(main).toContain("ipcMain.handle('zorid:save-debug-log'");
    expect(rendererMain).toContain('installRendererDebugLogging(saveDebugLog)');
    expect(rendererMain).toContain('app.config.errorHandler');
    expect(markdownEditor).toContain('onError: (error, context)');
  });
});
