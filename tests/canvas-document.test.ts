import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_NODE_TYPES, CanvasDocument, CanvasDocumentError } from '../src/canvas/document.ts';
import type { CanvasNode, CanvasPatch, CanvasValue } from '../src/canvas/document.ts';

const data = {
  pluginRoot: { enabled: true, list: [null, '001', 12] },
  nodes: [
    { id: 'text', type: 'text', x: -2.5, y: 1, width: 200, height: 100, text: '# Hi\n世界', color: '2', pluginNode: { keep: true } },
    { id: 'file', type: 'file', x: 200, y: 2, width: 200, height: 100, file: 'Notes/A.md', subpath: '#^block', color: '#ff00aa' },
    { id: 'link', type: 'link', x: 400, y: 3, width: 200, height: 100, url: 'https://example.test/?a=1#b' },
    { id: 'group', type: 'group', x: -20, y: -20, width: 800, height: 500, label: 'Group', background: 'Images/a.png', backgroundStyle: 'repeat' },
    { id: '__proto__', type: 'plugin-widget', x: 600, y: 4, width: 200, height: 100, arbitrary: ['future', { supported: false }] },
  ],
  edges: [
    { id: 'edge', fromNode: 'text', fromSide: 'right', fromEnd: 'arrow', toNode: 'file', toSide: 'left', toEnd: 'none', label: 'label', color: '6', pluginEdge: { keep: ['yes'] } },
    { id: 'text', fromNode: 'text', toNode: 'text' }, // Separate node/edge ID maps; self-loop and absent sides are retained.
  ],
};
const fixture = JSON.stringify(data, null, '\t').replace(/\n/g, '\r\n') + '\r\n';

test('all node types, edge metadata and unknown fields roundtrip without changing source bytes', () => {
  const document = CanvasDocument.parse(fixture);
  assert.deepEqual(CANVAS_NODE_TYPES, ['text', 'file', 'link', 'group']);
  assert.equal(document.toString(), fixture);
  assert.deepEqual(document.nodes, data.nodes); assert.deepEqual(document.edges, data.edges);
  assert.deepEqual(document.getRoot('pluginRoot'), data.pluginRoot);
  assert.equal(document.getNode('__proto__')?.type, 'plugin-widget');
  assert.equal(document.getNode('missing'), undefined); assert.equal(document.getEdge('missing'), undefined);
});

