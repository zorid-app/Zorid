import type { CheckpointScope } from '../core/durable-checkpoints.ts';
import type { VaultEntry } from '../core/types';
import type { ContextMenuRequest } from './context-menu';

export interface DesktopDurableContext { admissionId: string; scope: CheckpointScope }
export interface DesktopVault { path: string; name: string }
export interface DesktopWindowInfo { id: string; initialState: 'restore' | 'empty' }
export interface VaultChange { vault?: string; type: string; path?: string; message?: string }
export interface DesktopBridge {
  getWindowInfo?(): Promise<DesktopWindowInfo>;
  newWindow?(): Promise<{ id: string }>;
  setMenuHotkeys?(bindings: { id: 'new-window' | 'close-tab'; shortcut: string }[]): Promise<void>;
  onCommand?(callback: (id: 'close-tab') => void): () => void;
  compareAndWrite?(vault: string, path: string, expectedContent: string, contents: string): Promise<void>;
  showContextMenu?(request: ContextMenuRequest): Promise<string | null>;
  dismissContextMenu?(): Promise<void>;
  getPathForFile?(file: File): string;
  getVault(): Promise<DesktopVault | null>;
  getDurableContext?(vault: string): Promise<DesktopDurableContext | null>;
  durableInvoke?(vault: string, admissionId: string, method: string, args: readonly unknown[]): Promise<unknown>;
  releaseDurableContext?(vault: string, admissionId: string): Promise<void>;
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
  remove?(vault: string, path: string, force: boolean): Promise<void>;
  onChange(callback: (change: VaultChange) => void): () => void;
}
declare global { interface Window { zorid?: DesktopBridge } }
