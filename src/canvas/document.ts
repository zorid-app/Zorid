export const CANVAS_NODE_TYPES = ['text', 'file', 'link', 'group'] as const;
export type CanvasValue = string | number | boolean | null | readonly CanvasValue[] | { readonly [key: string]: CanvasValue };
export type CanvasPatch = { [key: string]: CanvasValue | undefined };
export interface CanvasNode {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly [key: string]: CanvasValue;
}
export interface CanvasEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly [key: string]: CanvasValue;
}

export class CanvasDocumentError extends Error {
  constructor(message: string) { super(message); this.name = 'CanvasDocumentError'; }
}

type Mapping = { [key: string]: CanvasValue };
const emptyList = Object.freeze([]);

function fail(message: string): never { throw new CanvasDocumentError(message); }

/** Copy only JSON data, without invoking getters/toJSON or assigning prototype setters. */
function copy(value: unknown, ancestors = new Set<object>()): CanvasValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Canvas numbers must be finite');
    return value;
  }
  if (!value || typeof value !== 'object') fail('Canvas values must be JSON data');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('Canvas values must be plain objects or arrays');
  if (ancestors.has(value)) fail('Cyclic Canvas data is not supported');
  if (Object.getOwnPropertySymbols(value).length) fail('Symbol keys are not supported');
  ancestors.add(value);
  try {
    const entries: [string, CanvasValue][] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) fail('Canvas data must have enumerable data properties');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('Named array properties are not supported');
      entries.push([key, copy(descriptor.value, ancestors)]);
    }
    if (array) {
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail('Sparse Canvas arrays are not supported');
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries);
  } finally { ancestors.delete(value); }
}

function mapping(value: unknown, name: string): asserts value is Mapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
}
function stringField(value: Mapping, key: string, required: boolean, nonempty = false): void {
  if (!Object.hasOwn(value, key)) { if (required) fail(`Missing Canvas field: ${key}`); return; }
  if (typeof value[key] !== 'string' || (nonempty && !value[key])) fail(`Canvas ${key} must be ${nonempty ? 'a nonempty' : 'a'} string`);
}

function validate(root: Mapping): void {
  const nodeIds = new Set<string>();
  for (const key of ['nodes', 'edges']) {
    if (Object.hasOwn(root, key) && !Array.isArray(root[key])) fail(`Canvas ${key} must be an array`);
  }
  for (const node of (root.nodes ?? []) as readonly CanvasValue[]) {
    mapping(node, 'Canvas node');
    stringField(node, 'id', true, true); stringField(node, 'type', true, true);
    if (nodeIds.has(node.id as string)) fail(`Duplicate Canvas node id: ${node.id}`);
    nodeIds.add(node.id as string);
    for (const key of ['x', 'y', 'width', 'height']) if (typeof node[key] !== 'number' || !Number.isFinite(node[key])) fail(`Canvas node ${key} must be a finite number`);
    stringField(node, 'color', false);
    if (node.type === 'text') stringField(node, 'text', true);
    if (node.type === 'file') { stringField(node, 'file', true); stringField(node, 'subpath', false); }
    if (node.type === 'link') stringField(node, 'url', true);
    if (node.type === 'group') for (const key of ['label', 'background', 'backgroundStyle']) stringField(node, key, false);
  }
  const edgeIds = new Set<string>();
  for (const edge of (root.edges ?? []) as readonly CanvasValue[]) {
    mapping(edge, 'Canvas edge');
    for (const key of ['id', 'fromNode', 'toNode']) stringField(edge, key, true, true);
    if (edgeIds.has(edge.id as string)) fail(`Duplicate Canvas edge id: ${edge.id}`);
    edgeIds.add(edge.id as string);
    for (const key of ['fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label']) stringField(edge, key, false);
    if (!nodeIds.has(edge.fromNode as string) || !nodeIds.has(edge.toNode as string)) fail(`Dangling Canvas edge: ${edge.id}`);
  }
}

function freeze(value: CanvasValue): CanvasValue {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function patchEntries(patch: CanvasPatch): [string, CanvasValue | undefined][] {
  mapping(patch, 'Canvas patch');
  const prototype = Object.getPrototypeOf(patch);
  if (prototype !== Object.prototype && prototype !== null) fail('Canvas patches must be plain objects');
  if (Object.getOwnPropertySymbols(patch).length) fail('Symbol keys are not supported');
  return Object.getOwnPropertyNames(patch).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) fail('Canvas patches must have enumerable data properties');
    return [key, descriptor.value === undefined ? undefined : copy(descriptor.value)];
  });
}

