import type { VaultEntry } from '../core/types';
import type { ContextMenuRequest } from './context-menu';

export interface DesktopVault { path: string; name: string }
export interface DesktopWindowInfo { id: string; initialState: 'restore' | 'empty' }
export interface VaultChange { vault?: string; type: string; path?: string; message?: string }
export interface DesktopBridge {
  getWindowInfo?(): Promise<DesktopWindowInfo>;
  newWindow?(): Promise<{ id: string }>;
  compareAndWrite?(vault: string, path: string, expectedContent: string, contents: string): Promise<void>;
  showContextMenu?(request: ContextMenuRequest): Promise<string | null>;
  dismissContextMenu?(): Promise<void>;
  getPathForFile?(file: File): string;
  getVault(): Promise<DesktopVault | null>;
  openVault(): Promise<DesktopVault | null>;
  list(vault: string): Promise<VaultEntry[]>;
  stat(vault: string, path: string): Promise<VaultEntry | null>;
  read(vault: string, path: string): Promise<string>;
  readBinary(vault: string, path: string): Promise<Uint8Array>;
  write(vault: string, path: string, contents: string): Promise<void>;
  writeBinary(vault: string, path: string, contents: Uint8Array): Promise<void>;
  mkdir(vault: string, path: string): Promise<void>;
  rename(vault: string, from: string, to: string): Promise<void>;
  trash(vault: string, path: string): Promise<void>;
  onChange(callback: (change: VaultChange) => void): () => void;
}
declare global { interface Window { zorid?: DesktopBridge } }
