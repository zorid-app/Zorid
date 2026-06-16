import { describe, expect, it } from 'vitest';
import { createEffect, createSignal, For, mountPluginUI, onCleanup, Show } from '../packages/plugin-ui/src/index';

describe('@zorid/plugin-ui package', () => {
  it('exports Solid primitives and adapts components to file renderer mounts', () => {
    expect(typeof createSignal).toBe('function');
    expect(typeof createEffect).toBe('function');
    expect(typeof onCleanup).toBe('function');
    expect(typeof For).toBe('function');
    expect(typeof Show).toBe('function');
    expect(typeof mountPluginUI({ component: () => document.createElement('div') })).toBe('function');
  });
});
