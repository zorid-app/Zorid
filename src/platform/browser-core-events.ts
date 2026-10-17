import { BrowserVaultError } from '../core/browser-vault.ts';

/** Once storage committed, notification failure cannot become command rejection. */
export async function afterDurableCommit(intentId: string, receipt: string, notify: () => Promise<void>): Promise<string> {
  try { await notify(); return receipt; }
  catch (error) {
    throw new BrowserVaultError('outcome_unknown', 'Commit succeeded but publication failed; recover the original intent receipt',
      {intent_id:intentId, publication_code:error instanceof BrowserVaultError ? error.code : 'notification_failure'});
  }
}
