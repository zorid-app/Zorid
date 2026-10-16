import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTableRow, decodeTableCellText, deleteTableColumn, deleteTableRow, duplicateTableColumn, duplicateTableRow,
  encodeTableCellText, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, parseTable, replaceTableCell,
  setTableColumnAlignment, sortTableRows,
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

test('column insertion retains existing raw cell text, alignment and surrounding document bytes', () => {
  const prefix = 'Before 😀\r\n', source = '|  A\t| B |\r\n| :---\t| ---: |\r\n| x\\|y | `<br>` |\r\n\r\nAfter';
  const model = table(source, prefix.length);
  const next = apply(prefix + source, insertTableColumn(model, 1, ['New', 'a|b\nc'], 'center'));
  assert.equal(next, prefix + '|  A\t| New | B |\r\n| :---\t| :---: | ---: |\r\n| x\\|y | a\\|b<br>c | `<br>` |\r\n\r\nAfter');
  assert.deepEqual(table(next.slice(prefix.length)).alignments, ['left', 'center', 'right']);
});

test('empty columns can be inserted at every position for supported border styles', () => {
  for (const source of ['A | B\n-- | --\nx | y', '| A | B |\n| -- | -- |\n| x | y |',
    'A | B |\n-- | -- |\nx | y |', '| A | B\n| -- | --\n| x | y']) {
    for (let index = 0; index <= 2; index++) {
      const next = table(apply(source, insertTableColumn(table(source), index)));
      assert.equal(next.columnCount, 3); assert.equal(next.malformed, false);
      assert.deepEqual(next.rows[0].cells.map(cell => cell.text), index === 0 ? ['', 'A', 'B'] : index === 1 ? ['A', '', 'B'] : ['A', 'B', '']);
      assert.deepEqual(next.rows[1].cells.map(cell => cell.text), index === 0 ? ['', 'x', 'y'] : index === 1 ? ['x', '', 'y'] : ['x', 'y', '']);
    }
  }
});

test('inserting a column materializes ragged gaps without dropping extra cell contents', () => {
  const source = '| A | B |\n| -- | -- |\n| x |\n| one | two | extra |';
  const next = table(apply(source, insertTableColumn(table(source), 3)));
  assert.equal(next.columnCount, 4); assert.equal(next.malformed, false);
  assert.deepEqual(next.rows.map(row => row.cells.map(cell => cell.text)), [
    ['A', 'B', '', ''], ['x', '', '', ''], ['one', 'two', 'extra', ''],
  ]);
});

test('column insertion keeps mixed line endings and separator trailing padding', () => {
  const source = '| A | B |\r\n| -- | -- |  \n| x | y |';
  const next = apply(source, insertTableColumn(table(source), 2));
  assert.equal(next, '| A | B |  |\r\n| -- | -- | --- |  \n| x | y |  |');
});

test('invalid column edits fail atomically without mutating the input model', () => {
  const model = table('| A | B |\n| --- | --- |'), before = JSON.stringify(model);
  for (const index of [-1, 3, 0.5, NaN]) assert.throws(() => insertTableColumn(model, index), RangeError);
  assert.throws(() => insertTableColumn(model, 0, ['header', 'extra']), RangeError);
  assert.equal(JSON.stringify(model), before);
});

test('row movement and duplication preserve encoded cells and permit moving the header', () => {
  const source = '| Header | Value |\r\n| :--- | ---: |\r\n| a\\|b | `<br>` |\r\n| last | 2 |';
  const model = table(source);
  const moved = table(apply(source, moveTableRow(model, 1, 0)));
  assert.deepEqual(moved.rows.map(row => row.cells.map(cell => cell.text)), [['a\\|b', '`<br>`'], ['Header', 'Value'], ['last', '2']]);
  assert.deepEqual(moved.alignments, ['left', 'right']);
  assert.equal(moved.lineEnding, '\r\n');
  const copied = table(apply(source, duplicateTableRow(model, 1)));
  assert.equal(copied.rows.length, 4);
  assert.equal(copied.rows[1].source, model.rows[1].source);
  assert.equal(copied.rows[2].source, model.rows[1].source);
});

test('row deletion promotes the next header and removes a table when no content row remains', () => {
  const source = '| Header | Value |\n| --- | ---: |\n| next | 1 |\n\nAfter';
  const next = apply(source, deleteTableRow(table(source), 0));
  assert.equal(next, '| next | 1 |\n| --- | ---: |\n\nAfter');
  assert.equal(apply(next, deleteTableRow(table(next), 0)), '\n\nAfter');
});

test('column movement, duplication and deletion carry alignments and original encoded data', () => {
  const source = '| A | B | C |\n| :--- | :---: | ---: |\n| a\\|b | line<br>two | z |';
  const model = table(source);
  const moved = table(apply(source, moveTableColumn(model, 0, 2)));
  assert.deepEqual(moved.alignments, ['center', 'right', 'left']);
  assert.deepEqual(moved.rows[1].cells.map(cell => cell.text), ['line<br>two', 'z', 'a\\|b']);
  const copied = table(apply(source, duplicateTableColumn(model, 0)));
  assert.deepEqual(copied.alignments, ['left', 'left', 'center', 'right']);
  assert.deepEqual(copied.rows[1].cells.map(cell => cell.text), ['a\\|b', 'a\\|b', 'line<br>two', 'z']);
  const deleted = table(apply(source, deleteTableColumn(model, 1)));
  assert.deepEqual(deleted.alignments, ['left', 'right']);
  assert.deepEqual(deleted.rows[1].cells.map(cell => cell.text), ['a\\|b', 'z']);
});

