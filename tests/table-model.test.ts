import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTableRow, decodeTableCellText, encodeTableCellText, insertTableRow, parseTable, replaceTableCell,
  type MarkdownTable, type TableEdit,
} from '../src/editor/table-model.ts';

function table(source: string, offset = 0): MarkdownTable {
  const result = parseTable(source, offset);
  assert.ok(result, `Expected a table: ${JSON.stringify(source)}`);
  return result;
}
function apply(source: string, edit: TableEdit): string { return source.slice(0, edit.from) + edit.insert + source.slice(edit.to); }

test('absolute UTF-16 spans preserve cell padding, CRLF and following document', () => {
  const prefix = 'Before 😀\r\n';
  const content = '|  😀A\t| B |\r\n| :--- | ---: |\r\n| x | y |\r\n\r\nAfter';
  const model = table(content, prefix.length);
  assert.deepEqual(model.alignments, ['left', 'right']);
  assert.equal(model.lineEnding, '\r\n');
  assert.equal(model.rows.length, 2);
  const cell = model.rows[0].cells[0], document = prefix + content;
  assert.equal(document.slice(cell.from, cell.to), '😀A');
  assert.equal(document.slice(cell.rawFrom, cell.rawTo), '  😀A\t');
  assert.equal(document.slice(model.from, model.to), model.source);
  assert.equal(apply(document, replaceTableCell(model, 0, 0, 'new')),
    prefix + content.replace('😀A', 'new'));
});

test('optional outer pipes and all four alignments are recognized', () => {
  const model = table('A | B | C | D\n:-- | :-: | --: | --\na | b | c | d');
  assert.deepEqual(model.alignments, ['left', 'center', 'right', null]);
  assert.equal(model.rows[0].leadingPipe, false);
  assert.equal(model.rows[0].trailingPipe, false);
  assert.equal(model.columnCount, 4);
  assert.equal(model.malformed, false);
});

test('delimiter escaping follows slash parity even inside inline code', () => {
  for (let slashes = 0; slashes < 6; slashes++) {
    const value = '`a' + '\\'.repeat(slashes) + '|b`';
    const model = table(`| ${value} | Z |\n| -- | -- |`);
    assert.equal(model.rows[0].actualCellCount, slashes % 2 ? 2 : 3);
    if (slashes % 2) assert.equal(model.rows[0].cells[0].text, value);
  }
});

test('raw border recognition retains whitespace-only cells', () => {
  const model = table('A | B\n-- | --\n | ');
  assert.equal(model.rows[1].actualCellCount, 2);
  assert.deepEqual(model.rows[1].cells.map(cell => cell.text), ['', '']);
  assert.equal(model.rows[1].leadingPipe, false);
  assert.equal(model.rows[1].trailingPipe, false);
  const padded = table('| A | B |  \n| -- | -- |  \n| a | b |  ');
  assert.equal(padded.columnCount, 3);
  assert.equal(padded.malformed, true);
  assert.deepEqual(padded.alignments, [null, null, null]);
});

test('ragged rows retain extra data and insert missing cells without rewriting other bytes', () => {
  const source = '| A | B | C | D |\n| -- | -- | -- | -- |\n| x |\n| a | b | c | d | extra |';
  const model = table(source);
  assert.equal(model.columnCount, 5);
  assert.equal(model.malformed, true);
  assert.equal(model.rows[2].cells[4].text, 'extra');
  assert.equal(model.rows[1].cells[3].virtual, true);
  const next = apply(source, replaceTableCell(model, 1, 3, 'new | value'));
  assert.equal(next, source.replace('| x |\n', '| x |  |  | new \\| value |\n'));
  assert.deepEqual(table(next).rows[1].cells.map(cell => cell.text), ['x', '', '', 'new \\| value', '']);
  assert.equal(table(next).rows[1].actualCellCount, 4);
});

test('missing unbordered cell insertion preserves trailing padding', () => {
  const source = 'A | B | C\n-- | -- | --\nx | y  ';
  const model = table(source);
  const next = apply(source, replaceTableCell(model, 1, 2, 'z'));
  assert.equal(next, source + ' | z');
  assert.deepEqual(table(next).rows[1].cells.map(cell => cell.text), ['x', 'y', 'z']);
});

