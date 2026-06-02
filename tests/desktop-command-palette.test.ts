// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import CommandPaletteWindow from '../apps/desktop/src/renderer/src/components/CommandPaletteWindow.vue';

const commands = [
  { id: 'settings.open', title: 'Open Settings' },
  { id: 'workspace.search', title: 'Search Workspace' },
  { id: 'theme.toggle', title: 'Toggle Theme' },
];

function getPaletteInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('.command-input');
  if (!input) throw new Error('Expected command palette input');
  return input;
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('desktop command palette', () => {
  it('focuses the input when mounted open', async () => {
    const wrapper = mount(CommandPaletteWindow, {
      attachTo: document.body,
      props: { open: true, query: '', commands },
    });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const input = getPaletteInput();
    expect(document.activeElement).toBe(input);
    wrapper.unmount();
  });

  it('focuses the input when opened after mount', async () => {
    const wrapper = mount(CommandPaletteWindow, {
      attachTo: document.body,
      props: { open: false, query: '', commands },
    });

    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const input = getPaletteInput();
    expect(document.activeElement).toBe(input);
    wrapper.unmount();
  });

  it('supports arrow-key selection and enter execution', async () => {
    const wrapper = mount(CommandPaletteWindow, {
      attachTo: document.body,
      props: { open: true, query: '', commands },
    });
    await wrapper.vm.$nextTick();
    const input = getPaletteInput();

    await press(input, 'ArrowDown');
    await press(input, 'Enter');

    expect(wrapper.emitted('run')?.at(-1)).toEqual([commands[1]]);

    await press(input, 'ArrowUp');
    await press(input, 'ArrowUp');
    await press(input, 'Enter');

    expect(wrapper.emitted('run')?.at(-1)).toEqual([commands[2]]);
    wrapper.unmount();
  });

  it('closes on escape', async () => {
    const wrapper = mount(CommandPaletteWindow, {
      attachTo: document.body,
      props: { open: true, query: '', commands },
    });
    await wrapper.vm.$nextTick();
    const input = getPaletteInput();

    await press(input, 'Escape');

    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });
});

describe('desktop command palette shortcut', () => {
  it('uses Cmd/Ctrl+Shift+P without retaining the Cmd/Ctrl+K palette shortcut', () => {
    const app = readFileSync('apps/desktop/src/renderer/src/App.vue', 'utf8');

    expect(app).toContain("event.shiftKey && event.key.toLowerCase() === 'p'");
    expect(app).not.toContain("event.key.toLowerCase() === 'k'");
    expect(app).not.toContain("if (command.id === 'command-palette.open')");
  });
});
