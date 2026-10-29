import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BASE_TABLE_CLIPBOARD_LIMIT, baseTableCellsFromHTML, baseTableClipboardHTML } from '../src/bases/table-clipboard.ts';

function fixture() {
  const dom = new JSDOM('<main></main>', { runScripts: 'dangerously' });
  const doc = dom.window.document;
  const cells = JSON.stringify([[{ type: 'note', data: '\"><img src="https://invalid.test/payload" onerror="window.executed=true">&\n\r\t' },
    { type: 'note', data: null }, { type: 'note', data: [] }, { type: 'note', data: '' },
    { type: 'note', data: false }, { type: 'note', data: -12.5 },
    { type: 'note', data: '2026-10-28T12:34:56.123456789+05:30' },
    { type: 'note', data: ['option-a', 'option-b'] }]]);
  const html = baseTableClipboardHTML(doc, Array(8).fill('<b>Header</b>'), [Array(8).fill('<script>window.executed=true</script>')], cells);
  return { dom, doc, cells, html, close() { dom.window.close(); } };
}

test('HTML transport safely escapes display text and exact typed metadata without adding headers', () => {
  const f = fixture(); try {
    assert.equal(baseTableCellsFromHTML(f.doc, f.html), f.cells);
    const template = f.doc.createElement('template'); template.innerHTML = f.html;
    assert.equal(template.content.querySelectorAll('script,img,b').length, 0);
    assert.equal(template.content.querySelectorAll('thead,th').length, 0);
    assert.equal(template.content.querySelector('td')!.textContent, '<script>window.executed=true</script>');
    assert.equal(f.doc.querySelector('main')!.childNodes.length, 0);
    assert.equal(Reflect.get(f.dom.window, 'executed'), undefined);
  } finally { f.close(); }
});

test('external HTML is parsed only in an inert template and has no own payload', () => {
  const f = fixture(); try {
    assert.equal(baseTableCellsFromHTML(f.doc, '<script>window.executed=true</script><img src="https://invalid.test/x"><table><tr><td>external</td></tr></table>'), undefined);
    assert.equal(Reflect.get(f.dom.window, 'executed'), undefined);
    assert.equal(f.doc.querySelectorAll('script,img,table').length, 0);
  } finally { f.close(); }
});

test('recognized damaged or ambiguous own HTML rejects instead of falling back', () => {
  const f = fixture(); try {
    for (const change of ['duplicate', 'missing-data', 'version', 'tag', 'shape', 'json', 'cell-kind', 'extra-key', 'file-data', 'ragged', 'depth']) {
      const template = f.doc.createElement('template'); template.innerHTML = f.html;
      const table = template.content.querySelector('table')!;
      if (change === 'duplicate') template.content.append(table.cloneNode(true));
      else if (change === 'missing-data') table.removeAttribute('data-zorid-bases-cells');
      else if (change === 'version') table.setAttribute('data-zorid-bases-clipboard', '2');
      else if (change === 'tag') {
        const div = f.doc.createElement('div'); div.setAttribute('data-zorid-bases-clipboard', '1');
        div.setAttribute('data-zorid-bases-cells', f.cells); table.replaceWith(div);
      }
      else if (change === 'shape') table.querySelector('tbody td')!.remove();
      else {
        const raw = JSON.parse(f.cells);
        if (change === 'cell-kind') raw[0][7] = { type: 'unsupported', data: 1 };
        if (change === 'extra-key') raw[0][7] = { type: 'note', data: 1, unexpected: true };
        if (change === 'file-data') raw[0][7] = { type: 'file', data: 1 };
        if (change === 'ragged') raw.push([]);
        if (change === 'depth') { let deep: unknown = 1; for (let i = 0; i < 66; i++) deep = [deep]; raw[0][7] = { type: 'note', data: deep }; }
        table.setAttribute('data-zorid-bases-cells', change === 'json' ? '{' : JSON.stringify(raw));
      }
      assert.throws(() => baseTableCellsFromHTML(f.doc, template.innerHTML), undefined, change);
    }
    assert.throws(() => baseTableCellsFromHTML(f.doc, ' '.repeat(BASE_TABLE_CLIPBOARD_LIMIT + 1)), /too large/);
    assert.throws(() => baseTableClipboardHTML(f.doc, ['Header'], [['one']], f.cells), /Invalid/);
  } finally { f.close(); }
});
