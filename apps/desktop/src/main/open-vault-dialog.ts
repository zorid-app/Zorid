import { BrowserWindow } from 'electron';
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import type { VaultProfile } from '@zorid/platform-api';

export interface OpenVaultRuntime {
  openVault(root: string): Promise<VaultProfile>;
}

export type OpenDialog = {
  (options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  (browserWindow: BrowserWindowType, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
};

export interface OpenVaultFromDialogOptions {
  readonly onOpened?: (root: string, profile: VaultProfile) => Promise<void> | void;
}

export async function selectVaultRootFromDialog(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  showOpenDialog: OpenDialog,
): Promise<string | undefined> {
  const options = { properties: ['openDirectory'] } satisfies OpenDialogOptions;
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const result = parentWindow
    ? await showOpenDialog(parentWindow, options)
    : await showOpenDialog(options);

  const selectedRoot = result.filePaths[0];
  if (result.canceled || selectedRoot === undefined) return undefined;
  return selectedRoot;
}

export async function openVaultFromDialog(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  runtime: OpenVaultRuntime,
  showOpenDialog: OpenDialog,
  hooks: OpenVaultFromDialogOptions = {},
): Promise<VaultProfile | undefined> {
  const selectedRoot = await selectVaultRootFromDialog(event, showOpenDialog);
  if (selectedRoot === undefined) return undefined;
  const profile = await runtime.openVault(selectedRoot);
  await hooks.onOpened?.(selectedRoot, profile);
  return profile;
}
