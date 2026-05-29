// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TopTabStrip from '../apps/desktop/src/renderer/src/components/TopTabStrip.vue';
import {
  fileTab,
  fileTabId,
  nextTabIdAfterClose,
  placeholderTab,
  placeholderTabId,
} from '../apps/desktop/src/renderer/src/components/top-tab-model';

const file = fileTab('Notes/Workflow improvement.md');
const placeholder = placeholderTab(1);

describe('desktop top tab strip', () => {
  it('emits tab, close, plus, and pane toggle actions without nesting interactive controls', async () => {
    const wrapper = mount(TopTabStrip, {
      props: {
        openTabs: [file, placeholder],
        selectedTabId: file.id,
        leftCollapsed: false,
        rightCollapsed: false,
      },
    });

    expect(wrapper.find('[aria-label="Files"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Search"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Bookmarks"]').exists()).toBe(true);
    expect(wrapper.findAll('button button')).toHaveLength(0);

    await wrapper.find('.top-tab-activate').trigger('click');
    await wrapper.find('[aria-label="Close Workflow improvement.md"]').trigger('click');
    await wrapper.find('[aria-label="New tab"]').trigger('click');
    await wrapper.find('[aria-label="Hide file tree pane"]').trigger('click');
    await wrapper.find('[aria-label="Hide right pane"]').trigger('click');

    expect(wrapper.emitted('activate')?.[0]).toEqual([file.id]);
    expect(wrapper.emitted('close')?.[0]).toEqual([file.id]);
    expect(wrapper.emitted('newTab')).toHaveLength(1);
    expect(wrapper.emitted('toggleLeftPane')).toHaveLength(1);
    expect(wrapper.emitted('toggleRightPane')).toHaveLength(1);
  });

  it('hides only the three nonfunctional left buttons when the file tree pane is collapsed', () => {
    const wrapper = mount(TopTabStrip, {
      props: {
        openTabs: [placeholder],
        selectedTabId: placeholder.id,
        leftCollapsed: true,
        rightCollapsed: true,
      },
    });

    expect(wrapper.find('[aria-label="Files"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Search"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Bookmarks"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Show file tree pane"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Show right pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-app-titlebar]').attributes('data-left-collapsed')).toBe('true');
    expect(wrapper.find('[data-app-titlebar]').attributes('data-right-collapsed')).toBe('true');
  });
});

describe('desktop top tab model helpers', () => {
  it('uses namespaced ids and selects nearest right then left tab after close', () => {
    expect(fileTabId('A.md')).toBe('file:A.md');
    expect(placeholderTabId(2)).toBe('placeholder:2');

    const tabs = [fileTab('A.md'), fileTab('B.md'), placeholderTab(2)];
    expect(nextTabIdAfterClose(tabs, 'file:A.md')).toBe('file:B.md');
    expect(nextTabIdAfterClose(tabs, 'file:B.md')).toBe('placeholder:2');
    expect(nextTabIdAfterClose(tabs, 'placeholder:2')).toBe('file:B.md');
  });
});
