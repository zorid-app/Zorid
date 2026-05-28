#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const wslgRuntimeDir = '/mnt/wslg/runtime-dir';

export function hasCommand(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return spawnSync(lookup, args, { stdio: 'ignore', shell: process.platform !== 'win32' }).status === 0;
}

export function needsDisplay({ platform = process.platform, env = process.env } = {}) {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function hasWslg({ existsSync = fs.existsSync } = {}) {
  return existsSync(`${wslgRuntimeDir}/wayland-0`) || existsSync('/mnt/wslg/.X11-unix/X0');
}

export function withVisibleLinuxDisplay(env = process.env, { existsSync = fs.existsSync } = {}) {
  if (!needsDisplay({ platform: 'linux', env }) || !hasWslg({ existsSync })) return { env, repaired: false };

  return {
    env: {
      ...env,
      DISPLAY: env.DISPLAY || ':0',
      WAYLAND_DISPLAY: env.WAYLAND_DISPLAY || 'wayland-0',
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || wslgRuntimeDir,
      PULSE_SERVER: env.PULSE_SERVER || 'unix:/mnt/wslg/PulseServer',
      ZORID_DISABLE_GPU: env.ZORID_DISABLE_GPU || '1',
    },
    repaired: true,
  };
}

export function buildDesktopDevCommand({
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  commandExists = hasCommand,
} = {}) {
  const pnpm = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const electronViteArgs = ['exec', 'electron-vite', 'dev', ...args];

  if (env.ZORID_DESKTOP_HEADLESS === '1' && needsDisplay({ platform, env }) && commandExists('xvfb-run')) {
    return {
      command: 'xvfb-run',
      args: ['-a', pnpm, ...electronViteArgs],
      usedVirtualDisplay: true,
    };
  }

  return {
    command: pnpm,
    args: electronViteArgs,
    usedVirtualDisplay: false,
  };
}

export function ensureElectronBinary() {
  try {
    // Electron's package exports the executable path and downloads the binary if
    // an install skipped the postinstall artifact. electron-vite expects this
    // path to exist before launching the app.
    return require('electron');
  } catch (error) {
    console.error('Failed to prepare the Electron binary for desktop development.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export function runDesktopDev() {
  ensureElectronBinary();
  const display = withVisibleLinuxDisplay(process.env);
  const { command, args, usedVirtualDisplay } = buildDesktopDevCommand({ env: display.env });

  if (display.repaired) {
    console.log('No display variables found; using WSLg so the Electron window can appear on Windows.');
  } else if (usedVirtualDisplay) {
    console.log('No DISPLAY/WAYLAND_DISPLAY found; launching Electron through invisible xvfb-run because ZORID_DESKTOP_HEADLESS=1.');
  } else if (needsDisplay({ env: display.env })) {
    console.error('No DISPLAY/WAYLAND_DISPLAY found. Start WSLg or a Windows X server for a visible Electron window.');
    console.error('For headless smoke testing only, rerun with ZORID_DESKTOP_HEADLESS=1.');
    process.exit(1);
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: display.env,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDesktopDev();
}
