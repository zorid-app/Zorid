// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import MarkdownEditor from '../apps/desktop/src/renderer/src/components/MarkdownEditor.vue';
import type { FileFieldsDto, TypeDto } from '../apps/desktop/src/renderer/src/types.js';

function installDesktopStub(): void {
  Object.defineProperty(window, 'zoridDesktop', {
    configurable: true,
    value: {
      saveDebugLog: vi.fn().mockResolvedValue(undefined),
    },
  });
}

async function flush(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

describe('desktop MarkdownEditor editor-window properties', () => {
  beforeEach(() => {
    installDesktopStub();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders fields as an editor-window document-header contribution and emits edits', async () => {
    const fileFields: FileFieldsDto = {
      path: 'Task.md',
      typeName: 'Task',
      typePath: 'Types/Task.md',
      fields: [
        { key: 'status', value: 'open', source: 'frontmatter', type: 'text' },
        { key: 'owners', value: 'me', source: 'frontmatter', type: 'multiselect' },
      ],
      diagnostics: [],
    };
    const types: TypeDto[] = [{ path: 'Types/Task.md', name: 'Task', fields: [], diagnostics: [] }];

    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        text: '# Task',
        documentPath: 'Task.md',
        fileFields,
        types,
      },
    });
    await flush();

    const contribution = wrapper.find('[data-editor-window-contribution="zorid.core.fields.properties-editor"]');
    expect(contribution.exists()).toBe(true);
    expect(wrapper.find('[data-placement-key="document-header"]').exists()).toBe(true);

    const status = wrapper.element.querySelector<HTMLInputElement>('input[name="status"]');
    expect(status?.value).toBe('open');
    status!.value = 'closed';
    status!.dispatchEvent(new Event('change'));
    const owners = wrapper.element.querySelector<HTMLInputElement>('input[name="owners"]');
    owners!.value = 'me, you';
    owners!.dispatchEvent(new Event('change'));

    const type = wrapper.element.querySelector<HTMLSelectElement>('select[name="zorid.type"]');
    expect(type?.value).toBe('Task');
    type!.value = '';
    type!.dispatchEvent(new Event('change'));
    await flush();

    expect(wrapper.emitted('updateField')?.[0]).toEqual([expect.objectContaining({ key: 'status' }), 'closed']);
    expect(wrapper.emitted('updateField')?.[1]).toEqual([expect.objectContaining({ key: 'owners' }), 'me, you']);
    expect(wrapper.emitted('updateType')?.[0]).toEqual([undefined]);
  });

  it('does not render properties when no file fields are available', async () => {
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: { text: '# Empty', documentPath: 'Empty.md' },
    });
    await flush();

    expect(wrapper.find('.z-fields-properties-editor').exists()).toBe(false);
  });

  it('does not render properties when the fields plugin contribution is disabled', async () => {
    const fileFields: FileFieldsDto = {
      path: 'Task.md',
      typeName: 'Task',
      typePath: 'Types/Task.md',
      fields: [{ key: 'status', value: 'open', source: 'frontmatter', type: 'text' }],
      diagnostics: [],
    };

    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        text: '# Task',
        documentPath: 'Task.md',
        fileFields,
        fieldsPropertiesEnabled: false,
      },
    });
    await flush();

    expect(wrapper.find('.z-fields-properties-editor').exists()).toBe(false);
  });
});
