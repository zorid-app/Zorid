/// <reference types="vite/client" />

import type { DesktopBridge } from '../../../index.js';

declare global {
  interface Window {
    readonly zoridDesktop: DesktopBridge;
  }
}
