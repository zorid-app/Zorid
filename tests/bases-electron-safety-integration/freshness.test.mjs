import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {restartWithFreshSource, waitLogicalSource, safetyAReady} from './freshness.mjs';

const expected = '---\nscore: 7\nuntouched: external-unrelated\n---\nBody 😀 sentinel\n';
function protocol({sources = ['old logical', expected], physical = expected, vault = '/owned/vault', changeOnRead = false} = {}) {
  let disk = physical, index = 0;
  const events = [], evidence = {actions: []};
  const c = {vault: '/owned/vault', evidence,
    async read(file) {events.push(['physical', file]); return disk;},
    async quit(name) {events.push(['quit', name]);},
    async launch(name) {events.push(['launch', name]);},
    cdp: {async evaluate(expression) {
      events.push(['logical']);
      return runInNewContext(expression, {window: {zorid: {
        async getVault() {return {path: vault};},
        async read(path, file) {assert.equal(path, vault); assert.equal(file, 'A.md'); if (changeOnRead) disk = 'Unexpected external write'; return sources[Math.min(index++, sources.length - 1)];},
      }}});
    }},
    async saved(file, check, name) {events.push(['saved', name]); await check(disk); assert.equal(sources[Math.min(index - 1, sources.length - 1)], disk);},
  };
  return {c, events};
}

test('normal quit/relaunch preserves physical source and waits for logical admission before next scenario', async () => {
  const {c, events} = protocol();
  await restartWithFreshSource(c, 'A.md', expected, 'partial'); events.push(['B-conflict-prime']);
  assert.deepEqual(events.filter(e => e[0] !== 'physical'), [['quit', 'partial-normal-quit'], ['launch', 'partial-normal-restart'], ['logical'], ['logical'], ['saved', 'partial-exact-physical-and-logical-source'], ['B-conflict-prime']]);
  const receipt = c.evidence.actions[0]; assert.deepEqual(receipt.samples.map(s => s.matches), [false, true]); assert.ok(receipt.readyAt);
  assert.ok(events.filter(e => e[0] === 'physical').length >= 7);
});

test('stale logical content times out without save, replacement source adoption, or next-scenario input', async () => {
  const {c, events} = protocol({sources: ['old logical']});
  await assert.rejects(waitLogicalSource(c, 'A.md', expected, 'never-current', {timeout: 10, pollMs: 1}), /did not match/);
  assert.ok(c.evidence.actions[0].samples.length); assert.ok(c.evidence.actions[0].samples.every(s => !s.matches));
  assert.ok(!events.some(e => ['saved', 'quit', 'launch'].includes(e[0])));
});

test('physical divergence aborts before restart or immediately after observation rather than being polled away', async () => {
  const before = protocol({physical: 'Unexpected external write'});
  await assert.rejects(restartWithFreshSource(before.c, 'A.md', expected, 'changed'), /before normal quit/);
  assert.deepEqual(before.events, [['physical', 'A.md']]);
  const during = protocol({sources: [expected], changeOnRead: true});
  await assert.rejects(waitLogicalSource(during.c, 'A.md', expected, 'changed-during-read'), /after logical observation/);
  assert.equal(during.events.filter(e => e[0] === 'logical').length, 1);
  assert.equal(during.c.evidence.actions[0].readyAt, undefined);
});

test('bridge observation of another vault fails even when its source matches', async () => {
  const {c, events} = protocol({vault: '/other/vault', sources: [expected]});
  await assert.rejects(waitLogicalSource(c, 'A.md', expected, 'wrong-owner'), /owned vault/);
  assert.equal(events.filter(e => e[0] === 'logical').length, 1);
});

test('visible score7 is insufficient without current matching controller/rendered/widget versions and settled state', () => {
  const dom = new JSDOM('<section class="pane is-active"><div class="bases-session" data-base-controller-version="3" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><div class="zorid-bases-table" role="grid" aria-label="Main" data-base-rendered-version="3"><div role="gridcell" data-path="A.md" data-property="note.score" data-base-widget-version="3">7</div></div></div></div></section>');
  const d = dom.window.document, cell = d.querySelector('[role="gridcell"]'), session = d.querySelector('.bases-session');
  try {
    assert.equal(safetyAReady(d).score, 7);
    cell.textContent = '9'; assert.equal(safetyAReady(d), false); cell.textContent = '7';
    session.dataset.baseControllerUpdating = 'true'; assert.equal(safetyAReady(d), false); session.dataset.baseControllerUpdating = 'false';
    cell.dataset.baseWidgetVersion = '2'; assert.equal(safetyAReady(d), false); cell.dataset.baseWidgetVersion = '3';
    d.querySelector('.bases-session-content').setAttribute('aria-busy', 'true'); assert.equal(safetyAReady(d), false); d.querySelector('.bases-session-content').setAttribute('aria-busy', 'false');
    cell.dataset.baseEditing = 'pending'; assert.equal(safetyAReady(d), false); delete cell.dataset.baseEditing;
    cell.setAttribute('aria-disabled', 'true'); assert.equal(safetyAReady(d), false); cell.removeAttribute('aria-disabled');
    cell.after(cell.cloneNode(true)); assert.equal(safetyAReady(d), false);
  } finally {dom.window.close();}
});