function set(object: Mapping, key: string, value: CanvasValue | undefined): void {
  if (value === undefined) delete object[key];
  else Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Original lossless-on-read JSON document model; no Canvas renderer or URL/file execution. */
export class CanvasDocument {
  private source: string;
  private root: Mapping;
  private readonly newline: string;
  private readonly indent: string;
  private readonly trailingNewline: boolean;

  private constructor(source: string, root: Mapping) {
    this.source = source; this.root = freeze(root) as Mapping;
    this.newline = source.includes('\r\n') ? '\r\n' : '\n';
    this.indent = /\r?\n([\t ]+)"/.exec(source)?.[1].slice(0, 10) ?? '  ';
    this.trailingNewline = /\r?\n$/.test(source);
  }

  static parse(source: string): CanvasDocument {
    if (typeof source !== 'string') fail('Canvas source must be a string');
    try {
      // Only a truly empty source follows the reference's empty-file path.
      const root = copy(source === '' ? {} : JSON.parse(source));
      mapping(root, 'Canvas document'); validate(root);
      return new CanvasDocument(source, root);
    } catch (error) {
      throw error instanceof CanvasDocumentError ? error : new CanvasDocumentError(`Invalid Canvas JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get nodes(): readonly CanvasNode[] { return (this.root.nodes ?? emptyList) as unknown as readonly CanvasNode[]; }
  get edges(): readonly CanvasEdge[] { return (this.root.edges ?? emptyList) as unknown as readonly CanvasEdge[]; }
  getNode(id: string): CanvasNode | undefined { return this.nodes.find(node => node.id === id); }
  getEdge(id: string): CanvasEdge | undefined { return this.edges.find(edge => edge.id === id); }
  getRoot(key: string): CanvasValue | undefined { return Object.hasOwn(this.root, key) ? this.root[key] : undefined; }
  toString(): string { return this.source; }

  private edit(operation: (root: Mapping) => void): void {
    const next = copy(this.root) as Mapping;
    operation(next); validate(next);
    // No-op edits retain formatting as well as the cached immutable snapshots.
    if (JSON.stringify(next) === JSON.stringify(this.root)) return;
    const source = JSON.stringify(next, null, this.indent).replace(/\n/g, this.newline) + (this.trailingNewline ? this.newline : '');
    this.root = freeze(next) as Mapping; this.source = source;
  }

  private list(root: Mapping, key: 'nodes' | 'edges'): Mapping[] {
    if (!Object.hasOwn(root, key)) set(root, key, []);
    return root[key] as Mapping[];
  }

  private at(list: Mapping[], id: string): Mapping {
    const item = list.find(item => item.id === id);
    if (!item) fail(`Unknown Canvas id: ${id}`);
    return item;
  }

  addNode(node: CanvasNode): void {
    const value = copy(node) as Mapping;
    this.edit(root => this.list(root, 'nodes').push(value));
  }
  addEdge(edge: CanvasEdge): void {
    const value = copy(edge) as Mapping;
    this.edit(root => this.list(root, 'edges').push(value));
  }

  /** Shallow patch. undefined deletes an optional field; use renameNode for node IDs. */
  updateNode(id: string, patch: CanvasPatch): void {
    const entries = patchEntries(patch);
    if (entries.some(([key, value]) => key === 'id' && value !== id)) fail('Use renameNode to change a node id');
    this.edit(root => { const node = this.at(this.list(root, 'nodes'), id); for (const [key, value] of entries) set(node, key, value); });
  }
  updateEdge(id: string, patch: CanvasPatch): void {
    const entries = patchEntries(patch);
    this.edit(root => { const edge = this.at(this.list(root, 'edges'), id); for (const [key, value] of entries) set(edge, key, value); });
  }

  /** Change the node ID and every incoming/outgoing endpoint in one atomic edit. */
  renameNode(id: string, newId: string): void {
    this.edit(root => {
      set(this.at(this.list(root, 'nodes'), id), 'id', newId);
      for (const edge of (root.edges ?? []) as Mapping[]) {
        if (edge.fromNode === id) set(edge, 'fromNode', newId);
        if (edge.toNode === id) set(edge, 'toNode', newId);
      }
    });
  }

  /** Connected nodes require explicit cascading deletion to avoid losing edges accidentally. */
  removeNode(id: string, options: { removeEdges?: boolean } = {}): void {
    this.edit(root => {
      const nodes = this.list(root, 'nodes'); this.at(nodes, id);
      const edges = (root.edges ?? []) as Mapping[];
      const connected = edges.filter(edge => edge.fromNode === id || edge.toNode === id);
      if (connected.length && !options.removeEdges) fail('Node has connected edges; pass removeEdges: true to remove them');
      set(root, 'nodes', nodes.filter(node => node.id !== id));
      if (connected.length) set(root, 'edges', edges.filter(edge => edge.fromNode !== id && edge.toNode !== id));
    });
  }
  removeEdge(id: string): void {
    this.edit(root => { const edges = this.list(root, 'edges'); this.at(edges, id); set(root, 'edges', edges.filter(edge => edge.id !== id)); });
  }

  setRoot(key: string, value: CanvasValue | undefined): void {
    if (typeof key !== 'string') fail('Canvas field names must be strings');
    const next = value === undefined ? undefined : copy(value);
    this.edit(root => set(root, key, next));
  }
}
