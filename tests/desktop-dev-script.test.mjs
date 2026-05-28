import { describe, expect, it } from 'vitest';
import { buildDesktopDevCommand, needsDisplay, withVisibleLinuxDisplay } from '../scripts/desktop-dev.mjs';

const noCommands = () => false;

describe('desktop dev launcher', () => {
  it('detects Linux sessions that need a display', () => {
    expect(needsDisplay({ platform: 'linux', env: {} })).toBe(true);
    expect(needsDisplay({ platform: 'linux', env: { DISPLAY: ':0' } })).toBe(false);
    expect(needsDisplay({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe(false);
    expect(needsDisplay({ platform: 'darwin', env: {} })).toBe(false);
  });

  it('repairs missing display variables when WSLg is available', () => {
    expect(withVisibleLinuxDisplay({}, { existsSync: (path) => path === '/mnt/wslg/runtime-dir/wayland-0' })).toEqual({
      repaired: true,
      env: {
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_RUNTIME_DIR: '/mnt/wslg/runtime-dir',
        PULSE_SERVER: 'unix:/mnt/wslg/PulseServer',
        ZORID_DISABLE_GPU: '1',
      },
    });
  });

  it('does not use invisible xvfb-run by default', () => {
    expect(
      buildDesktopDevCommand({
        platform: 'linux',
        env: {},
        args: [],
        commandExists: (command) => command === 'xvfb-run',
      }),
    ).toEqual({
      command: 'pnpm',
      args: ['exec', 'electron-vite', 'dev'],
      usedVirtualDisplay: false,
    });
  });

  it('wraps electron-vite with xvfb-run only for explicit headless smoke tests', () => {
    expect(
      buildDesktopDevCommand({
        platform: 'linux',
        env: { ZORID_DESKTOP_HEADLESS: '1' },
        args: [],
        commandExists: (command) => command === 'xvfb-run',
      }),
    ).toEqual({
      command: 'xvfb-run',
      args: ['-a', 'pnpm', 'exec', 'electron-vite', 'dev'],
      usedVirtualDisplay: true,
    });
  });

  it('runs electron-vite directly when a display exists and preserves extra args', () => {
    expect(
      buildDesktopDevCommand({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        args: ['--watch'],
        commandExists: noCommands,
      }),
    ).toEqual({
      command: 'pnpm',
      args: ['exec', 'electron-vite', 'dev', '--watch'],
      usedVirtualDisplay: false,
    });
  });
});
