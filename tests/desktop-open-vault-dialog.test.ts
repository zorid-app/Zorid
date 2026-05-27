import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import type { VaultProfile } from '../packages/platform-api/src/index';

const electronMock = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
}));

describe('desktop open vault dialog flow', () => {
  it('parents the folder chooser to the invoking BrowserWindow and opens the selected folder', async () => {
    const { openVaultFromDialog } = await import('../apps/desktop/src/main/open-vault-dialog');
    const sender = {} as WebContents;
    const parent = {} as BrowserWindow;
    const profile: VaultProfile = { id: 'folder:abc', kind: 'folder', rootLabel: 'Vault' };
    const openVault = vi.fn(async () => profile);
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/Vault'] }));
    electronMock.fromWebContents.mockReturnValue(parent);

    await expect(openVaultFromDialog({ sender }, { openVault }, showOpenDialog)).resolves.toBe(profile);

    expect(electronMock.fromWebContents).toHaveBeenCalledWith(sender);
    expect(showOpenDialog).toHaveBeenCalledWith(parent, { properties: ['openDirectory'] });
    expect(openVault).toHaveBeenCalledWith('/tmp/Vault');
  });

  it('does not mutate the active vault when the chooser is canceled', async () => {
    const { openVaultFromDialog } = await import('../apps/desktop/src/main/open-vault-dialog');
    const openVault = vi.fn();
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    electronMock.fromWebContents.mockReturnValue(undefined);

    await expect(openVaultFromDialog({ sender: {} as WebContents }, { openVault }, showOpenDialog)).resolves.toBeUndefined();

    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] });
    expect(openVault).not.toHaveBeenCalled();
  });
});