test('edits preserve unrelated fields and formatting convention without retaining deleted fields', () => {
  const document = CanvasDocument.parse(fixture);
  document.updateNode('text', { text: 'Changed\ntext', x: 1.25, color: undefined });
  document.updateNode('group', { backgroundStyle: 'contain', label: '' });
  document.updateEdge('edge', { label: 'Renamed', fromSide: 'bottom', fromEnd: 'none' });
  const output = document.toString(), result = CanvasDocument.parse(output);
  assert.equal(result.getNode('text')?.text, 'Changed\ntext'); assert.equal(result.getNode('text')?.x, 1.25);
  assert.equal(Object.hasOwn(result.getNode('text')!, 'color'), false);
  assert.deepEqual(result.getNode('text')?.pluginNode, { keep: true });
  assert.deepEqual(result.getNode('file'), data.nodes[1]); assert.deepEqual(result.getNode('link'), data.nodes[2]);
  assert.deepEqual(result.getNode('__proto__'), data.nodes[4]);
  assert.deepEqual(result.getRoot('pluginRoot'), data.pluginRoot);
  assert.deepEqual(result.getEdge('edge')?.pluginEdge, { keep: ['yes'] });
  assert.equal(result.getEdge('edge')?.fromEnd, 'none'); assert.equal(result.getNode('group')?.label, '');
  assert.ok(output.endsWith('\r\n')); assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(output, /\r\n\t"/);
});

test('empty source and missing arrays remain byte exact until first meaningful edit', () => {
  for (const source of ['', '{}', '{"plugin":true}', '{"nodes":[],"edges":[]}']) {
    const document = CanvasDocument.parse(source);
    assert.deepEqual(document.nodes, []); assert.deepEqual(document.edges, []); assert.equal(document.toString(), source);
    document.addNode(data.nodes[0] as CanvasNode);
    assert.equal(CanvasDocument.parse(document.toString()).nodes[0].id, 'text');
  }
});

test('rename updates both endpoints including self-loops, then explicit cascade removes incident edges', () => {
  const document = CanvasDocument.parse(fixture);
  document.renameNode('text', 'renamed');
  assert.equal(document.getNode('text'), undefined); assert.equal(document.getNode('renamed')?.text, '# Hi\n世界');
  assert.equal(document.getEdge('edge')?.fromNode, 'renamed');
  assert.equal(document.getEdge('text')?.fromNode, 'renamed'); assert.equal(document.getEdge('text')?.toNode, 'renamed');
  const before = document.toString();
  assert.throws(() => document.removeNode('renamed'), /connected edges/); assert.equal(document.toString(), before);
  document.removeNode('renamed', { removeEdges: true });
  assert.equal(document.nodes.length, 4); assert.deepEqual(document.edges, []);
  assert.equal(CanvasDocument.parse(document.toString()).nodes.length, 4);
});

test('add, reconnect and remove edges use exact IDs and preserve input isolation', () => {
  const document = CanvasDocument.parse(fixture), node = { ...data.nodes[0], id: 'new', pluginNode: { keep: true } };
  document.addNode(node as CanvasNode); node.pluginNode.keep = false;
  document.addEdge({ id: 'new', fromNode: 'new', toNode: '__proto__', plugin: { a: [1] } });
  document.updateEdge('new', { toNode: 'group' });
  assert.equal(document.getEdge('new')?.toNode, 'group'); assert.deepEqual(document.getNode('new')?.pluginNode, { keep: true });
  document.removeEdge('new'); document.removeNode('new');
  assert.deepEqual(document.nodes, data.nodes); assert.deepEqual(document.edges, data.edges);
});

test('immutable snapshots and semantic no-op edits do not change source or snapshot identity', () => {
  const document = CanvasDocument.parse(fixture), nodes = document.nodes, edges = document.edges;
  assert.ok(Object.isFrozen(nodes)); assert.ok(Object.isFrozen(nodes[0].pluginNode));
  assert.throws(() => { (nodes[0] as { text: string }).text = 'changed'; }, TypeError);
  document.updateNode('text', { text: '# Hi\n世界' }); document.setRoot('missing', undefined); document.renameNode('text', 'text');
  assert.equal(document.nodes, nodes); assert.equal(document.edges, edges); assert.equal(document.toString(), fixture);
  document.updateNode('text', { text: 'new' }); assert.equal(nodes[0].text, '# Hi\n世界');
});

test('malformed JSON/data, duplicate IDs, dangling edges and nonfinite numbers reject explicitly', () => {
  const invalid = [' ', '{', 'null', '[]', 'true', '{"nodes":null}', '{"nodes":{}}', '{"edges":false}', '{"nodes":[null]}', '{"huge":1e400}', '\uFEFF{}'];
  for (const value of [
    { nodes: [{ ...data.nodes[0], id: '' }] }, { nodes: [{ ...data.nodes[0], x: '3' }] },
    { nodes: [{ ...data.nodes[0], text: null }] }, { nodes: [{ ...data.nodes[1], subpath: 1 }] },
    { nodes: [{ ...data.nodes[2], url: null }] }, { nodes: [{ ...data.nodes[3], backgroundStyle: 1 }] },
    { nodes: [data.nodes[0], data.nodes[0]] }, { ...data, edges: [data.edges[0], data.edges[0]] },
    { ...data, edges: [{ id: 'bad', fromNode: 'missing', toNode: 'text' }] },
  ]) invalid.push(JSON.stringify(value));
  for (const source of invalid) assert.throws(() => CanvasDocument.parse(source), CanvasDocumentError, source);
});

test('every failed edit leaves source and published snapshots unchanged', () => {
  const document = CanvasDocument.parse(fixture), nodes = document.nodes, edges = document.edges;
  const operations = [
    () => document.updateNode('missing', { text: 'x' }), () => document.updateNode('text', { id: 'changed' }),
    () => document.updateNode('text', { text: undefined }), () => document.updateNode('text', { x: NaN }),
    () => document.addNode(data.nodes[0] as CanvasNode), () => document.renameNode('text', 'file'),
    () => document.renameNode('text', ''), () => document.removeNode('text'), () => document.removeNode('missing'),
    () => document.addEdge({ id: 'bad', fromNode: 'file', toNode: 'missing' }),
    () => document.updateEdge('edge', { id: 'text' }), () => document.updateEdge('edge', { fromNode: undefined }),
    () => document.removeEdge('missing'), () => document.setRoot('nodes', []), () => document.setRoot('edges', null),
  ];
  for (const operation of operations) {
    assert.throws(operation, CanvasDocumentError); assert.equal(document.toString(), fixture);
    assert.equal(document.nodes, nodes); assert.equal(document.edges, edges);
  }
});

test('prototype-like JSON fields remain data across patches and reparsing', () => {
  const document = CanvasDocument.parse(fixture), before = Object.getOwnPropertyDescriptors(Object.prototype);
  const patch = JSON.parse('{"__proto__":{"keep":true},"constructor":{"prototype":{"polluted":true}},"toJSON":"ordinary"}');
  document.updateNode('text', patch); document.setRoot('__proto__', patch);
  const result = CanvasDocument.parse(document.toString());
  assert.deepEqual(result.getNode('text')?.__proto__, { keep: true });
  assert.deepEqual(result.getRoot('__proto__'), patch); assert.equal(result.getRoot('toString'), undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test('unsafe caller data rejects without executing getters or conversion hooks', () => {
  const document = CanvasDocument.parse(fixture); let calls = 0;
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const sparse = Array(2), named: unknown[] = []; Object.defineProperty(named, '4294967295', { value: 1, enumerable: true });
  const values: unknown[] = [cycle, sparse, named, new Date(), Infinity, 1n, { toJSON() { calls++; return 'bad'; } }, { get value() { calls++; return 1; } }];
  for (const value of values) assert.throws(() => document.setRoot('bad', value as CanvasValue), CanvasDocumentError);
  assert.throws(() => document.updateNode('text', { get text() { calls++; return 'bad'; } } as CanvasPatch), CanvasDocumentError);
  assert.equal(calls, 0); assert.equal(document.toString(), fixture);
});
