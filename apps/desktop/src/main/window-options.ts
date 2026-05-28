import type { BrowserWindowConstructorOptions } from 'electron';
import { EDITOR_TRAFFIC_LIGHT_POSITION } from '../chrome-layout.js';
import type { VaultWindowRole } from './vault-window-manager.js';

export function managedWindowOptions(role: VaultWindowRole, preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: role === 'launcher' ? 1040 : 1280,
    height: role === 'launcher' ? 720 : 860,
    minWidth: role === 'launcher' ? 820 : 960,
    minHeight: role === 'launcher' ? 560 : 640,
    show: false,
    ...(role === 'editor' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: EDITOR_TRAFFIC_LIGHT_POSITION,
    } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
