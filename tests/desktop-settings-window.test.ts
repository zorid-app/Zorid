// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import SettingsWindow from '../apps/desktop/src/renderer/src/components/SettingsWindow.vue';
import type { SettingsSectionDto } from '../apps/desktop/src/renderer/src/types.js';

const sections: readonly SettingsSectionDto[] = [
  {
    id: 'app.general',
    title: 'General',
    source: 'app',
    schema: {
      type: 'object',
      properties: {
        confirmDeletes: { type: 'boolean', title: 'Confirm deletes', description: 'Ask before deleting files.', default: true },
        displayName: { type: 'string', title: 'Display name', description: 'Name shown in the app.', default: 'Zorid' },
      },
    },
  },
  {
    id: 'status-bar',
    title: 'Status Bar',
    source: 'plugin-manifest',
    pluginId: 'zorid.core.status-bar',
    pluginStatus: 'placeholder',
    schema: {
      type: 'object',
      properties: {
        showVault: { type: 'boolean', title: 'Show vault', description: 'Show the active vault.', default: true },
      },
    },
  },
];

const values = {
  'app:app.general': { confirmDeletes: true, displayName: 'Current' },
  'zorid.core.status-bar:status-bar': { showVault: false },
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('desktop SettingsWindow structure', () => {
  it('renders grouped settings navigation and selected settings content', async () => {
    mount(SettingsWindow, {
      props: { open: true, sections, values },
      attachTo: document.body,
    });
    await nextTick();

    expect(document.body.querySelector('.settings-layout')).not.toBeNull();
    expect(document.body.querySelector('.settings-nav')).not.toBeNull();
    expect(document.body.querySelector('.settings-content')).not.toBeNull();
    expect([...document.body.querySelectorAll('.settings-nav-group h3')].map((node) => node.textContent)).toEqual(['Options', 'Plugin settings']);
    expect(document.body.querySelector('.settings-nav-entry--active')?.textContent).toContain('General');
    expect(document.body.querySelector('.settings-content h3')?.textContent).toBe('General');
    expect(document.body.querySelector('.settings-content')?.textContent).toContain('Confirm deletes');

    const statusButton = [...document.body.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')]
      .find((button) => button.textContent?.includes('Status Bar'));
    expect(statusButton).toBeDefined();
    statusButton?.click();
    await nextTick();

    expect(document.body.querySelector('.settings-nav-entry--active')?.textContent).toContain('Status Bar');
    expect(document.body.querySelector('.settings-content h3')?.textContent).toBe('Status Bar');
    expect(document.body.querySelector('.settings-content')?.textContent).toContain('zorid.core.status-bar · placeholder');
    expect(document.body.querySelector('.settings-content')?.textContent).toContain('Show vault');
  });

  it('preserves change-based updateProperty emissions for boolean and text controls', async () => {
    const wrapper = mount(SettingsWindow, {
      props: { open: true, sections, values },
      attachTo: document.body,
    });
    await nextTick();

    const textInput = document.body.querySelector<HTMLInputElement>('.setting-item-control input[type="text"]');
    expect(textInput).not.toBeNull();
    expect(textInput!.value).toBe('Current');
    textInput!.value = 'Updated';
    textInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    expect(wrapper.emitted('updateProperty')?.at(-1)).toMatchObject([
      expect.objectContaining({ id: 'app.general' }),
      expect.objectContaining({ name: 'displayName', type: 'string' }),
      'Updated',
    ]);

    const statusButton = [...document.body.querySelectorAll<HTMLButtonElement>('.settings-nav-entry')]
      .find((button) => button.textContent?.includes('Status Bar'));
    statusButton?.click();
    await nextTick();

    const checkbox = document.body.querySelector<HTMLInputElement>('.setting-item-control input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    expect(wrapper.emitted('updateProperty')?.at(-1)).toMatchObject([
      expect.objectContaining({ id: 'status-bar', pluginId: 'zorid.core.status-bar' }),
      expect.objectContaining({ name: 'showVault', type: 'boolean' }),
      true,
    ]);
  });
});
