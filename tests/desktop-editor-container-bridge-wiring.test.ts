import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop editor container bridge wiring', () => {
  it('exposes resolveEditorContainers across bridge type, main IPC, and preload', () => {
    const bridgeTypes = readFileSync('apps/desktop/src/index.ts', 'utf8');
    const main = readFileSync('apps/desktop/src/main/index.ts', 'utf8');
    const preload = readFileSync('apps/desktop/src/preload/index.ts', 'utf8');

    expect(bridgeTypes).toContain('resolveEditorContainers(): Promise<readonly EditorContainerMatchDto[]>');
    expect(main).toContain("ipcMain.handle('zorid:resolve-editor-containers'");
    expect(main).toContain('runtimeFor(event).resolveEditorContainers()');
    expect(preload).toContain("resolveEditorContainers: () => ipcRenderer.invoke('zorid:resolve-editor-containers')");
  });

  it('loads resolved editor containers in App.vue and passes them to MarkdownEditor', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(app).toContain('const editorContainers = ref<readonly EditorContainerMatchDto[]>([])');
    expect(app).toContain('desktop.resolveEditorContainers()');
    expect(app).toContain(':editor-containers="editorContainers"');
  });
});