test('every missing cell preserves insertion bytes for bordered and unbordered ragged rows', () => {
  for (const leading of ['', '| ']) for (const trailing of ['', ' |']) {
    const header = leading + ['A', 'B', 'C', 'D', 'E', 'F'].join(' | ') + trailing;
    const separator = leading + Array(6).fill('--').join(' | ') + trailing;
    const sparse = leading + 'x | y' + trailing;
    const source = `${header}\r\n${separator}\r\n${sparse}`;
    const prefix = 'Before 😀\r\n', model = table(source, prefix.length);
    for (let column = 2; column < 6; column++) {
      const cell = model.rows[1].cells[column];
      const gap = column - 2;
      const expectedPrefix = trailing ? '|  '.repeat(gap) + '| ' : ' | '.repeat(gap + 1);
      const expected = { at: cell.from, prefix: expectedPrefix, suffix: trailing ? ' ' : '' };
      assert.deepEqual({ ...cell.insertion }, expected, 'public insertion properties remain enumerable strings');
      assert.deepEqual(JSON.parse(JSON.stringify(cell.insertion)), expected);
      const edit = replaceTableCell(model, 1, column, '😀|line\nnext');
      assert.equal(edit.insert, expectedPrefix + '😀\\|line<br>next' + expected.suffix);
      const next = apply(prefix + source, edit);
      assert.equal(next.slice(0, edit.from), (prefix + source).slice(0, edit.from));
      assert.equal(next.slice(edit.from + edit.insert.length), (prefix + source).slice(edit.to));
      const changed = table(next.slice(prefix.length));
      assert.equal(changed.rows[1].cells[column].text, '😀\\|line<br>next');
      assert.deepEqual(changed.rows[1].cells.slice(2, column).map(item => item.text), Array(gap).fill(''));
    }
  }
});

test('large sparse tables construct no insertion prefixes until a missing cell is edited', () => {
  const columns = 256, rowCount = 128;
  for (const bordered of [false, true]) {
    const row = (cells: string[]) => (bordered ? '| ' : '') + cells.join(' | ') + (bordered ? ' |' : '');
    const source = [row(Array(columns).fill('H')), row(Array(columns).fill('--')),
      ...Array(rowCount).fill(row(['x', 'y']))].join('\n');
    const repeat = String.prototype.repeat;
    let generatedPrefixCharacters = 0;
    // Count prefix production instead of measuring host-dependent timing or
    // heap size. Restore synchronously before assertions or any other test.
    String.prototype.repeat = function(count: number) {
      const value = String(this);
      if (value === '|  ' || value === ' | ') generatedPrefixCharacters += value.length * count;
      return repeat.call(value, count);
    };
    let model: MarkdownTable, edit: TableEdit, parseCharacters: number;
    try {
      model = table(source);
      parseCharacters = generatedPrefixCharacters;
      edit = replaceTableCell(model, rowCount, columns - 1, 'last');
      // Reading the same public property again must reuse the materialized prefix.
      assert.equal(model.rows[rowCount].cells[columns - 1].insertion!.prefix + 'last'
        + model.rows[rowCount].cells[columns - 1].insertion!.suffix, edit.insert);
    } finally { String.prototype.repeat = repeat; }
    assert.equal(parseCharacters, 0, 'parsing must not produce prefixes for unused virtual cells');
    assert.equal(generatedPrefixCharacters, 3 * (columns - (bordered ? 3 : 2)), 'only the edited gap is expanded once');
    assert.equal(model.rows.length, rowCount + 1);
    assert.equal(model.rows.reduce((count, item) => count + item.cells.filter(cell => cell.virtual).length, 0), rowCount * (columns - 2));
    const next = apply(source, edit);
    const reparsed = table(next);
    assert.equal(reparsed.rows[rowCount].cells[columns - 1].text, 'last');
    assert.equal(reparsed.rows[rowCount].actualCellCount, columns);
    assert.equal(next.slice(0, edit.from), source.slice(0, edit.from));
    assert.equal(next.slice(edit.from + edit.insert.length), source.slice(edit.to));
  }
});

test('cell encoding handles line breaks and pipe parity without a code exemption', () => {
  assert.equal(encodeTableCellText('a\nb\r\nc\rd'), 'a<br>b<br>c\rd');
  assert.equal(encodeTableCellText('`a|b`'), '`a\\|b`');
  for (let count = 0; count < 8; count++) {
    assert.equal(encodeTableCellText('x' + '\\'.repeat(count) + '|'), 'x' + '\\'.repeat(count + (count % 2 ? 0 : 1)) + '|');
  }
});

