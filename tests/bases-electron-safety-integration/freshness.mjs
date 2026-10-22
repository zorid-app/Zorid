import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {delay} from '../tasks-electron-integration/cdp.mjs';

const digest = source => createHash('sha256').update(source).digest('hex');

// Observe normal native reconciliation. Never call a scanner, adopt a source,
// reload a private buffer, or mutate product state to satisfy this precondition.
export async function waitLogicalSource(c, file, expected, name, {timeout = 45000, pollMs = 100} = {}) {
  assert.equal(typeof expected, 'string');
  assert.ok(timeout > 0 && timeout <= 45000 && pollMs >= 0);
  const receipt = {action: 'safety-logical-source-readiness', name, file, expectedSha256: digest(expected), samples: [], at: Date.now()};
  c.evidence.actions.push(receipt);
  const end = Date.now() + timeout;
  do {
    assert.equal(await c.read(file), expected, 'Physical source stays exactly authored before logical observation');
    const observed = await c.cdp.evaluate(`(async()=>{const vault=await window.zorid.getVault();return {vault:vault.path,source:await window.zorid.read(vault.path,${JSON.stringify(file)})};})()`);
    assert.equal(observed.vault, c.vault, 'Read-only bridge observation belongs to the owned vault');
    assert.equal(typeof observed.source, 'string');
    assert.equal(await c.read(file), expected, 'Physical source stays exactly authored after logical observation');
    receipt.samples.push({at: Date.now(), sha256: digest(observed.source), matches: observed.source === expected});
    if (observed.source === expected) {receipt.readyAt = Date.now(); return receipt;}
    if (Date.now() >= end) break;
    await delay(pollMs);
  } while (Date.now() < end);
  throw new Error('Normal logical source did not match the authored freshness precondition: ' + file);
}

export async function restartWithFreshSource(c, file, expected, name) {
  assert.equal(await c.read(file), expected, 'Authored physical source before normal quit');
  await c.quit(name + '-normal-quit');
  assert.equal(await c.read(file), expected, 'Normal quit preserves authored physical source');
  await c.launch(name + '-normal-restart');
  assert.equal(await c.read(file), expected, 'Normal restart preserves authored physical source');
  await waitLogicalSource(c, file, expected, name);
  await c.saved(file, source => assert.equal(source, expected), name + '-exact-physical-and-logical-source');
}

// The fresh partial-bulk scenario starts only after the normal Base has rendered
// A's newly admitted score. B's intentional conflict has not been created yet.
export function safetyAReady(document) {
  const cells = document.querySelectorAll('.pane.is-active .bases-session [role="gridcell"][data-path="A.md"][data-property="note.score"]');
  if (cells.length !== 1) return false;
  const cell = cells[0], session = cell.closest('.bases-session'), grid = cell.closest('.zorid-bases-table[role="grid"]');
  const content = session?.querySelector('.bases-session-content'), version = session?.getAttribute('data-base-controller-version');
  if (!cell.isConnected || !content?.contains(grid) || grid?.getAttribute('aria-label') !== 'Main' || cell.textContent.trim() !== '7') return false;
  if (!/^(0|[1-9]\d*)$/.test(version ?? '') || grid.getAttribute('data-base-rendered-version') !== version || cell.getAttribute('data-base-widget-version') !== version) return false;
  if (session.getAttribute('data-base-controller-updating') !== 'false' || session.getAttribute('data-base-controller-error') !== 'false' || content.getAttribute('aria-busy') !== 'false') return false;
  if (cell.hasAttribute('data-base-editing') || cell.querySelector('input,[data-base-editing]') || cell.closest('[aria-disabled="true"],[inert]')) return false;
  return {score: 7, controllerVersion: version, renderedVersion: version, widgetVersion: version, observedAt: Date.now()};
}
