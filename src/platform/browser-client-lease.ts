import { BrowserVaultError } from '../core/browser-vault.ts';
import type { CheckpointScope } from '../core/durable-checkpoints.ts';

export interface BrowserClientLease {
  assertActive(): void;
  release(): Promise<void>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const failure = (code: string) => new BrowserVaultError(code, 'Browser consumer ownership is unavailable; retain the original recovery identity');

/** Worker-owned lifetime lock, independent of each short strict IDB transaction.
 * No TTL, lock stealing, sessionStorage alias or automatic alternate client ID.
 * The caller obtains authority from its opened database before calling this.
 */
export async function claimBrowserClient(locks: Pick<LockManager, 'request'> | undefined,
  scope: CheckpointScope, onLost: (error: BrowserVaultError) => void): Promise<BrowserClientLease> {
  if (!locks || typeof locks.request !== 'function') throw failure('client_locks_unavailable');
  if (!uuid(scope.vaultId) || !uuid(scope.clientId)) throw failure('invalid_client_identity');
  const name = `zorid:consumer:v1:${scope.vaultId}:${scope.clientId}`;
  let phase: 'claiming' | 'active' | 'releasing' | 'released' | 'lost' = 'claiming';
  let releaseLock!: () => void;
  const lifetime = new Promise<void>(resolve => { releaseLock = resolve; });
  let admit!: (lease: BrowserClientLease) => void, reject!: (error: unknown) => void;
  const admitted = new Promise<BrowserClientLease>((resolve, failed) => { admit = resolve; reject = failed; });
  let lost: BrowserVaultError | undefined;
  const isLost = () => phase === 'lost';
  const completion = Promise.resolve().then(() => locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw failure('client_already_owned');
    phase = 'active';
    admit(Object.freeze({
      assertActive() { if (phase !== 'active') throw lost ?? failure('client_ownership_lost'); },
      async release() {
        if (phase === 'lost') throw lost;
        if (phase !== 'released') { phase = 'releasing'; releaseLock(); }
        await completion;
        if (lost) throw lost;
      },
    }));
    await lifetime;
    if (!isLost()) phase = 'released';
  })).catch(error => {
    const wasAdmitted = phase !== 'claiming';
    lost = error instanceof BrowserVaultError ? error : failure('client_ownership_lost');
    phase = 'lost'; releaseLock(); reject(lost);
    if (wasAdmitted) onLost(lost);
  });
  return admitted;
}
