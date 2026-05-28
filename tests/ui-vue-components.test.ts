// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import {
  ZBadge,
  ZButton,
  ZCheckboxField,
  ZConfirmDialog,
  ZDialogWindow,
  ZPanel,
  ZPromptDialog,
  ZResizeHandle,
  ZStatusBar,
  ZTag,
  ZTextField,
  ZWindowFrame,
} from '@zorid/ui-vue';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shared ui-vue primitives', () => {
  it('exports plain frame/control/panel/status primitives with stable data hooks', () => {
    const wrapper = mount(defineComponent({
      components: { ZBadge, ZButton, ZCheckboxField, ZPanel, ZResizeHandle, ZStatusBar, ZTag, ZTextField, ZWindowFrame },
      setup() {
        const text = ref('note');
        const checked = ref(false);
        return { text, checked };
      },
      template: `
        <ZWindowFrame title="Window" description="Shared shell">
          <ZPanel title="Panel"><ZBadge>active</ZBadge><ZTag :count="2">tag</ZTag></ZPanel>
          <ZTextField v-model="text" label="Name" />
          <ZCheckboxField v-model="checked" label="Enabled" />
          <ZButton variant="primary">Save</ZButton>
          <ZResizeHandle active />
          <ZStatusBar><span>Ready</span></ZStatusBar>
        </ZWindowFrame>
      `,
    }));

    expect(wrapper.find('[data-z-window-frame]').exists()).toBe(true);
    expect(wrapper.find('[data-z-panel]').exists()).toBe(true);
    expect(wrapper.find('[data-z-badge]').text()).toBe('active');
    expect(wrapper.find('[data-z-tag]').text()).toContain('2');
    expect(wrapper.find('[data-z-resize-handle]').attributes('role')).toBe('separator');
    expect(wrapper.find('[data-z-status-bar]').text()).toBe('Ready');
  });

  it('renders a Reka-backed dialog window and emits close on outside interaction', async () => {
    const wrapper = mount(ZDialogWindow, {
      props: { open: true, title: 'Command palette', description: 'Run commands' },
      slots: { default: '<p>Dialog body</p>' },
      attachTo: document.body,
    });
    await nextTick();

    expect(document.body.querySelector('[data-z-dialog-window]')).not.toBeNull();
    expect(document.body.querySelector('[data-z-dialog-backdrop]')).not.toBeNull();
    document.body.querySelector<HTMLElement>('[data-z-dialog-backdrop]')?.click();
    await nextTick();

    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('keeps framed dialog semantic title hidden so visual title is not duplicated', async () => {
    mount(ZDialogWindow, {
      props: { open: true, title: 'Settings', description: 'Configure the app' },
      slots: { default: '<p>Settings body</p>' },
      attachTo: document.body,
    });
    await nextTick();

    expect(document.body.querySelectorAll('.z-window-frame__title')).toHaveLength(1);
    expect(document.body.querySelector('.z-visually-hidden')?.textContent).toBe('Settings');
    expect(document.body.querySelector('[data-z-dialog-window]')?.textContent).toContain('Settings');
  });


  it('renders accessible titles for frameless dialog windows without Reka warnings', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...args: unknown[]) => { warnings.push(String(message)); originalWarn(message, ...args); };
    try {
      mount(ZDialogWindow, {
        props: { open: true, ariaLabel: 'Command palette', frameless: true },
        slots: { default: '<section class="command-palette">Palette</section>' },
        attachTo: document.body,
      });
      await nextTick();
    } finally {
      console.warn = originalWarn;
    }

    expect(document.body.querySelector('[data-z-dialog-window]')).not.toBeNull();
    expect(warnings.filter((warning) => warning.includes('DialogTitle') || warning.includes('Missing `Description`'))).toEqual([]);
  });

  it('uses Alert Dialog semantics for confirmation flows', async () => {
    const wrapper = mount(ZConfirmDialog, {
      props: { open: true, title: 'Delete file', description: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true },
      attachTo: document.body,
    });
    await nextTick();

    expect(document.body.querySelector('[data-z-confirm-dialog]')).not.toBeNull();
    document.body.querySelectorAll('button')[1]?.click();
    await nextTick();

    expect(wrapper.emitted('confirm')).toHaveLength(1);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('submits prompt input and closes through the shared dialog behavior', async () => {
    const wrapper = mount(ZPromptDialog, {
      props: { open: true, title: 'Rename', label: 'New name', modelValue: 'old.md' },
      attachTo: document.body,
    });
    await nextTick();

    const input = document.body.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    input!.value = 'new.md';
    input!.dispatchEvent(new Event('input'));
    await nextTick();
    document.body.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick();

    expect(wrapper.emitted('submit')?.at(-1)).toEqual(['new.md']);
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['new.md']);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('keeps virtual window helper behavior available beside component exports', async () => {
    const module = await import('@zorid/ui-vue');
    expect(module.computeVirtualWindow({ itemCount: 10, itemHeight: 20, viewportHeight: 40, scrollTop: 40, overscan: 1 })).toEqual({
      start: 1,
      end: 5,
      offsetTop: 20,
      totalHeight: 200,
    });
    expect(typeof module.ZDialogWindow).toBe('object');
  });

  it('does not expose Reka primitives as the public app import surface', async () => {
    const module = await import('@zorid/ui-vue');
    expect(Object.keys(module).filter((key) => key.startsWith('Dialog') || key.startsWith('AlertDialog'))).toEqual([]);
  });
});