test('decoder recognizes exact break forms and the observed backtick heuristic', () => {
  assert.equal(decodeTableCellText('a<BR>b<br/>c<br />d').text, 'a\nb<br/>c<br />d');
  assert.equal(decodeTableCellText('`a<br>b`<br>``c<br>d``').text, '`a<br>b`\n``c<br>d``');
  assert.equal(decodeTableCellText('`<br>').text, '`\n');
  assert.equal(decodeTableCellText('\\`a<br>b`').text, '\\`a<br>b`');
  for (let count = 0; count < 8; count++) {
    assert.equal(decodeTableCellText('x' + '\\'.repeat(count) + '|').text, 'x' + '\\'.repeat(count - count % 2) + '|');
  }
});

test('nested-editor cursor maps roundtrip decoded UTF-16 boundaries', () => {
  const raw = '😀a\\|b<BR>c`<br>`', decoded = decodeTableCellText(raw);
  assert.equal(decoded.text, '😀a|b\nc`<br>`');
  for (let offset = 0; offset <= decoded.text.length; offset++) {
    assert.equal(decoded.fromSource(decoded.toSource(offset)), offset);
  }
  const escape = raw.indexOf('\\');
  assert.equal(decoded.fromSource(escape + 1), decoded.fromSource(escape));
  const br = raw.indexOf('<BR>');
  for (let offset = 0; offset < 4; offset++) assert.equal(decoded.fromSource(br + offset), decoded.fromSource(br));
  assert.equal(decoded.toSource(decoded.text.length), raw.length);
  const empty = decodeTableCellText('');
  assert.equal(empty.fromSource(0), 0); assert.equal(empty.toSource(0), 0);
  assert.throws(() => decoded.toSource(-1), RangeError);
  assert.throws(() => decoded.fromSource(raw.length + 1), RangeError);
  assert.throws(() => decoded.toSource(0.5), RangeError);
});

test('append creates reparsable empty rows for all supported border styles', () => {
  for (const source of ['A | B\n-- | --', '| A | B |\n| -- | -- |', 'A | B |\n-- | -- |', '| A | B\n| -- | --']) {
    const model = table(source), next = apply(source, appendTableRow(model));
    assert.equal(next.slice(0, source.length), source);
    const appended = table(next);
    assert.equal(appended.rows.length, 2);
    assert.equal(appended.rows[1].actualCellCount, 2);
    assert.deepEqual(appended.rows[1].cells.map(cell => cell.text), ['', '']);
  }
});

test('insert at first content row moves original header below untouched separator', () => {
  const prefix = 'Before\r\n', source = '| old A\t| old B |\r\n| :--- | ---: |\r\n| body A | body B |\r\nAfter';
  const model = table(source, prefix.length);
  const next = apply(prefix + source, insertTableRow(model, 0, ['new A', 'new B']));
  assert.equal(next, prefix + '| new A | new B |\r\n| :--- | ---: |\r\n| old A\t| old B |\r\n| body A | body B |\r\nAfter');
  const parsed = table(next.slice(prefix.length));
  assert.deepEqual(parsed.rows.map(row => row.cells[0].text), ['new A', 'old A', 'body A']);
  assert.deepEqual(parsed.alignments, ['left', 'right']);
});

test('insert body row and append preserve external newline and encode values', () => {
  const source = '| A | B |\n| -- | -- |\n| x | y |\n\nEnd';
  const model = table(source);
  assert.equal(apply(source, insertTableRow(model, 1, ['a\nb', 'c|d'])),
    '| A | B |\n| -- | -- |\n| a<br>b | c\\|d |\n| x | y |\n\nEnd');
  assert.equal(apply(source, appendTableRow(model, ['last'])),
    '| A | B |\n| -- | -- |\n| x | y |\n| last |  |\n\nEnd');
});

test('recognition stops at ordinary prose and inconsistent raw leading borders', () => {
  assert.equal(table('A | B\n-- | --\nplain text\na | b').rows.length, 1);
  assert.equal(table('| A | B |\n| -- | -- |\n a | b |').rows.length, 1);
  for (const invalid of ['', 'A | B', 'A\n--', 'A | B\n-- | nope', '| A | B |\n-- | --', '    A | B\n-- | --', '| A | B |\n| -- || -- |', '| A | B |\n| -- | |']) {
    assert.equal(parseTable(invalid), null);
  }
  assert.throws(() => parseTable('A | B\n-- | --', -1), RangeError);
});

test('invalid edits fail without mutating model', () => {
  const model = table('A | B\n-- | --'), before = JSON.stringify(model);
  for (const action of [() => replaceTableCell(model, -1, 0, ''), () => replaceTableCell(model, 0, 2, ''),
    () => insertTableRow(model, 2), () => insertTableRow(model, 0.5), () => appendTableRow(model, ['a', 'b', 'c'])]) {
    assert.throws(action, RangeError);
  }
  assert.equal(JSON.stringify(model), before);
});
