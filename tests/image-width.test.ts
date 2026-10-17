import test from 'node:test';
import assert from 'node:assert/strict';
import { imageWidthLabel } from '../src/editor/image-width.ts';

test('image width updates and resets only the final dimensions while retaining descriptive aliases', () => {
  for (const [label, expected] of [['', '300'], ['240', '300'], ['240x120', '300'], ['Description', 'Description|300'],
    ['A|B|240', 'A|B|300'], ['A|B| 240 x 120 ', 'A|B|300'], ['240px', '240px|300']]) {
    assert.equal(imageWidthLabel(label, 300), expected);
  }
  for (const [label, expected] of [['', ''], ['240', ''], ['240x120', ''], ['Description', 'Description'],
    ['A|B|240', 'A|B'], ['A|B| 240 x 120 ', 'A|B'], ['240px', '240px']]) {
    assert.equal(imageWidthLabel(label, null), expected);
  }
});

test('source width labels reject nonfinite, fractional, negative and unsafe values', () => {
  for (const width of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(imageWidthLabel('label|200', width), undefined);
  assert.equal(imageWidthLabel('label', 1), 'label|1');
});


test('Markdown reset removes a delimiter escape without leaving an escaped closing bracket', () => {
  assert.equal(imageWidthLabel(String.raw`caption\|240`, null, 'markdown'), 'caption');
  assert.equal(imageWidthLabel(String.raw`caption\\|240`, null, 'markdown'), String.raw`caption\\`);
  assert.equal(imageWidthLabel(String.raw`caption\\\|240`, null, 'markdown'), String.raw`caption\\`);
  assert.equal(imageWidthLabel(String.raw`caption\|240`, 300, 'markdown'), String.raw`caption\|300`);
  assert.equal(imageWidthLabel(String.raw`caption\|part|240`, null, 'markdown'), String.raw`caption\|part`);
});
