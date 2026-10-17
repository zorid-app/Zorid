import type { PlatformVault } from './index.ts';
import { BrowserCoreAdapter } from './browser-core.ts';
import { BrowserCoreRuntime } from './browser-core-runtime.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';

export interface BrowserCoreFixtureConfig {
  database: string; clientId: string; platformId: string; wasmModuleUrl: string; buildId: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Test-build selection only. No ordinary browser-vault data is read or migrated. */
export function browserCoreFixtureConfig(enabled: boolean, url: URL, buildId: string): BrowserCoreFixtureConfig | null {
  if (!enabled) return null;
  const vaults = url.searchParams.getAll('zorid-core-vault'), clients = url.searchParams.getAll('zorid-core-client');
  if (!vaults.length && !clients.length) return null;
  if (!/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(buildId)) throw new BrowserVaultError('missing_fixture_build', 'Core fixture requires its source commit build identity');
  if (vaults.length !== 1 || clients.length !== 1 || !uuid.test(vaults[0]) || !uuid.test(clients[0])) {
    throw new BrowserVaultError('invalid_fixture_identity', 'Core fixture requires one vault UUID and one distinct tab-client UUID');
  }
  const vaultId = vaults[0].toLowerCase(), clientId = clients[0].toLowerCase();
  return {
    database:`zorid-core-vault:app-fixture-${vaultId}`,
    clientId,
    buildId,
    // Same database can be opened by two clients without sharing draft keys.
    platformId:`browser:core-fixture:${vaultId}:client:${clientId}`,
    wasmModuleUrl:new URL('lib/core/zorid_wasm.js',url).href,
  };
}

/** Root startup must invoke this only in its web branch with a build-time gate. */
export async function openBrowserCoreFixture(config: BrowserCoreFixtureConfig): Promise<PlatformVault> {
  const runtime = await BrowserCoreRuntime.open({database:config.database,clientId:config.clientId,
    wasmModuleUrl:config.wasmModuleUrl,allowNewVault:true});
  const marker = document.createElement('meta'); marker.name = 'zorid-core-fixture-build'; marker.content = config.buildId;
  document.head.querySelector('meta[name="zorid-core-fixture-build"]')?.remove(); document.head.append(marker);
  return {adapter:new BrowserCoreAdapter(runtime),label:'Core fixture',id:config.platformId};
}
