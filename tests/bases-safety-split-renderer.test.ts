import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';
import { BaseDocument } from '../src/bases/document.ts';
import { executeBaseQuery } from '../src/bases/query.ts';
import { createBaseTableView } from '../src/bases/table-view.ts';
import { UI } from './bases-electron-integration/ui.mjs';
import { journey } from './bases-electron-safety-integration/campaign.mjs';
import { fixtureFiles } from './bases-electron-safety-integration/fixtures.mjs';
import { selectionSplitReady } from './bases-electron-selection-integration/setup-readiness.mjs';

test('actual Safety table renderer and campaign setup count two records plus header and visible custom-summary footer', async () => {
  const files = fixtureFiles(), base = BaseDocument.parse(files.get('Safety.base')!);
  const result = executeBaseQuery(base, { version: 1, files: [...files].filter(([path]) => path.endsWith('.md')).map(([path, source]) => ({
    path, properties: parse(/^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '') ?? {},
  })) });
  assert.deepEqual(result.rows.map(row => row.path), ['A.md', 'B.md']);
  assert.deepEqual(base.getRoot('summaries'), { Total: 'values.sum()' });
  assert.deepEqual(result.view.summaries, { score: 'Total' });
  const pane = (id: string, active = false) => `<section class="pane${active ? ' is-active' : ''}"><div class="tab is-active" data-tab-id="${id}"></div><div class="bases-session" data-base-controller-version="1" data-base-controller-updating="false" data-base-controller-error="false"><main class="bases-session-content" aria-busy="false"></main></div></section>`;
  const dom = new JSDOM('<body>' + pane('original', true) + pane('clone') + '</body>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const document = dom.window.document, errors: unknown[] = [];
  const views: ReturnType<typeof createBaseTableView>[] = [];
  try {
    for (const host of document.querySelectorAll<HTMLElement>('main')) views.push(createBaseTableView(host, {
      result, openFile() {}, onError: error => errors.push(error),
      // A handwritten presentation fixture for the native Total result. This
      // test exercises the real renderer, not Rust/legacy query-summary parity.
      getSummary: (property, group) => property === 'note.score' && group === null ? { label: 'Total', value: { type: 'number', value: 3 } } : undefined,
    }));
    const grids = [...document.querySelectorAll<HTMLElement>('.zorid-bases-table[role="grid"]')];
    assert.equal(grids.length, 2);
    for (const grid of grids) {
      assert.deepEqual([...grid.querySelectorAll('[role="gridcell"][data-property="file.name"]')].map(cell => cell.getAttribute('data-path')), ['A.md', 'B.md']);
      const footer = grid.querySelector<HTMLElement>('.zorid-bases-table-footer')!;
      assert.equal(footer.hidden, false, 'The real renderer exposes a visible custom Total footer');
      assert.equal(footer.querySelector('.summary-function-name')?.textContent, 'Total');
      assert.equal(footer.querySelector('.summary-function-value')?.textContent, '3');
      assert.equal(grid.querySelectorAll('[role="row"]').length, 4);
      assert.equal(grid.getAttribute('aria-rowcount'), '4', 'Two result records, one column header and one summary are four accessible rows');
    }
    const panes = document.querySelectorAll('.pane');
    panes[0].classList.remove('is-active'); panes[1].classList.add('is-active');
    assert.equal(selectionSplitReady(document, 'original'), false, 'Selection default two rows remains specific to its own fixture');
    assert.equal(selectionSplitReady(document, 'original', 3), false, 'The former Safety precondition incorrectly omitted its visible summary');
    const ready = selectionSplitReady(document, 'original', 4);
    assert.equal(ready.newActiveTabId, 'clone');
    assert.deepEqual(ready.states.map(state => state.rowCount), [4, 4]);
    assert.deepEqual(errors, []);
    // Exercise the actual campaign's setup wiring against the rendered DOM.
    // The driver stops before any note/body input; it is not native split or
    // command execution acceptance. The old hardcoded count3 times out here.
    panes[0].classList.add('is-active'); panes[1].classList.remove('is-active');
    const evidence = { actions: [] as unknown[], limitations: [] as string[] }, opened: string[] = [], stop = new Error('Reached the one admitted A open');
    const ui = new UI({ evaluate: (source: string) => structuredClone(dom.window.eval(source)), async call() { throw Error('No browser input is permitted in this renderer test'); } }, evidence.actions);
    const wait = ui.wait.bind(ui);
    ui.wait = (body: string, label: string) => wait(body, label, 50);
    ui.idle = async () => {};
    ui.command = async (name: string) => { assert.equal(name, 'Split right'); panes[0].classList.remove('is-active'); panes[1].classList.add('is-active'); };
    ui.openFile = async (file: string) => { opened.push(file); if (file === 'A.md') throw stop; assert.equal(file, 'Safety.base'); };
    await assert.rejects(journey({ evidence, ui, async launch() {} }), error => error === stop);
    assert.deepEqual(opened, ['Safety.base', 'A.md']);
    assert.equal(evidence.actions.length, 1);
    assert.deepEqual((evidence.actions[0] as { split: { states: { rowCount: number }[] } }).split.states.map(state => state.rowCount), [4, 4]);
  } finally {
    for (const view of views) view.destroy();
    dom.window.close();
  }
});