test('deleting down to one unbordered column produces a valid bordered table, then removes it', () => {
  const prefix = 'Before\n\n', source = 'A | B\n--- | ---\na | b', suffix = '\n\nAfter';
  const remaining = apply(prefix + source + suffix, deleteTableColumn(table(source, prefix.length), 0));
  const model = table(remaining.slice(prefix.length), prefix.length);
  assert.equal(model.columnCount, 1);
  assert.deepEqual(model.rows.map(row => row.cells[0].text), ['B', 'b']);
  assert.equal(apply(remaining, deleteTableColumn(model, 0)), prefix + suffix);
});

test('alignment changes only syntax, retaining escaped source content and padding', () => {
  const source = '| A | B |\n| --- | ---: |\n| x\\|y | z |';
  for (const [alignment, marker] of [['left', ':---'], ['center', ':---:'], ['right', '---:'], [null, '---']] as const) {
    const next = apply(source, setTableColumnAlignment(table(source), 0, alignment));
    assert.equal(next, source.replace('| --- |', `| ${marker} |`));
  }
});

test('column sorting retains the header, uses natural case-insensitive ordering and stable ties', () => {
  const source = '| Header | Id |\n| --- | --- |\n| **Item 10** | a |\n| Item 2 | b |\n| item 2 | c |\n| Item 1 | d |';
  const model = table(source), rendered = ['Header', 'Item 10', 'Item 2', 'item 2', 'Item 1'];
  const ascending = table(apply(source, sortTableRows(model, 0, 'ascending', rendered)));
  assert.deepEqual(ascending.rows.map(row => row.cells[1].text), ['Id', 'd', 'b', 'c', 'a']);
  const descending = table(apply(source, sortTableRows(model, 0, 'descending', rendered)));
  assert.deepEqual(descending.rows.map(row => row.cells[1].text), ['Id', 'a', 'b', 'c', 'd']);
  assert.equal(descending.rows[1].cells[0].text, '**Item 10**');
});

test('structural operations reject invalid indices and sort keys without mutating the model', () => {
  const model = table('| A | B |\n| --- | --- |'), original = JSON.stringify(model);
  for (const action of [() => deleteTableRow(model, -1), () => duplicateTableRow(model, 1),
    () => moveTableRow(model, 0, 1), () => deleteTableColumn(model, 2), () => duplicateTableColumn(model, NaN),
    () => moveTableColumn(model, 0, -1), () => setTableColumnAlignment(model, 0.5, 'left'),
    () => sortTableRows(model, 0, 'ascending', [])]) assert.throws(action, RangeError);
  assert.equal(JSON.stringify(model), original);
});

test('structural delimiters preserve terminal backslashes in unbordered header and body cells', () => {
  for (let count = 1; count <= 5; count++) for (const leading of ['', '|']) {
    const slashes = '\\'.repeat(count), header = 'B' + slashes, tail = 'tail' + slashes;
    const source = `${leading}A | ${header}\n${leading}--- | ---\n${leading}x | ${tail}\n${leading}other | end`;
    const model = table(source), initial = [['A', header], ['x', tail], ['other', 'end']];
    const cases: [TableEdit, string[][]][] = [
      [moveTableColumn(model, 1, 0), initial.map(([a, b]) => [b, a])],
      [duplicateTableColumn(model, 1), initial.map(([a, b]) => [a, b, b])],
      [deleteTableColumn(model, 0), initial.map(([, b]) => [b])],
      [moveTableRow(model, 1, 0), [initial[1], initial[0], initial[2]]],
      [duplicateTableRow(model, 1), [initial[0], initial[1], initial[1], initial[2]]],
      [deleteTableRow(model, 2), initial.slice(0, 2)],
      [setTableColumnAlignment(model, 1, 'center'), initial],
      [sortTableRows(model, 0, 'ascending', ['header', 'z', 'a']), [initial[0], initial[2], initial[1]]],
      [insertTableColumn(model, 2), initial.map(([a, b]) => [a, b, ''])],
    ];
    for (const [edit, expected] of cases) {
      const next = table(apply(source, edit));
      assert.equal(next.malformed, false);
      assert.deepEqual(next.rows.map(row => row.cells.map(cell => cell.text)), expected);
    }
  }
});

test('raw-cell serialization retains whitespace-only cells when adding or rearranging delimiters', () => {
  const source = 'A | \n--- | ---\nx | ', model = table(source);
  for (const [edit, expected] of [
    [moveTableColumn(model, 1, 0), [['', 'A'], ['', 'x']]],
    [duplicateTableColumn(model, 1), [['A', '', ''], ['x', '', '']]],
    [insertTableColumn(model, 2), [['A', '', ''], ['x', '', '']]],
  ] as [TableEdit, string[][]][]) {
    assert.deepEqual(table(apply(source, edit)).rows.map(row => row.cells.map(cell => cell.text)), expected);
  }
});
