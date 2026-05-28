// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FileTree from '../apps/desktop/src/renderer/src/components/FileTree.vue';
import type { VaultEntry } from '../apps/desktop/src/renderer/src/types.js';

function entry(path: string, kind: VaultEntry['kind'], mtimeMs = 1): VaultEntry {
  return { path, kind, mtimeMs, size: kind === 'directory' ? 0 : 10 };
}

describe('desktop file tree rendering source contract', () => {
  it('renders with a recursive node component and no tree-row lucide icons', () => {
    const tree = readFileSync('apps/desktop/src/renderer/src/components/FileTree.vue', 'utf8');
    const node = readFileSync('apps/desktop/src/renderer/src/components/FileTreeNode.vue', 'utf8');

    expect(tree).toContain('FileTreeNode');
    expect(node).toContain('<FileTreeNode');
    expect(`${tree}\n${node}`).not.toMatch(/FileText|Folder|ChevronDown|ChevronRight|@lucide\/vue/);
    expect(node).toContain('tree-disclosure');
    expect(node).toContain('tree-type-label');
    expect(node).toContain('entryTypeLabel(props.entry)');
  });

  it('renders recursive text rows with disclosure glyphs and right-side type labels', async () => {
    const wrapper = mount(FileTree, {
      props: {
        rootEntries: [entry('Folder', 'directory'), entry('.zorid/views/tasks.zbase', 'file')],
        entriesByDirectory: {
          Folder: [entry('Folder/child.md', 'file')],
        },
        expandedDirectories: { Folder: true },
        selectedPath: '.zorid/views/tasks.zbase',
      },
      attachTo: document.body,
    });

    const labels = wrapper.findAll('.tree-label').map((label) => label.text());
    expect(labels).toEqual(['Folder', 'child.md', 'tasks.zbase']);
    expect(wrapper.find('.tree-disclosure').text()).toBe('⌄');
    expect(wrapper.find('.tree-type-label').text()).toBe('BASE');
    expect(wrapper.findAll('svg')).toHaveLength(0);

    await wrapper.findAll('button.tree-item')[2]!.trigger('click');
    expect(wrapper.emitted('openEntry')?.at(-1)).toEqual([expect.objectContaining({ path: '.zorid/views/tasks.zbase' })]);
  });
});
