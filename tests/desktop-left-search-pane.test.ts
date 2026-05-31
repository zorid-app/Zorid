// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LeftSearchPane from '../apps/desktop/src/renderer/src/components/LeftSearchPane.vue';

describe('desktop left search pane', () => {
  it('autofocuses the search input and shows options on mount', async () => {
    const wrapper = mount(LeftSearchPane, {
      attachTo: document.body,
      props: { searchQuery: '', searchResults: [], searchCandidates: [] },
    });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const input = wrapper.find('input');
    expect(input.exists()).toBe(true);
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.find('[data-search-options-menu]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('supports keyboard option navigation and selection with Enter/Tab', async () => {
    const wrapper = mount(LeftSearchPane, {
      attachTo: document.body,
      props: { searchQuery: '', searchResults: [], searchCandidates: [] },
    });
    const input = wrapper.find('input');
    await input.trigger('focus');

    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Tab' });

    const updates = wrapper.emitted('update:searchQuery') ?? [];
    expect(updates[0]).toEqual(['file:']);
    expect(updates[1]).toEqual(['tag:']);
    expect((wrapper.emitted('runSearch') ?? []).length).toBeGreaterThanOrEqual(2);
    wrapper.unmount();
  });

  it('defocuses on escape', async () => {
    const wrapper = mount(LeftSearchPane, {
      attachTo: document.body,
      props: { searchQuery: '', searchResults: [], searchCandidates: [] },
    });
    const input = wrapper.find('input');
    await input.trigger('focus');

    await input.trigger('keydown', { key: 'Escape' });
    await wrapper.vm.$nextTick();

    expect(document.activeElement).not.toBe(input.element);
    expect(wrapper.find('[data-search-options-menu]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('selects runtime candidates for active operator tokens', async () => {
    const wrapper = mount(LeftSearchPane, {
      attachTo: document.body,
      props: {
        searchQuery: 'path:',
        searchResults: [],
        searchCandidates: [
          { value: '02 - Career', replacement: 'path:"02 - Career"' },
          { value: '03 - Studies', replacement: 'path:"03 - Studies"' },
        ],
      },
    });
    const input = wrapper.find('input');
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'Enter' });

    const updates = wrapper.emitted('update:searchQuery') ?? [];
    expect(updates[0]).toEqual(['path:"02 - Career"']);
    expect((wrapper.emitted('runSearch') ?? []).length).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });
});
