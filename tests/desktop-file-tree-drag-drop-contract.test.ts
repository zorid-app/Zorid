// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FileTree from '../apps/desktop/src/renderer/src/components/FileTree.vue';
import type { VaultEntry } from '../apps/desktop/src/renderer/src/types.js';

function entry(path: string, kind: VaultEntry['kind'], mtimeMs = 1): VaultEntry {
  return { path, kind, mtimeMs, size: kind === 'directory' ? 0 : 10 };
}

describe('desktop file tree drag-drop contract', () => {
  it('wires root-level drag/drop handlers through FileTree and App', () => {
    const tree = readFileSync('apps/desktop/src/renderer/src/components/FileTree.vue', 'utf8');
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(tree).toContain('file-tree-root-drop-target');
    expect(tree).toContain('dragEnterRoot');
    expect(tree).toContain('dragOverRoot');
    expect(tree).toContain('dropOnRoot');
    expect(tree).toContain('if (event.defaultPrevented) return;');

    expect(app).toContain('@drag-over-root="handleTreeRootDragOver"');
    expect(app).toContain('@drag-enter-root="handleTreeRootDragEnter"');
    expect(app).toContain('@drag-leave-root="handleTreeRootDragLeave"');
    expect(app).toContain('@drop-on-root="handleTreeRootDrop"');
    expect(app).toContain("handleTreeDropTarget('', event)");
  });

  it('supports root highlight state and prevents bubbled directory dragover from stealing root events', async () => {
    const wrapper = mount(FileTree, {
      props: {
        rootEntries: [entry('Folder', 'directory')],
        entriesByDirectory: { Folder: [] },
        expandedDirectories: { Folder: false },
        draggingPath: 'a.md',
        dragOverPath: '',
      },
      attachTo: document.body,
    });

    expect(wrapper.find('.file-tree').classes()).toContain('file-tree-root-drop-target');

    await wrapper.find('.file-tree').trigger('dragover');
    expect(wrapper.emitted('dragOverRoot')).toHaveLength(1);

    await wrapper.find('li').trigger('dragover');
    expect(wrapper.emitted('dragOver')).toEqual([[expect.objectContaining({ path: 'Folder' }), expect.anything()]]);
    expect(wrapper.emitted('dragOverRoot')).toHaveLength(1);
  });

  it('uses depth-based drag hover bookkeeping instead of relatedTarget-only leave logic', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(app).toContain('const dragHoverDepthByPath: Record<string, number> = {}');
    expect(app).toContain('function incrementDragHoverDepth(path: string): void');
    expect(app).toContain('function decrementDragHoverDepth(path: string): number');
    expect(app).toContain('if (decrementDragHoverDepth(entry.path) > 0) return;');
    expect(styles).toContain('.file-tree.file-tree-root-drop-target');
  });
});
