import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { Text, Binary, SquareCheck, Calendar, CalendarClock, List, Tags, Link, CodeXml, ListFilter, CircleDot, Star, Calculator, Trash2, Search, File, ArrowUpRight, Plus } from 'lucide';
import type { IconNode } from 'lucide';
import { BASE_TABLE_CLIPBOARD_LIMIT, baseTableClipboardHTML, baseTableCellsFromHTML, parseBaseTableTSV } from './table-clipboard.ts';
import type { BaseViewPatch, BaseValue } from './document.ts';
import { baseViewSource } from './document.ts';
import type { BasePropertyPresentation } from './presentation-common.ts';
import type { BasePropertyEditorCompletionIntent } from './property-widgets.ts';
import { basePropertyPopoverOwner } from './property-widgets.ts';
import { displaySharedBaseValue, groupIdentity } from './presentation-common.ts';
import { BASE_NULL, baseValueToString, baseExpressionValue } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryResult, BaseQueryRow } from './query.ts';

export interface BaseTableEdit {
  readonly version: BaseQueryResult['version'];
  readonly path: string;
  readonly property: string;
  readonly value: BaseExpressionValue;
}
export interface BaseTableFileWitness { readonly entryId: string; readonly revision: string }
export interface BaseTableRename { readonly version: BaseQueryResult['version']; readonly path: string; readonly name: string; readonly witness?: BaseTableFileWitness }
export interface BaseTableCreatedItem { readonly path: string; readonly entryId?: string }
export interface BaseTableConfigurationAcknowledgement { readonly result: BaseQueryResult; readonly entryId?: string }
export interface BaseTableOptions {
  readonly result: BaseQueryResult;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent, witness?: BaseTableFileWitness) => void;
  /** Rename this captured file identity; hosts must reject reused paths. */
  readonly renameFile?: (edit: BaseTableRename) => Promise<{ readonly path: string } | void>;
  readonly requestAddProperty?: (anchor: HTMLElement) => void;
  /** Resolve after publishing the created row; return no row when the host opens
   * another editor (for example, when filters hide the new item). */
  readonly onNew?: (anchor: HTMLElement) => Promise<BaseTableCreatedItem | void>;
  /** Host must revalidate version/path/property and publish a new result after saving. */
  readonly editProperty?: (edit: BaseTableEdit) => Promise<void>;
  /** Live admission for new cell/bulk edits; header resize has its own queue. */
  readonly canBeginPropertyEdit?: () => boolean;
  /** Host readiness excluding this table's own retained draft. Only the owning
   * failed checkbox may use this to retry; other edits still use full admission. */
  readonly canRetryPropertyEdit?: () => boolean;
  readonly getPropertyType?: (property: string) => string | undefined;
  readonly getPropertyLabel?: (property: string) => string;
  readonly onError?: (error: unknown) => void;
  readonly editProperties?: (edits: readonly BaseTableEdit[]) => Promise<void>;
  readonly isPropertyEditable?: (property: string, row: BaseQueryRow) => boolean;
  readonly validatePropertyValue?: (value: BaseExpressionValue, property: string, row: BaseQueryRow) => BaseExpressionValue;
  /** Raw persisted property from this row's captured witness, never its formatted presentation. */
  readonly getEditableValue?: (row: BaseQueryRow, property: string) => BaseExpressionValue | undefined;
  readonly parsePropertyInput?: (raw: string, property: string, row: BaseQueryRow) => BaseExpressionValue;
  readonly renderProperty?: (element: HTMLElement, property: BasePropertyPresentation) => void | (() => void);
  readonly patchView?: (patch: BaseViewPatch) => Promise<void>;
  /** Publish the acknowledged result through update after a configuration save.
   * Hosts may do so synchronously here; queued resize intents otherwise wait for
   * their next update. Return the published result and Base entry identity to
   * acknowledge a successful no-op save that reused the same result object. */
  readonly onConfigurationSettled?: () => BaseTableConfigurationAcknowledgement | void;
  /** Stable host-owned Base entry identity; undefined permits direct resizing
   * but rejects additional pending input. Omitted legacy hosts use view scope. */
  readonly getConfigurationIdentity?: () => string | undefined;
  readonly isConfigurationClosing?: () => boolean;
  readonly deleteFiles?: (rows: readonly BaseQueryRow[]) => Promise<void>;
  readonly contextMenu?: (row: BaseQueryRow, event: MouseEvent, witness?: BaseTableFileWitness) => void;
  readonly hoverFile?: (row: BaseQueryRow, event: MouseEvent) => void;
  readonly dragFile?: (row: BaseQueryRow, event: DragEvent) => void;
  readonly requestEditProperty?: (property: string, anchor: HTMLElement) => void;
  readonly propertyTypes?: readonly { id: string; label: string }[];
  readonly requestPropertyType?: (property: string, type: string) => void | Promise<void>;
  readonly summaryOptions?: readonly { id: string; label: string; preview?: BaseExpressionValue }[];
  readonly getSummaryOptions?: (property: string, groupIndex: number | null) => Promise<readonly { id: string; label: string; preview?: BaseExpressionValue }[]>;
  readonly requestAddSummary?: (property: string, anchor: HTMLElement, name?: string) => void;
  readonly requestEditSummary?: (property: string, id: string, anchor: HTMLElement, groupIndex?: number | null) => void;
  readonly requestHideSummary?: (property: string) => void | Promise<void>;
  readonly requestSummary?: (property: string, id: string) => void | Promise<void>;
  readonly undo?: () => void | Promise<void>;
  readonly redo?: () => void | Promise<void>;
  /** Precomputed Rust summary; null selects the overall scope. Never aggregate DOM rows. */
  readonly getSummary?: (property: string, groupIndex: number | null) => { value: BaseExpressionValue; label?: string } | undefined;
  readonly onEditStateChange?: (active: boolean) => void;
}
/** Raw editor state is RAM custody only, never a captured rename/edit command. */
export interface BaseTableRawDraft {
  readonly kind:'title'|'property';
  readonly target:{readonly entryId:string;readonly path:string;readonly revision:string;readonly property:string};
  readonly baseline:string;
  readonly state:{value:string;checked:boolean;focus:boolean;selectionStart:number|null;selectionEnd:number|null;selectionDirection:'forward'|'backward'|'none'|null};
  readonly ready:Promise<void>;
}
export interface BaseTableView { canCaptureRawDraft():boolean; captureRawDraft():BaseTableRawDraft|undefined; restoreRawDraft(draft:BaseTableRawDraft):'restored'|'pending'|'conflict'; rawPropertyElement(entryId:string,path:string,property:string):HTMLElement|undefined; editFileTitle(path: string, entryId: string): boolean; completePropertyEdit(element: HTMLElement, presentation: BasePropertyPresentation, intent: BasePropertyEditorCompletionIntent): void; openSummaryPicker(property: string, anchor: HTMLElement, groupIndex?: number | null): void; update(result: BaseQueryResult): void; refreshLayout(): void; hasActiveEdits(): boolean; hasQueuedConfiguration(): boolean; dismissCleanPanels(): void; destroy(): void }
type Item = { row: BaseQueryRow; groupIndex: number; rowIndex: number; group?: never; summary?: never } | { group: number; row?: never; summary?: never } | { summary: number | null; row?: never; group?: never };
type TableMenuEntry = { label: string; action?: () => void; disabled?: boolean; checked?: boolean; submenu?: readonly TableMenuEntry[] };
type CellPoint = { group: number; row: number; column: number };
type CellRange = { group: number; top: number; bottom: number; start: number; end: number };
function printableEditKey(event: KeyboardEvent): boolean {
  return !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && Array.from(event.key).length === 1 && !(event.key === ' ' && event.shiftKey);
}
function cellBounds(a: CellPoint, b = a): CellRange {
  return { group: a.group, top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), start: Math.min(a.column, b.column), end: Math.max(a.column, b.column) };
}
function extendRange(previous: CellRange | undefined, active: CellPoint, target: CellPoint): CellRange {
  const current = previous ?? cellBounds(active);
  const edge = (low: number, high: number, from: number, to: number): [number, number] => {
    // Move the active boundary inward, retaining the opposite edge; otherwise expand.
    if (to >= low && to <= high) {
      if (from === low && to > from) return [to, high];
      if (from === high && to < from) return [low, to];
    }
    return [Math.min(low, to), Math.max(high, to)];
  };
  const [top, bottom] = edge(current.top, current.bottom, active.row, target.row);
  const [start, end] = edge(current.start, current.end, active.column, target.column);
  return { group: current.group, top, bottom, start, end };
}
function tableClipboard(header: string[], rows: string[][]): Record<string, string> {
  const quote = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const escaped = [header, ...rows].map(row => row.map(value => value.replace(/\|/g, '\\|')));
  const widths = header.map((_, index) => escaped.reduce((width, row) => Math.max(width, row[index].length), 0) + 2);
  const markdownRow = (row: string[]) => '|' + row.map((value, i) => {
    const padding = widths[i] - value.length, left = Math.floor(padding / 2);
    return ' '.repeat(left) + value + ' '.repeat(padding - left);
  }).join('|') + '|';
  return {
    'text/plain': rows.map(row => row.map(quote).join('\t')).join('\n'),
    'text/markdown': [markdownRow(escaped[0]), '|' + widths.map(width => ' ' + '-'.repeat(width - 2) + ' ').join('|') + '|', ...escaped.slice(1).map(markdownRow)].join('\n'),
    'obsidian/table': JSON.stringify({ header, rows, alignment: header.map(() => null) }),
  };
}
const primitiveTypes = new Set(['null', 'string', 'number', 'boolean']);
function sameConfigurationValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && sameConfigurationValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function publishedConfigurationMatches(view: BaseQueryResult['view'], patch: BaseViewPatch): boolean {
  return Object.entries(patch).every(([key, expected]) => sameConfigurationValue(key === 'columnSize' ? view[key] ?? {} : view[key], key === 'columnSize' ? expected ?? {} : expected));
}
function collapseContext(snapshot: BaseQueryResult, entryId: string | undefined) {
  const view = snapshot.view, grouping = view.groupBy;
  const groupBy = grouping && typeof grouping === 'object' && !Array.isArray(grouping)
    ? Object.fromEntries(Object.entries(grouping).filter(([key]) => key !== 'direction')) : grouping;
  const property = groupBy && typeof groupBy === 'object' && !Array.isArray(groupBy) ? groupBy.property : undefined;
  // Group order, sorting and query revisions do not change a group's meaning.
  // Only exposed configuration belongs here; no hidden formula state is inferred.
  return structuredClone({ entryId, view: typeof view.id === 'string' ? { id: view.id } : { name: view.name }, type: view.type,
    source: baseViewSource(view), groupBy, formulas: typeof property === 'string' && property.startsWith('formula.') ? view.formulas : undefined });
}
function display(value: BaseExpressionValue, shared = false): string {
  if (value.type === 'null') return '';
  if (value.type === 'namespace') return value.name;
  try { return shared ? displaySharedBaseValue(value) : baseValueToString(value); }
  catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}

/** Original Table presentation. Query evaluation and all mutations belong to the host. */
export function createBaseTableView(container: HTMLElement, options: BaseTableOptions): BaseTableView {
  const doc = container.ownerDocument, win = doc.defaultView;
  const root = doc.createElement('div'), header = doc.createElement('div'), body = doc.createElement('div'), footer = doc.createElement('div');
  const newRow = doc.createElement('div'), newCell = doc.createElement('div'), newButton = doc.createElement('button');
  const status = doc.createElement('div');
  root.className = 'zorid-bases-table'; root.setAttribute('role', 'grid'); root.setAttribute('aria-multiselectable', 'true'); root.setAttribute('aria-label', options.result.view.name);
  header.className = 'zorid-bases-table-header'; header.setAttribute('role', 'row');
  body.className = 'zorid-bases-table-body'; body.setAttribute('role', 'rowgroup');
  status.className = 'zorid-bases-table-status'; status.setAttribute('role', 'status');
  footer.className = 'zorid-bases-table-footer zorid-bases-table-summary'; footer.setAttribute('role', 'row');
  newRow.className = 'zorid-bases-table-new-row'; newRow.setAttribute('role', 'row'); newRow.hidden = !options.onNew;
  newCell.setAttribute('role', 'gridcell'); newButton.type = 'button'; newButton.className = 'zorid-bases-table-new'; newButton.append(svgIcon(Plus), doc.createTextNode('New page')); newCell.append(newButton); newRow.append(newCell);
  root.append(header, body, ...(options.onNew ? [newRow] : []), footer); container.append(root, status);
  let result = options.result, items: Item[] = [], rowHeight = 30, template = '';
  let destroyed = false, initialized = false, revision = 0, frame: number | undefined;
  let selection: { path: string; property: string; point?: CellPoint } | undefined;
  let range: CellRange | undefined, anchor: CellPoint | undefined;
  let stopDrag: (() => void) | undefined;
  let suppressClick = false;
  let editing: HTMLElement | undefined;
  let stopRename: (() => void) | undefined;
  let rawEditor:{canCapture():boolean;capture():BaseTableRawDraft|undefined;restore(draft:BaseTableRawDraft):void}|undefined;
  function rawControl(input:HTMLInputElement|HTMLTextAreaElement,cell:HTMLElement,row:BaseQueryRow,property:string,kind:BaseTableRawDraft['kind'],baseline:string,available:()=>boolean):{frozen:()=>boolean;blocked:()=>boolean;interact:()=>void;editor:NonNullable<typeof rawEditor>}{
    let frozen=false,restoredPassive=false,composing=false,captured:BaseTableRawDraft|undefined,complete:(()=>void)|undefined;
    const snapshot=()=>({value:input.value,checked:'checked'in input&&input.checked,focus:doc.activeElement===input,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,selectionDirection:input.selectionDirection});
    const finishComposition=()=>{if(!captured)return;const focus=captured.state.focus;Object.assign(captured.state,snapshot(),{focus});input.readOnly=true;complete?.();complete=undefined;};
    input.addEventListener('input',()=>{if(!frozen)restoredPassive=false;});
    input.addEventListener('pointerdown',()=>{if(!frozen)restoredPassive=false;});
    input.addEventListener('compositionstart',()=>{if(!frozen){restoredPassive=false;composing=true;}});
    input.addEventListener('compositionend',()=>{composing=false;if(captured)setTimeout(finishComposition,0);});
    const editor={canCapture:()=>!destroyed&&editing===cell&&available()&&!!row.entryId&&!!row.revision,
      capture:()=>{if(captured)return captured;if(!editor.canCapture())return;frozen=true;let resolve!:()=>void;const ready=new Promise<void>(yes=>{resolve=yes;});complete=resolve;
        captured={kind,target:{entryId:row.entryId!,path:row.path,revision:row.revision!,property},baseline,state:snapshot(),ready};if(!composing){input.readOnly=true;resolve();complete=undefined;}return captured;},
      restore:(draft:BaseTableRawDraft)=>{restoredPassive=true;input.value=draft.state.value;if('checked'in input)input.checked=draft.state.checked;
        if(draft.state.focus)input.focus({preventScroll:true});if(input.type!=='checkbox'&&draft.state.selectionStart!==null&&draft.state.selectionEnd!==null)input.setSelectionRange(draft.state.selectionStart,draft.state.selectionEnd,draft.state.selectionDirection??undefined);}};
    rawEditor=editor;return{frozen:()=>frozen,blocked:()=>frozen||restoredPassive,interact:()=>{if(!frozen)restoredPassive=false;},editor};
  }
  function rawPropertyElement(entryId:string,path:string,property:string):HTMLElement|undefined {
    if(destroyed||hasActiveEdits()||!result.properties.includes(property))return;
    const group=result.groups.findIndex(group=>group.rows.some(row=>row.entryId===entryId&&row.path===path));if(group<0)return;
    if(collapsed.delete(groupIdentity(result.groups[group])))rebuildItems();
    const item=items.find(item=>item.row?.entryId===entryId&&item.row.path===path);if(!item?.row)return;
    const point={group:item.groupIndex,row:item.rowIndex,column:result.properties.indexOf(property)};range=undefined;anchor=undefined;focusCell(path,property,point);
    return [...body.querySelectorAll<HTMLElement>('[role="gridcell"][data-path]')].find(cell=>cell.dataset.group===String(point.group)&&cell.dataset.row===String(point.row)&&cell.dataset.property===property);
  }
  function restoreRawDraft(draft:BaseTableRawDraft):'restored'|'pending'|'conflict' {
    if(destroyed||hasActiveEdits())return'pending';
    const row=result.rows.find(row=>row.entryId===draft.target.entryId&&row.path===draft.target.path);
    if(!row||!row.revision||!result.properties.includes(draft.target.property))return'conflict';
    const baseline=draft.kind==='title'?row.path.split('/').at(-1)!.replace(/\.md$/i,''):JSON.stringify(options.getEditableValue?.(row,draft.target.property)??row.values[draft.target.property]??BASE_NULL);
    if(baseline!==draft.baseline)return'conflict';
    const cell=rawPropertyElement(row.entryId!,row.path,draft.target.property);if(!cell)return'pending';
    if(draft.kind==='title')startRename(cell,row,draft.target.property,{entryId:row.entryId!,revision:row.revision});
    else startEdit(cell,row,draft.target.property,options.getEditableValue?.(row,draft.target.property)??row.values[draft.target.property]??BASE_NULL);
    if(!rawEditor||editing!==cell)return'conflict';rawEditor.restore(draft);return'restored';
  }
  type CellOwner = { entryId?: string; path: string; property: string; scope: number; group: number; version: BaseQueryResult['version'] };
  const cellOwners = new WeakMap<HTMLElement, CellOwner>();
  const editFocusEpochs = new WeakMap<HTMLElement, number>();
  let focusEpoch = 0;
  let blockedActivation: { cell: HTMLElement; event: MouseEvent; open: boolean; title: boolean; checkbox: boolean } | undefined;
  const collapsed = new Set<string>();
  let collapsedContext: ReturnType<typeof collapseContext> | undefined;
  const widgetDisposers = new Map<HTMLElement, () => void>();
  let bulkPending = false, configPending = false;
  let newPending = false;
  let closeMenu: (() => void) | undefined, closePicker: (() => void) | undefined, pickerAnchor: HTMLElement | undefined;
  let widths = new Map<string, number>(), resizeWidths = new Map<string, number>();
  const measuredWidths = new Map<string, number>();
  let stopResize: (() => void) | undefined, draggedColumn: string | undefined;
  type ResizeIntent = { property: string; viewName: string; viewType: string; scope: number; entryId?: string; queued: boolean; retired?: boolean; change: { delta: number } | { width: number | undefined } };
  const resizeCommands: ResizeIntent[] = [];
  type ConfigurationAcknowledgement = { result: BaseQueryResult; patch: BaseViewPatch; scope: number; entryId?: string; column?: string };
  let awaitingConfigurationResult: ConfigurationAcknowledgement | undefined, resizeDrainScheduled = false;
  let configurationScope = 0, configurationEntryId = options.getConfigurationIdentity?.();
  const summaryOrigins = new WeakMap<HTMLElement, { property: string; scope: number; overall: boolean }>();
  const hasActiveEdits = () => !destroyed && (!!editing || bulkPending || configPending || !!root.querySelector('[data-base-editing]'));
  function releaseCell(cell: HTMLElement) {
    const dispose = widgetDisposers.get(cell); widgetDisposers.delete(cell);
    try { dispose?.(); } catch (error) { report(error); }
  }
  function releaseRow(row: Element) { for (const cell of row.querySelectorAll<HTMLElement>('[role=gridcell]')) releaseCell(cell); }
  function matchesConfigurationAcknowledgement(next: BaseQueryResult, acknowledgement: ConfigurationAcknowledgement, published?: BaseTableConfigurationAcknowledgement) {
    const matches = acknowledgement.column
      ? sameConfigurationValue((next.view.columnSize as Record<string, unknown> | undefined)?.[acknowledgement.column], (acknowledgement.patch.columnSize as Record<string, unknown> | undefined)?.[acknowledgement.column])
      : publishedConfigurationMatches(next.view, acknowledgement.patch);
    return acknowledgement.scope === configurationScope && next.view.name === acknowledgement.result.view.name && next.view.type === acknowledgement.result.view.type
      && (!options.getConfigurationIdentity || acknowledgement.entryId === (published ? published.entryId : options.getConfigurationIdentity())) && matches;
  }
  function reconcileConfigurationAcknowledgement(next: BaseQueryResult): boolean {
    const acknowledgement = awaitingConfigurationResult;
    if (!acknowledgement) return false;
    if (acknowledgement.scope !== configurationScope) { awaitingConfigurationResult = undefined; return false; }
    if (next === acknowledgement.result || next.version === acknowledgement.result.version) return false;
    awaitingConfigurationResult = undefined;
    if (matchesConfigurationAcknowledgement(next, acknowledgement)) return false;
    if (resizeCommands.every(command => command.retired || command.scope !== configurationScope)) return false;
    const cancelled = !!resizeCommands.length; resizeCommands.length = 0; return cancelled;
  }
  function reportConfigurationConflict() { report(new Error('The column width changed while saving. Queued column width changes were cancelled. Resize again from the current view.')); }
  async function patch(patch: BaseViewPatch, column?: string) {
    if (!options.patchView || destroyed || hasActiveEdits()) return;
    const submittedResult = result, acknowledgement: ConfigurationAcknowledgement = { result, patch: structuredClone(patch), column, scope: configurationScope, entryId: options.getConfigurationIdentity?.() };
    configPending = true;
    let saved = false;
    try { await options.patchView(patch); saved = true; }
    catch (error) {
      const hadQueuedWidths = !!resizeCommands.length; resizeCommands.length = 0; awaitingConfigurationResult = undefined;
      if (!destroyed) report(hadQueuedWidths ? new Error(`${error instanceof Error ? error.message : String(error)} Queued column width changes were cancelled.`) : error);
    }
    finally {
      configPending = false;
      if (!destroyed) {
        if (saved) awaitingConfigurationResult = acknowledgement.scope === configurationScope && (result === submittedResult || !matchesConfigurationAcknowledgement(result, acknowledgement)) ? acknowledgement : undefined;
        const conflict = saved && reconcileConfigurationAcknowledgement(result);
        try { options.onEditStateChange?.(hasActiveEdits()); } catch (error) { report(error); }
        if (saved) try {
          const published = options.onConfigurationSettled?.();
          if (published?.result === result && matchesConfigurationAcknowledgement(result, acknowledgement, published) && (result !== submittedResult || matchesConfigurationAcknowledgement(submittedResult, acknowledgement, published))) awaitingConfigurationResult = undefined;
        } catch (error) { resizeCommands.length = 0; report(error); }
        if (conflict) reportConfigurationConflict();
        scheduleResizeCommands();
      }
    }
  }

  function report(error: unknown) {
    status.textContent = error instanceof Error ? error.message : String(error);
    try { options.onError?.(error); } catch { /* Reporting cannot interrupt disposal or sibling commands. */ }
  }
  function writableProperty(row: BaseQueryRow, property: string) {
    const kind = options.getPropertyType?.(property);
    return !!(options.editProperty || options.editProperties) && /\.md$/i.test(row.path) && property.startsWith('note.') && !['rollup', 'reverseRelation', 'reverse-relation'].includes(kind ?? '') && (options.isPropertyEditable?.(property, row) ?? true);
  }
  function editable(row: BaseQueryRow, property: string, value: BaseExpressionValue) {
    return writableProperty(row, property) && (primitiveTypes.has(value.type) || !!options.renderProperty);
  }
  function dimensions() {
    const base = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-row-height') ?? '') || 30;
    const multiplier = result.view.rowHeight === 'medium' ? 2 : result.view.rowHeight === 'tall' ? 4 : result.view.rowHeight === 'extra' ? 8 : 1;
    rowHeight = Math.max(1, base) * multiplier;
    root.style.setProperty('--zorid-base-row-height', `${rowHeight}px`); root.classList.toggle('is-multiline', multiplier > 1);
    const sizes = result.view.columnSize;
    widths = new Map(result.properties.map(property => {
      const size = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[property] : undefined;
      const automatic = measuredWidths.get(property) ?? autoWidth(property);
      return [property, resizeWidths.get(property) ?? (typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.max(40, size) : automatic)];
    }));
    template = [...widths.values()].map(size => `${size}px`).concat(options.requestAddProperty ? ['42px'] : []).join(' ');
    const total = [...widths.values()].reduce((sum, width) => sum + width, options.requestAddProperty ? 42 : 0);
    footer.style.gridTemplateColumns = template; footer.style.minWidth = `${total}px`;
    header.style.gridTemplateColumns = template; header.style.minWidth = `${total}px`; body.style.minWidth = `${total}px`;
    newRow.style.minWidth = `${total}px`;
    for (const row of body.children) if (row instanceof doc.defaultView!.HTMLElement) row.style.gridTemplateColumns = template;
  }

  function rebuildItems() {
    items = [];
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i];
      if (group.key !== null) items.push({ group: i });
      if (!collapsed.has(groupIdentity(group))) {
        group.rows.forEach((row, rowIndex) => items.push({ row, groupIndex: i, rowIndex }));
        if (result.groups.length > 1 && group.key !== null && result.properties.some(property => options.getSummary?.(property, i))) items.push({ summary: i });
      }
    }
    body.style.height = `${items.length * rowHeight}px`;
    newRow.setAttribute('aria-rowindex', String(items.length + 2)); newCell.setAttribute('aria-colspan', String(Math.max(1, result.properties.length)));
    root.setAttribute('aria-rowcount', String(items.length + 1 + (options.onNew ? 1 : 0))); root.setAttribute('aria-colcount', String(result.properties.length));
  }
  function svgIcon(nodes: IconNode): SVGSVGElement {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'svg-icon lucide' })) svg.setAttribute(key, value);
    for (const [name, attributes] of nodes) { const path = doc.createElementNS(svg.namespaceURI, name); for (const [key, value] of Object.entries(attributes)) if (value !== undefined) path.setAttribute(key, String(value)); svg.append(path); }
    return svg;
  }
  function propertyGlyph(property: string): SVGSVGElement | HTMLSpanElement {
    if (property === 'file.name' || property === 'file.file') {
      const glyph = doc.createElement('span'); glyph.className = 'zorid-bases-table-title-type'; glyph.setAttribute('aria-hidden', 'true'); return glyph;
    }
    const value = result.rows.find(row => row.values[property]?.type !== 'null')?.values[property];
    const kind = options.getPropertyType?.(property) ?? value?.type ?? 'text';
    const glyphs: Record<string, IconNode> = { text: Text, string: Text, number: Binary, checkbox: SquareCheck, boolean: SquareCheck, date: Calendar, datetime: CalendarClock, 'date-time': CalendarClock, list: List, tags: Tags, multiselect: Tags, link: Link, relation: Link, select: ListFilter, status: CircleDot, rating: Star };
    return svgIcon(property.startsWith('formula.') ? CodeXml : glyphs[kind] ?? Text);
  }
  function showMenu(event: MouseEvent, entries: readonly TableMenuEntry[], returnFocus: HTMLElement) {
    event.preventDefault(); event.stopPropagation(); closeMenu?.(); closePicker?.();
    const token = revision, controller = new AbortController(); closeMenu = () => controller.abort();
    const menuSelection = JSON.stringify(selectedBounds());
    const actions = new Map<string, () => void>(); let next = 0;
    const map = (entries: readonly TableMenuEntry[]): ContextMenuItem[] => entries.flatMap(entry => {
      const id = String(next++); if (entry.action) actions.set(id, entry.action);
      const icons: Record<string, string> = { 'Hide column': 'eye-off', 'Summarize...': 'calculator', 'Group by this property': 'group', 'Sort A → Z': 'arrow-down-wide-narrow', 'Sort Z → A': 'arrow-up-narrow-wide', 'Remove sort': 'eraser', 'Edit property...': 'edit', 'Edit formula...': 'code', 'Property type': 'info', Copy: 'copy', Paste: 'clipboard-paste', 'Clear selection': 'eraser', Delete: 'trash', 'Select row': 'rows-3', 'Select column': 'columns-3' };
      const item = { label: entry.label, enabled: !entry.disabled, icon: icons[entry.label], ...(entry.submenu ? { submenu: map(entry.submenu) } : { id }), ...(entry.checked === undefined ? {} : { checked: entry.checked }) };
      return ['Sort A → Z', 'Edit property...', 'Edit formula...', 'Property type', 'Clear selection'].includes(entry.label) ? [{ type: 'separator' } as ContextMenuItem, item] : [item];
    });
    const rect = returnFocus.getBoundingClientRect();
    const current = () => !destroyed && token === revision && returnFocus.isConnected && !controller.signal.aborted && !hasActiveEdits()
      && menuSelection === JSON.stringify(selectedBounds());
    void showContextMenu({ clientX: event.clientX || rect.left, clientY: event.clientY || rect.bottom, preventDefault() {}, stopPropagation() {} }, map(entries), { document: doc, signal: controller.signal, isCurrent: current }).then(id => {
      if (!current() || id === null) return; closeMenu = undefined; actions.get(id)?.();
    }).catch(report);
  }
  function showSummaryPicker(property: string, anchor: HTMLElement, groupIndex: number | null = null) {
    closeMenu?.(); closePicker?.();
    if (!options.requestSummary || destroyed || !root.isConnected || hasActiveEdits()) return;
    // Only this table's actual picker anchors can authorize a later return
    // after an accepted configuration replaces their DOM nodes.
    if (!root.contains(anchor)) return;
    summaryOrigins.set(anchor, { property, scope: configurationScope, overall: groupIndex === null });
    const token = revision, popup = doc.createElement('div'); popup.className = 'zorid-bases-summary-picker'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', 'Summarize');
    const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Find or create...'; search.setAttribute('aria-label', 'Find or create summary');
    const searchRow = doc.createElement('div'); searchRow.className = 'zorid-bases-summary-search'; searchRow.append(svgIcon(Search), search);
    const list = doc.createElement('div'); list.className = 'zorid-bases-summary-list'; list.setAttribute('role', 'listbox'); popup.append(searchRow, list);
    const rect = anchor.getBoundingClientRect(); popup.style.left = `${Math.max(4, Math.min(rect.left, (win?.innerWidth ?? 1024) - 224))}px`; popup.style.top = `${Math.max(4, Math.min(rect.bottom + 4, (win?.innerHeight ?? 768) - 380))}px`;
    let active = 0, disposed = false, choices: readonly { id: string; label: string; preview?: BaseExpressionValue }[] = [];
    const current = () => !disposed && !destroyed && revision === token && anchor.isConnected;
    const dismiss = (restoreFocus = true) => {
      if (disposed) return; disposed = true; popup.remove(); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); if (closePicker === close) { closePicker = undefined; pickerAnchor = undefined; } if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    };
    const close = () => dismiss(false); closePicker = close; pickerAnchor = anchor;
    const outside = (event: Event) => { if (!popup.contains(event.target as Node)) dismiss(false); };
    const select = (id: string) => { if (!current()) return; dismiss(); Promise.resolve(options.requestSummary?.(property, id)).catch(report); };
    const draw = () => {
      if (!current()) return; list.replaceChildren(); const query = search.value.trim().toLocaleLowerCase();
      const filtered = choices.filter(choice => choice.label.toLocaleLowerCase().includes(query));
      const setActive = (index: number) => { active = Math.max(0, Math.min(index, filtered.length - 1)); for (const [i, row] of [...list.querySelectorAll<HTMLElement>('[role=option]')].entries()) { row.classList.toggle('is-selected', i === active); row.setAttribute('aria-selected', String(i === active)); } };
      for (const [index, choice] of filtered.entries()) {
        const row = doc.createElement('div'); row.className = 'zorid-bases-summary-option'; row.setAttribute('role', 'option'); row.dataset.summaryId = choice.id;
        const label = doc.createElement('span'); label.className = 'zorid-bases-summary-label'; label.textContent = choice.label;
        const preview = doc.createElement('span'); preview.className = 'zorid-bases-summary-preview'; preview.textContent = choice.preview ? display(choice.preview, result.shared !== undefined) : '';
        row.append(svgIcon(choice.preview?.type === 'number' ? Binary : choice.preview?.type === 'string' ? Text : Calculator), label, preview);
        const edit = doc.createElement('button'); edit.type = 'button'; edit.className = 'zorid-bases-summary-edit'; edit.textContent = '›'; edit.setAttribute('aria-label', `Edit ${choice.label}`); edit.disabled = !options.requestEditSummary;
        edit.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!current()) return; dismiss(); options.requestEditSummary?.(property, choice.id, anchor, groupIndex); }); row.append(edit);
        row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('mouseenter', () => setActive(index)); row.addEventListener('click', () => select(choice.id)); list.append(row);
      }
      const add = doc.createElement('button'); add.type = 'button'; add.className = 'zorid-bases-summary-add'; add.textContent = query && !choices.some(choice => choice.label.toLocaleLowerCase() === query) ? `Add summary: ${search.value.trim()}` : 'Add summary'; add.prepend(svgIcon(Calculator)); add.disabled = !options.requestAddSummary;
      add.addEventListener('click', () => { if (!current()) return; const name = search.value.trim(); dismiss(); options.requestAddSummary?.(property, anchor, name || undefined); }); list.append(add);
      const summaries = result.view.summaries;
      if (options.requestHideSummary && summaries && typeof summaries === 'object' && !Array.isArray(summaries) && (Object.hasOwn(summaries, property) || Object.hasOwn(summaries, property.replace(/^note\./, '')))) {
        const hide = doc.createElement('button'); hide.type = 'button'; hide.className = 'zorid-bases-summary-add'; hide.textContent = 'Hide summary'; hide.prepend(svgIcon(Trash2)); hide.addEventListener('click', () => { if (!current()) return; dismiss(); Promise.resolve(options.requestHideSummary?.(property)).catch(report); }); list.append(hide);
      }
      setActive(active);
    };
    const key = (event: KeyboardEvent) => {
      if (!current() || !popup.contains(doc.activeElement)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      else if (!event.isComposing && ['ArrowUp', 'ArrowDown', 'Enter', 'ArrowRight'].includes(event.key)) {
        const rows = [...list.querySelectorAll<HTMLElement>('[role=option]')]; event.preventDefault(); event.stopPropagation();
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { active = rows.length ? (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length : 0; draw(); }
        else if (event.key === 'Enter') { const id = rows[active]?.dataset.summaryId; if (id) select(id); else list.querySelector<HTMLButtonElement>('.zorid-bases-summary-add:not(:disabled)')?.click(); }
        else { const id = rows[active]?.dataset.summaryId; if (id && options.requestEditSummary) { dismiss(); options.requestEditSummary(property, id, anchor, groupIndex); } }
      }
    };
    search.addEventListener('input', () => { active = 0; draw(); }); doc.body.append(popup); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true); search.focus();
    list.textContent = 'Loading...';
    Promise.resolve().then(() => options.getSummaryOptions ? options.getSummaryOptions(property, groupIndex) : options.summaryOptions ?? []).then(options => { if (!current()) return; choices = [...options].sort((a, b) => a.label.localeCompare(b.label)); draw(); }).catch(error => { if (current()) { list.textContent = error instanceof Error ? error.message : String(error); report(error); } });
  }
  function selectColumn(index: number) {
    const group = selection?.point?.group ?? 0;
    if (!result.groups[group]?.rows.length) return;
    range = { group, top: 0, bottom: result.groups[group].rows.length - 1, start: index, end: index };
    focusCell(result.groups[group].rows[0].path, result.properties[index], { group, row: 0, column: index }); paintRange();
  }
  function resizeBlocked() { return destroyed || !!editing || bulkPending || !!root.querySelector('[data-base-editing]'); }
  function scheduleResizeCommands() {
    if (resizeDrainScheduled || destroyed || !resizeCommands.length) return;
    resizeDrainScheduled = true;
    queueMicrotask(() => { resizeDrainScheduled = false; drainResizeCommands(); });
  }
  function drainResizeCommands() {
    if (!options.patchView || configPending || resizeBlocked()) return;
    const command = resizeCommands[0]; if (!command) return;
    const changedEntry = options.getConfigurationIdentity && ((command.queued && !command.entryId) || command.entryId !== options.getConfigurationIdentity());
    if (command.retired || command.scope !== configurationScope || command.viewName !== result.view.name || command.viewType !== result.view.type || !result.properties.includes(command.property) || changedEntry) {
      resizeCommands.shift(); report(new Error('The queued column width change was cancelled because its view or column changed.')); scheduleResizeCommands(); return;
    }
    if (awaitingConfigurationResult) return;
    resizeCommands.shift();
    const { property, change } = command;
    const width = 'delta' in change ? (widths.get(property) ?? 180) + change.delta : change.width;
    const sizes = result.view.columnSize;
    const next: Record<string, BaseValue> = { ...(sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? sizes as Record<string, BaseValue> : {}) };
    if (width === undefined) { delete next[property]; measuredWidths.delete(property); } else next[property] = Math.round(Math.max(40, width));
    resizeWidths.clear(); void patch({ columnSize: next }, property); dimensions(); renderRows();
  }
  function setColumnWidth(property: string, change: ResizeIntent['change']) {
    if (!options.patchView || resizeBlocked() || !result.properties.includes(property)) return;
    if (options.isConfigurationClosing?.()) { report(new Error('This Base view is finishing edits. The column width change was not accepted.')); return; }
    const entryId = options.getConfigurationIdentity?.();
    const queued = configPending || !!awaitingConfigurationResult || !!resizeCommands.length;
    if (options.getConfigurationIdentity && queued && !entryId) { report(new Error('Wait for the current column width save, then retry. A stable Base identity is unavailable for queued changes.')); return; }
    if (resizeCommands.length >= 1024) { report(new Error('Too many pending column width changes. Wait for the current save.')); return; }
    resizeCommands.push({ property, change, viewName: result.view.name, viewType: result.view.type, scope: configurationScope, entryId, queued });
    drainResizeCommands();
  }
  function autoWidth(property: string): number {
    const probe = doc.createElement('span'); probe.className = 'zorid-bases-table-measure'; probe.style.font = win?.getComputedStyle(root).font ?? ''; doc.body.append(probe);
    const defaultMin = property === 'file.name' || property === 'file.file' ? 280 : 200;
    const min = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-column-min-width') ?? '') || defaultMin;
    const max = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-column-max-width') ?? '') || 300;
    let width = min;
    for (const [index, text] of [options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, ''), ...result.rows.map(row => display(row.values[property] ?? BASE_NULL, result.shared !== undefined))].entries()) {
      probe.textContent = text; width = Math.max(width, Math.min(max, probe.getBoundingClientRect().width + (index === 0 ? 40 : 17)));
      if (width >= max) break;
    }
    probe.remove(); measuredWidths.set(property, width); return width;
  }
  function columnMenu(event: MouseEvent, property: string, index: number, cell: HTMLElement) {
    const sort = Array.isArray(result.view.sort) ? result.view.sort.filter(item => !!item && typeof item === 'object' && !Array.isArray(item) && item.property !== property) : [];
    const disabled = !options.patchView || hasActiveEdits();
    const sorted = Array.isArray(result.view.sort) ? result.view.sort.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.property === property) : undefined;
    showMenu(event, [
      { label: 'Hide column', disabled, action: () => { void patch({ order: result.properties.filter(item => item !== property) }); } },
      { label: 'Summarize...', disabled: !options.requestSummary || (!options.getSummaryOptions && !options.summaryOptions?.length), action: () => showSummaryPicker(property, cell) },
      { label: 'Group by this property', disabled, action: () => { void patch({ groupBy: { property, direction: 'ASC' } }); } },
      { label: 'Sort A → Z', disabled, action: () => { void patch({ sort: [{ property, direction: 'ASC' }, ...sort] }); } },
      { label: 'Sort Z → A', disabled, action: () => { void patch({ sort: [{ property, direction: 'DESC' }, ...sort] }); } },
      ...(sorted ? [{ label: 'Remove sort', disabled, action: () => { void patch({ sort }); } }] : []),
      { label: property.startsWith('formula.') ? 'Edit formula...' : 'Edit property...', disabled: !options.requestEditProperty || hasActiveEdits(), action: () => options.requestEditProperty?.(property, cell) },
      ...(property.startsWith('note.') ? [{ label: 'Property type', disabled: !options.requestPropertyType || !options.propertyTypes?.length, submenu: options.propertyTypes?.map(type => ({ label: type.label, checked: options.getPropertyType?.(property) === type.id, action: () => { Promise.resolve(options.requestPropertyType?.(property, type.id)).catch(report); } })) }] : []),
    ], cell);
  }
  function renderHeader() {
    header.replaceChildren();
    for (const [index, property] of result.properties.entries()) {
      const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-column';
      cell.setAttribute('role', 'columnheader'); cell.setAttribute('aria-colindex', String(index + 1)); cell.tabIndex = 0;
      cell.textContent = options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, '');
      cell.dataset.property = property; cell.dataset.baseTooltip = cell.textContent ?? property;
      const label = doc.createElement('span'); label.className = 'zorid-bases-table-header-name'; label.textContent = cell.textContent; cell.replaceChildren(propertyGlyph(property), label);
      const sorted = Array.isArray(result.view.sort) ? result.view.sort.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.property === property) : undefined;
      if (sorted && typeof sorted === 'object' && !Array.isArray(sorted)) { const indicator = doc.createElement('span'); indicator.className = 'zorid-bases-table-sort-indicator'; indicator.setAttribute('aria-label', sorted.direction === 'DESC' ? 'Sorted descending' : 'Sorted ascending'); indicator.textContent = sorted.direction === 'DESC' ? '↓' : '↑'; cell.setAttribute('aria-sort', sorted.direction === 'DESC' ? 'descending' : 'ascending'); cell.append(indicator); }
      const token = revision, current = () => !destroyed && token === revision && header.contains(cell);
      cell.addEventListener('contextmenu', event => { if (current()) columnMenu(event, property, index, cell); });
      cell.setAttribute('aria-haspopup', 'menu');
      cell.addEventListener('click', event => { if (current() && !event.defaultPrevented && !(event.target as Element).closest('.zorid-bases-table-resize')) columnMenu(event, property, index, cell); });
      cell.addEventListener('keydown', event => {
        if (event.target !== cell || event.isComposing || event.defaultPrevented || !current()) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
          event.preventDefault();
          columnMenu(new win!.MouseEvent('contextmenu', { bubbles: true, cancelable: true }), property, index, cell);
        }
      });
      if (options.patchView) {
        cell.draggable = true;
        cell.addEventListener('dragstart', event => { if (!current() || hasActiveEdits()) { event.preventDefault(); return; } draggedColumn = property; event.dataTransfer?.setData('application/x-zorid-base-column', property); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
        cell.addEventListener('dragover', event => { if (current() && draggedColumn && draggedColumn !== property) { event.preventDefault(); const rect = cell.getBoundingClientRect(), after = win?.getComputedStyle(root).direction === 'rtl' ? event.clientX < rect.left + rect.width / 2 : event.clientX > rect.left + rect.width / 2; cell.classList.add('is-drop-target'); cell.classList.toggle('is-drop-after', after); } });
        cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target', 'is-drop-after'));
        cell.addEventListener('drop', event => { event.preventDefault(); const rect = cell.getBoundingClientRect(), after = win?.getComputedStyle(root).direction === 'rtl' ? event.clientX < rect.left + rect.width / 2 : event.clientX > rect.left + rect.width / 2; cell.classList.remove('is-drop-target', 'is-drop-after'); if (!current() || !draggedColumn || !result.properties.includes(draggedColumn) || draggedColumn === property) return; const order = result.properties.filter(item => item !== draggedColumn); order.splice(order.indexOf(property) + (after ? 1 : 0), 0, draggedColumn); draggedColumn = undefined; void patch({ order }); });
        cell.addEventListener('dragend', () => { draggedColumn = undefined; for (const cell of header.children) cell.classList.remove('is-drop-target', 'is-drop-after'); });
        const handle = doc.createElement('span'); handle.className = 'zorid-bases-table-resize'; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', `Resize ${options.getPropertyLabel?.(property) ?? property}`); handle.setAttribute('aria-orientation', 'vertical'); handle.tabIndex = 0;
        handle.addEventListener('click', event => event.stopPropagation());
        handle.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); if (current()) setColumnWidth(property, { width: undefined }); });
        handle.addEventListener('keydown', event => { if (!current() || event.isComposing || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); setColumnWidth(property, event.key === 'Home' ? { width: undefined } : { delta: event.key === 'ArrowLeft' ? -10 : 10 }); });
        handle.addEventListener('pointerdown', event => {
          if (!current() || event.button !== 0 || resizeBlocked()) return;
          event.preventDefault(); event.stopPropagation(); stopResize?.();
          const start = event.clientX, initial = widths.get(property) ?? 180;
          let changed = false;
          const move = (next: PointerEvent) => { if (!current() || next.pointerId !== event.pointerId) return; changed = true; resizeWidths.set(property, Math.max(40, initial + (next.clientX - start) * (win?.getComputedStyle(root).direction === 'rtl' ? -1 : 1))); dimensions(); };
          const finish = (next: PointerEvent) => { if (next.pointerId !== event.pointerId) return; const width = resizeWidths.get(property); stopResize?.(); if (changed && next.type !== 'pointercancel' && current()) setColumnWidth(property, { width }); else { resizeWidths.clear(); dimensions(); } };
          const blur = () => { stopResize?.(); resizeWidths.clear(); dimensions(); };
          stopResize = () => { win?.removeEventListener('pointermove', move); win?.removeEventListener('pointerup', finish); win?.removeEventListener('pointercancel', finish); win?.removeEventListener('blur', blur); stopResize = undefined; };
          win?.addEventListener('pointermove', move); win?.addEventListener('pointerup', finish); win?.addEventListener('pointercancel', finish); win?.addEventListener('blur', blur);
        });
        cell.append(handle);
      }
      header.append(cell);
    }
    if (options.requestAddProperty) {
      const add = doc.createElement('button'); add.type = 'button'; add.className = 'zorid-bases-table-add-property';
      add.setAttribute('aria-label', 'Add property'); add.dataset.baseTooltip = 'Add property'; add.append(svgIcon(Plus));
      const token = revision;
      add.addEventListener('click', () => { if (!destroyed && token === revision && header.contains(add) && !hasActiveEdits() && !propertyAdmissionBlocked()) options.requestAddProperty?.(add); });
      header.append(add);
    }
  }
  function focusCell(path: string, property: string, point?: CellPoint) {
    const index = items.findIndex(item => item.row && item.row.path === path && (!point || item.groupIndex === point.group && item.rowIndex === point.row));
    const item = items[index];
    selection = { path, property, point: item?.row ? { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(property) } : point };
    if (index < 0) return;
    const top = index * rowHeight;
    if (top < root.scrollTop) root.scrollTop = top;
    else if (top + rowHeight > root.scrollTop + root.clientHeight - 30) root.scrollTop = top + rowHeight - Math.max(rowHeight, root.clientHeight - 30);
    renderRows();
    for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === path && cell.dataset.property === property && (!point || cell.dataset.group === String(point.group) && cell.dataset.row === String(point.row))) { cell.focus(); break; }
    }
  }
  const propertyAdmissionBlocked = () => newPending || configPending || !!resizeCommands.length || !!awaitingConfigurationResult || options.canBeginPropertyEdit?.() === false;
  function currentOwner(owner: CellOwner) {
    if (destroyed || owner.scope !== configurationScope || !result.properties.includes(owner.property) || !owner.entryId && owner.version !== result.version) return;
    const matches = (item: Item) => item.row && (owner.entryId ? item.row.entryId === owner.entryId : item.row.path === owner.path);
    return items.find(item => item.row && matches(item) && item.groupIndex === owner.group) ?? items.find(matches);
  }
  function moveAfterTab(point: CellPoint, direction: 1 | -1) {
    let target = items.findIndex(item => item.row && item.groupIndex === point.group && item.rowIndex === point.row);
    if (target < 0) return;
    let column = point.column + direction;
    if (column < 0 || column >= result.properties.length) {
      column = column < 0 ? result.properties.length - 1 : 0;
      // Match arrow navigation's visible rows, skipping collapsed groups,
      // headings and summaries without changing selection at the table edge.
      do { target += direction; } while (target >= 0 && target < items.length && !items[target].row);
    }
    const item = items[target];
    if (item?.row) { range = undefined; anchor = undefined; focusCell(item.row.path, result.properties[column], { group: item.groupIndex, row: item.rowIndex, column }); paintRange(); }
  }
  function replayBlockedActivation(): boolean {
    const blocked = blockedActivation; blockedActivation = undefined;
    if (!blocked) return false;
    const owner = cellOwners.get(blocked.cell), item = owner && currentOwner(owner);
    if (!owner || !item?.row || propertyAdmissionBlocked() || hasActiveEdits()) return false;
    const point = { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(owner.property) };
    if (!blocked.event.shiftKey || blocked.event.metaKey || blocked.event.ctrlKey) { range = undefined; anchor = undefined; focusCell(item.row.path, owner.property, point); paintRange(); }
    const cell = [...body.querySelectorAll<HTMLElement>('[role="gridcell"][data-path]')].find(cell => cell.dataset.group === String(point.group) && cell.dataset.row === String(point.row) && cell.dataset.column === String(point.column));
    if (blocked.checkbox && !blocked.event.shiftKey) { cell?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(); return true; }
    const target = blocked.open ? cell?.querySelector<HTMLElement>('.zorid-bases-table-open') : blocked.title ? cell?.querySelector<HTMLElement>('.zorid-bases-table-title') : cell;
    target?.dispatchEvent(new win!.MouseEvent('click', { bubbles: true, cancelable: true, button: blocked.event.button, shiftKey: blocked.event.shiftKey, ctrlKey: blocked.event.ctrlKey, metaKey: blocked.event.metaKey, altKey: blocked.event.altKey }));
    return true;
  }
  function completePropertyEdit(element: HTMLElement, presentation: BasePropertyPresentation, intent: BasePropertyEditorCompletionIntent) {
    const owner = cellOwners.get(element);
    if (!owner || owner.property !== presentation.property || owner.entryId && owner.entryId !== presentation.row.entryId || editFocusEpochs.get(element) !== focusEpoch || propertyAdmissionBlocked() || hasActiveEdits()) return;
    const item = currentOwner(owner);
    if (!item?.row) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && active !== doc.documentElement && !root.contains(active) && !element.contains(active)) { blockedActivation = undefined; return; }
    if (blockedActivation && replayBlockedActivation()) return;
    if (intent.reason === 'pointer') return; // The browser's original click still owns a click that was not blocked.
    if (active && active !== doc.body && active !== doc.documentElement && active !== element && !element.contains(active)) return;
    const point = { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(owner.property) };
    if (intent.reason === 'tab') moveAfterTab(point, intent.direction);
    else { range = undefined; anchor = undefined; focusCell(item.row.path, owner.property, point); paintRange(); }
  }
  function startRename(cell: HTMLElement, row: BaseQueryRow, property: string, witness?: BaseTableFileWitness, seed?: string) {
    if (!options.renameFile || !witness || !/\.md$/i.test(row.path) || destroyed || editing || range || propertyAdmissionBlocked()) return;
    const token = revision, version = result.version, initialName = row.path.split('/').at(-1)!.replace(/\.md$/i, '');
    const input = doc.createElement('input'); input.className = 'zorid-bases-table-input'; input.type = 'text'; input.value = seed ?? initialName; input.setAttribute('aria-label', 'Name');
    cell.focus(); editing = cell; cell.dataset.baseEditing = 'draft'; options.onEditStateChange?.(true); cell.replaceChildren(input); input.focus();
    if (seed === undefined) input.select(); else input.setSelectionRange(seed.length, seed.length);
    let saving = false, submitted=false, completion: 'enter' | 'tab' | 'blur' = 'blur', direction: 1 | -1 = 1;
    const control=rawControl(input,cell,row,property,'title',initialName,()=>!saving&&!submitted);
    const finish = (restore: boolean) => {
      if (destroyed || token !== revision || editing !== cell) return;
      stopRename?.(); rawEditor=undefined; editing = undefined; cell.removeAttribute('data-base-editing'); cell.removeAttribute('aria-busy');
      // Restore only this cell. Replacing the destination during pointerdown
      // would discard the browser's still-pending click after an unchanged edit.
      const point = pointOf(cell); cell.replaceWith(renderCell(row, property, point.column, point));
      options.onEditStateChange?.(false);
      const active = doc.activeElement, retainedFocus = editFocusEpochs.get(cell) === focusEpoch && (!active || active === doc.body || active === doc.documentElement || root.contains(active));
      if (retainedFocus && replayBlockedActivation()) return;
      if (restore && retainedFocus) {
        const item = items.find(item => item.row?.entryId === witness.entryId);
        if (item?.row) { const point = { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(property) }; if (completion === 'tab') moveAfterTab(point, direction); else focusCell(item.row.path, property, point); }
      }
    };
    const save = async () => {
      if (control.blocked() || saving || destroyed || token !== revision || editing !== cell) return;
      const name = input.value.trim();
      if (!name || /[\\/:\u0000-\u001f]/.test(name) || name === '.' || name === '..') { blockedActivation = undefined; input.setAttribute('aria-invalid', 'true'); report(new Error('Enter a name without path separators.')); return; }
      if (name === initialName) { finish(completion !== 'blur'); return; }
      submitted=true; saving = true; input.disabled = true; cell.setAttribute('aria-busy', 'true');
      try {
        await options.renameFile!({ version, path: row.path, name, witness });
        if (destroyed || token !== revision || editing !== cell) return;
        status.textContent = ''; finish(completion !== 'blur');
      } catch (error) {
        if (destroyed || token !== revision || editing !== cell) return;
        blockedActivation = undefined; saving = false; input.disabled = false; cell.removeAttribute('aria-busy'); input.setAttribute('aria-invalid', 'true'); report(error);
        if (editFocusEpochs.get(cell) === focusEpoch && (doc.activeElement === doc.body || doc.activeElement === input)) input.focus();
      }
    };
    input.addEventListener('keydown', event => {
      if(control.frozen()){event.preventDefault();event.stopPropagation();return;}
      control.interact();
      if (event.isComposing) return;
      event.stopPropagation();
      if (event.key === 'Escape' && !saving) { event.preventDefault(); blockedActivation = undefined; completion = 'enter'; finish(true); }
      else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); completion = event.key === 'Tab' ? 'tab' : 'enter'; direction = event.shiftKey ? -1 : 1; void save(); }
    });
    input.addEventListener('blur', () => { void save(); });
    const outside = (event: PointerEvent) => { if (!cell.contains(event.target as Node)) void save(); };
    doc.addEventListener('pointerdown', outside, true);
    stopRename = () => { doc.removeEventListener('pointerdown', outside, true); stopRename = undefined; };
  }
  function editFileTitle(path: string, entryId: string): boolean {
    if (!options.renameFile || !entryId || destroyed || hasActiveEdits() || propertyAdmissionBlocked()) return false;
    const property = result.properties.find(property => property === 'file.name' || property === 'file.file');
    if (!property) return false;
    const group = result.groups.findIndex(group => group.rows.some(row => row.path === path && row.entryId === entryId && typeof row.revision === 'string'));
    if (group < 0) return false;
    if (collapsed.delete(groupIdentity(result.groups[group]))) rebuildItems();
    const item = items.find(item => item.row?.path === path && item.row.entryId === entryId && typeof item.row.revision === 'string');
    if (!item?.row || !/\.md$/i.test(path)) return false;
    range = undefined; anchor = undefined;
    const point = { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(property) };
    focusCell(path, property, point);
    const cell = [...body.querySelectorAll<HTMLElement>('[role="gridcell"][data-path]')].find(cell => cell.dataset.group === String(point.group) && cell.dataset.row === String(point.row) && cell.dataset.property === property);
    if (!cell) return false;
    startRename(cell, item.row, property, Object.freeze({ entryId, revision: item.row.revision! }));
    return editing === cell;
  }
  newButton.addEventListener('click', () => {
    if (!options.onNew || destroyed || newPending || hasActiveEdits() || propertyAdmissionBlocked()) return;
    const scope = configurationScope, epoch = focusEpoch;
    newPending = true; newButton.disabled = true; newButton.setAttribute('aria-busy', 'true');
    void (async () => {
      let created: BaseTableCreatedItem | void = undefined;
      try { created = await options.onNew!(newButton); }
      catch (error) { blockedActivation = undefined; if (!destroyed) report(error); }
      finally { newPending = false; if (!destroyed) { newButton.disabled = false; newButton.removeAttribute('aria-busy'); } }
      if (!created?.entryId || destroyed || scope !== configurationScope || epoch !== focusEpoch) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement && !root.contains(active)) return;
      if (replayBlockedActivation()) return;
      editFileTitle(created.path, created.entryId);
    })();
  });
  function startEdit(cell: HTMLElement, row: BaseQueryRow, property: string, value: BaseExpressionValue, toggle = false) {
    if (destroyed || editing || range || propertyAdmissionBlocked() || !editable(row, property, value)) return;
    const token = revision, version = result.version;
    const multiline = value.type === 'string' && /[\r\n]/.test(value.value);
    editing = cell; cell.dataset.baseEditing = 'draft'; options.onEditStateChange?.(true); const input = multiline ? doc.createElement('textarea') : doc.createElement('input');
    input.className = 'zorid-bases-table-input';
    input.setAttribute('aria-label', options.getPropertyLabel?.(property) ?? property);
    // Keep number text uncoerced while editing, so malformed input cannot become null/zero.
    if (!multiline) (input as HTMLInputElement).type = value.type === 'boolean' ? 'checkbox' : 'text';
    if (value.type === 'boolean') (input as HTMLInputElement).checked = toggle ? !value.value : value.value;
    else input.value = value.type === 'null' ? '' : display(value, result.shared !== undefined);
    // Compare the control baseline, so untouched CRLF values survive textarea normalization.
    const originalText = input.value;
    cell.replaceChildren(input); input.focus(); if (value.type !== 'boolean') input.select();
    let saving = false, submitted=false, restoreAfterSave = true;
    const control=rawControl(input,cell,row,property,'property',JSON.stringify(value),()=>!saving&&!submitted);
    const cancel = (restoreFocus = true) => { if (control.frozen() || editing !== cell) return; rawEditor=undefined; editing = undefined; cell.removeAttribute('data-base-editing'); options.onEditStateChange?.(false); renderRows(); if (restoreFocus) focusCell(row.path, property); };
    async function save(restoreFocus = true) {
      if (!restoreFocus) restoreAfterSave = false;
      if (control.blocked() || saving || destroyed || revision !== token || editing !== cell) return;
      if (value.type !== 'boolean' && input.value === originalText) { cancel(restoreFocus); return; }
      let next: BaseExpressionValue;
      if (value.type === 'boolean') next = { type: 'boolean', value: (input as HTMLInputElement).checked };
      else if (!input.value) next = BASE_NULL;
      else if (value.type === 'number') {
        const n = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(n)) {
          input.setAttribute('aria-invalid', 'true'); report(new Error('Enter a valid number.')); return;
        }
        next = { type: 'number', value: n };
      } else next = { type: 'string', value: input.value };
      try { if (value.type !== 'boolean' && options.parsePropertyInput) next = options.parsePropertyInput(input.value, property, row); next = options.validatePropertyValue?.(next, property, row) ?? next; } catch (error) { input.setAttribute('aria-invalid', 'true'); report(error); return; }
      submitted=true; saving = true; input.disabled = true; cell.setAttribute('aria-busy', 'true');
      try {
        if (options.editProperty) await options.editProperty({ version, path: row.path, property, value: next });
        else await options.editProperties?.([{ version, path: row.path, property, value: next }]);
        if (destroyed || revision !== token || editing !== cell) return;
        editing = undefined; cell.removeAttribute('data-base-editing'); options.onEditStateChange?.(false); status.textContent = ''; renderRows(); if (restoreAfterSave) focusCell(row.path, property);
      } catch (error) {
        if (destroyed || revision !== token || editing !== cell) return;
        saving = false; input.disabled = false; cell.removeAttribute('aria-busy'); input.setAttribute('aria-invalid', 'true'); report(error); if (restoreAfterSave) input.focus();
      }
    }
    input.addEventListener('keydown', rawEvent => {
      const event = rawEvent as KeyboardEvent;
      if(control.frozen()){event.preventDefault();event.stopPropagation();return;}
      control.interact();
      if (event.isComposing || (multiline && event.key === 'Enter' && event.shiftKey)) return;
      if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(); }
    });
    input.addEventListener('change', () => { if (value.type === 'boolean') void save(); });
    input.addEventListener('blur', () => { void save(false); });
    if (toggle) void save();
  }
  function renderCell(row: BaseQueryRow, property: string, index: number, point: CellPoint) {
    const cell = doc.createElement('div'), value = row.values[property] ?? BASE_NULL, token = revision;
    const current = () => !destroyed && token === revision && body.contains(cell);
    const filePath = row.path;
    // Retain the same saved target through host awaits; never re-resolve a reused path.
    // Direct row opens have no subpath, even when the literal filename contains #.
    const fileWitness: BaseTableFileWitness | undefined = typeof row.entryId === 'string' && typeof row.revision === 'string'
      ? Object.freeze({ entryId: row.entryId, revision: row.revision }) : undefined;
    const openRow = (event: MouseEvent | KeyboardEvent) => {
      if (fileWitness) options.openFile(filePath, event, fileWitness);
      else options.openFile(filePath, event);
    };
    cell.className = 'zorid-bases-table-cell'; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(index + 1));
    cell.dataset.valueType = options.getPropertyType?.(property) ?? value.type;
    cell.dataset.path = row.path; cell.dataset.property = property; cell.dataset.group = String(point.group); cell.dataset.row = String(point.row); cell.dataset.column = String(index);
    cellOwners.set(cell, { entryId: fileWitness?.entryId, path: filePath, property, scope: configurationScope, group: point.group, version: result.version });
    cell.tabIndex = selection?.path === row.path && selection.property === property && (!selection.point || selection.point.group === point.group && selection.point.row === point.row) ? 0 : -1;
    cell.setAttribute('aria-readonly', String(!editable(row, property, value) && !((property === 'file.name' || property === 'file.file') && options.renameFile && fileWitness && /\.md$/i.test(row.path))));
    if (editable(row, property, value)) cell.setAttribute('aria-disabled', String(propertyAdmissionBlocked()));
    if (options.renderProperty && property !== 'file.name' && property !== 'file.file') {
      try { const dispose = options.renderProperty(cell, { row, property, value, version: result.version }); if (dispose) widgetDisposers.set(cell, dispose); } catch (error) { report(error); cell.textContent = display(value, result.shared !== undefined); }
    } else if (property === 'file.name' || property === 'file.file') {
      const link = doc.createElement('a'); link.className = 'internal-link zorid-bases-table-title'; link.href = '#'; link.tabIndex = -1;
      link.textContent = display(value, result.shared !== undefined) || row.path; link.dataset.baseTooltip = row.path;
      link.addEventListener('click', event => { event.preventDefault(); if (current() && !suppressClick && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
        if (options.renameFile && fileWitness && /\.md$/i.test(row.path) && !event.metaKey && !event.ctrlKey && !event.altKey) startRename(cell, row, property, fileWitness);
        else openRow(event);
      } });
      link.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); if (current() && !suppressClick && (!event.shiftKey || event.metaKey || event.ctrlKey)) openRow(event); } });
      cell.classList.add('zorid-bases-table-file-cell'); cell.append(svgIcon(File), link);
      if (options.renameFile && fileWitness && /\.md$/i.test(row.path)) {
        const open = doc.createElement('button'); open.type = 'button'; open.className = 'zorid-bases-table-open'; open.tabIndex = -1;
        open.setAttribute('aria-label', `Open ${link.textContent}`); open.dataset.baseTooltip = 'Open page'; open.append(svgIcon(ArrowUpRight), doc.createTextNode('Open'));
        open.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (current() && !suppressClick && !hasActiveEdits()) openRow(event); });
        open.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); if (current() && !suppressClick && !hasActiveEdits()) openRow(event); } });
        cell.append(open);
      }
    } else if (value.type === 'boolean') {
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value.value; checkbox.disabled = !editable(row, property, value) || propertyAdmissionBlocked(); checkbox.tabIndex = -1;
      checkbox.setAttribute('aria-label', property);
      checkbox.addEventListener('click', event => { event.preventDefault(); if (current()) startEdit(cell, row, property, value, true); });
      cell.append(checkbox);
    } else {
      cell.textContent = display(value, result.shared !== undefined); if (value.type === 'error') cell.classList.add('is-error');
    }
    cell.addEventListener('focus', () => {
      selection = { path: row.path, property, point };
      for (const other of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) other.tabIndex = other === cell ? 0 : -1;
    });
    cell.addEventListener('click', event => {
      if (!current() || editing) return;
      if (suppressClick) { event.preventDefault(); suppressClick = false; return; }
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && selection?.point?.group === point.group) {
        const active = selection.point; anchor = active; range = cellBounds(active, point);
        event.preventDefault();
        const activeRow = result.groups[active.group].rows[active.row];
        focusCell(activeRow.path, result.properties[active.column], active); paintRange();
      } else if (!event.defaultPrevented && event.target === cell) {
        range = undefined; anchor = undefined; cell.focus(); paintRange();
        if (property === 'file.name' || property === 'file.file') startRename(cell, row, property, fileWitness);
      }
    });
    cell.addEventListener('dblclick', event => { if (!options.renderProperty && current() && !(event.target as Element).closest('a,input,textarea')) startEdit(cell, row, property, value); });
    cell.addEventListener('keydown', event => {
      if (!current() || event.defaultPrevented || event.target !== cell || event.isComposing || cell.hasAttribute('data-base-editing')) return;
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); cell.dispatchEvent(new win!.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      } else if (event.key === 'Escape') {
        event.preventDefault(); range = undefined; anchor = undefined; paintRange();
      } else if ((event.key === ' ' && (event.ctrlKey || event.shiftKey)) || (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        const bounds = range ?? cellBounds(point), groupRows = result.groups[point.group].rows.length;
        range = event.key.toLowerCase() === 'a' ? { group: point.group, top: 0, bottom: groupRows - 1, start: 0, end: result.properties.length - 1 }
          : event.ctrlKey ? { ...bounds, top: 0, bottom: groupRows - 1 } : { ...bounds, start: 0, end: result.properties.length - 1 };
        anchor = undefined; paintRange();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (options.editProperties) { event.preventDefault(); void clearSelection(); }
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault(); if (range) return;
        if (property === 'file.name' || property === 'file.file') {
          if (options.renameFile && fileWitness && /\.md$/i.test(row.path) && !event.metaKey && !event.ctrlKey && !event.altKey) startRename(cell, row, property, fileWitness);
          else openRow(event);
        }
        else if (!options.renderProperty) startEdit(cell, row, property, value);
      } else if (event.key === 'Tab') {
        event.preventDefault(); moveAfterTab(point, event.shiftKey ? -1 : 1);
      } else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)) {
        if ((event.metaKey || event.ctrlKey) && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault(); const candidates = items.filter(item => !!item.row), item = event.key === 'Home' ? candidates[0] : candidates.at(-1);
          if (item?.row) { range = undefined; const column = event.key === 'Home' ? 0 : result.properties.length - 1; focusCell(item.row.path, result.properties[column], { group: item.groupIndex, row: item.rowIndex, column }); } return;
        }
        if (event.metaKey || event.ctrlKey) {
          if (!event.shiftKey || !event.key.startsWith('Arrow')) return;
          event.preventDefault(); const bounds = range ?? cellBounds(point);
          range = event.key === 'ArrowUp' ? { ...bounds, top: 0, bottom: point.row }
            : event.key === 'ArrowDown' ? { ...bounds, top: point.row, bottom: result.groups[point.group].rows.length - 1 }
            : event.key === 'ArrowLeft' ? { ...bounds, start: 0, end: point.column }
            : { ...bounds, start: point.column, end: result.properties.length - 1 };
          anchor = undefined; paintRange(); return;
        }
        event.preventDefault(); const rowIndex = items.findIndex(item => item.row === row && item.groupIndex === point.group && item.rowIndex === point.row);
        let target = rowIndex, column = index;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const step = event.key === 'ArrowUp' ? -1 : 1; target += step;
          while (target >= 0 && target < items.length && !items[target].row) target += step;
        } else if (event.key === 'PageUp' || event.key === 'PageDown') {
          target = Math.max(0, Math.min(items.length - 1, target + (event.key === 'PageUp' ? -1 : 1) * Math.max(1, Math.floor((root.clientHeight || 600) / rowHeight))));
          while (target >= 0 && target < items.length && !items[target].row) target += event.key === 'PageUp' ? -1 : 1;
        } else if (event.key === 'ArrowLeft') column--;
        else if (event.key === 'ArrowRight') column++;
        else column = event.key === 'Home' ? 0 : result.properties.length - 1;
        const targetItem = items[target], next = targetItem?.row;
        if (next && column >= 0 && column < result.properties.length) {
          const nextPoint = { group: targetItem.groupIndex, row: targetItem.rowIndex, column };
          if (event.shiftKey && nextPoint.group !== point.group) return;
          if (event.shiftKey) { range = extendRange(range, point, nextPoint); anchor = undefined; }
          else { range = undefined; anchor = undefined; }
          focusCell(next.path, result.properties[column], nextPoint); paintRange();
        }
      } else if ((property === 'file.name' || property === 'file.file') && printableEditKey(event) && !range && !hasActiveEdits()) {
        startRename(cell, row, property, fileWitness, event.key);
        if (editing === cell) { event.preventDefault(); event.stopPropagation(); }
      }
    });
    cell.addEventListener('contextmenu', event => {
      if (!current() || hasActiveEdits() || textOwnsClipboard(event)) return;
      if (!range || point.group !== range.group || point.row < range.top || point.row > range.bottom || point.column < range.start || point.column > range.end) { range = undefined; cell.focus(); }
      const bounds = range ?? cellBounds(point);
      if (!range && (property === 'file.name' || property === 'file.file')) {
        if (options.contextMenu) {
          event.preventDefault();
          if (fileWitness) options.contextMenu(row, event, fileWitness);
          else options.contextMenu(row, event);
        }
        return;
      }
      showMenu(event, [
        { label: 'Copy', disabled: !canWriteClipboard(), action: () => { void copySelection(); } },
        { label: 'Paste', disabled: !options.editProperties || !canReadClipboard(), action: () => { void pasteFromClipboard(); } },
        { label: 'Clear selection', disabled: !options.editProperties, action: () => { void clearSelection(); } },
        { label: 'Delete', disabled: !options.deleteFiles, action: () => { const rows = result.groups[bounds.group].rows.slice(bounds.top, bounds.bottom + 1); void options.deleteFiles?.(rows).catch(report); } },
        { label: 'Select row', action: () => { range = { ...bounds, start: 0, end: result.properties.length - 1 }; paintRange(); } },
        { label: 'Select column', action: () => selectColumn(index) },
      ], cell);
    });
    cell.addEventListener('mouseover', event => { if (current() && (property === 'file.name' || property === 'file.file')) options.hoverFile?.(row, event); });
    if ((property === 'file.name' || property === 'file.file') && options.dragFile) { cell.draggable = true; cell.addEventListener('dragstart', event => { if (current()) options.dragFile?.(row, event); else event.preventDefault(); }); }
    return cell;
  }
  function renderRows() {
    if (destroyed) return;
    // Virtualized anchor replacement must dismiss its popover rather than leave an inert dialog.
    if (pickerAnchor && (body.contains(pickerAnchor) || footer.contains(pickerAnchor))) closePicker?.();
    // Keep an active draft mounted during scrolling. Its position stays in the virtual body.
    const activeRows = new Set<HTMLElement>();
    if (editing?.parentElement) activeRows.add(editing.parentElement);
    for (const draft of root.querySelectorAll<HTMLElement>('[data-base-editing]')) { const row = draft.closest<HTMLElement>('.zorid-bases-table-row'); if (row) activeRows.add(row); }
    for (const activeRow of activeRows) {
      activeRow.style.top = `${Number(activeRow.dataset.index) * rowHeight}px`;
      activeRow.style.height = `${rowHeight}px`;
      activeRow.style.gridTemplateColumns = template;
    }
    const focused = doc.activeElement as HTMLElement | null;
    const preserveFocus = focused?.getAttribute('role') === 'gridcell' && body.contains(focused);
    const focusedSummary = focused?.dataset.summaryProperty, focusedSummaryGroup = focused?.dataset.summaryGroup;
    const focusedGroup = focused && body.contains(focused) ? focused.dataset.groupButton : undefined;
    for (const child of Array.from(body.children)) if (!activeRows.has(child as HTMLElement)) { releaseRow(child); child.remove(); }
    const visible = Math.ceil((root.clientHeight || 600) / rowHeight);
    const start = Math.max(0, Math.floor(root.scrollTop / rowHeight) - 5), end = Math.min(items.length, start + visible + 10);
    for (let index = start; index < end; index++) {
      const item = items[index]; if ([...activeRows].some(row => row.dataset.index === String(index))) continue;
      const el = doc.createElement('div'); el.dataset.index = String(index); el.style.top = `${index * rowHeight}px`; el.style.height = `${rowHeight}px`;
      el.className = 'zorid-bases-table-row'; el.setAttribute('role', 'row'); el.setAttribute('aria-rowindex', String(index + 2));
      if (item.row) { el.style.gridTemplateColumns = template; result.properties.forEach((property, i) => el.append(renderCell(item.row!, property, i, { group: item.groupIndex, row: item.rowIndex, column: i }))); }
      else if ('summary' in item) {
        el.classList.add('zorid-bases-table-summary'); el.style.gridTemplateColumns = template;
        for (const property of result.properties) el.append(createSummaryCell(property, item.summary!));
      } else {
        el.classList.add('zorid-bases-table-group'); const button = doc.createElement('button'), group = result.groups[item.group], token = revision;
        const identity = groupIdentity(group);
        button.type = 'button'; button.dataset.groupButton = String(item.group); button.setAttribute('aria-expanded', String(!collapsed.has(identity)));
        button.textContent = `${collapsed.has(identity) ? '▸' : '▾'} ${group.key?.type === 'null' ? 'Empty' : display(group.key!, result.shared !== undefined)} (${group.rows.length})`;
        button.addEventListener('click', () => { if (destroyed || token !== revision || !body.contains(button) || hasActiveEdits()) return; collapsed.has(identity) ? collapsed.delete(identity) : collapsed.add(identity); rebuildItems(); range = undefined; anchor = undefined;
          if (selection && !items.some(item => item.row?.path === selection!.path)) {
            const first = items.find(item => item.row)?.row;
            selection = first && result.properties[0] ? { path: first.path, property: result.properties[0] } : undefined;
          }
          renderRows(); });
        el.append(button);
      }
      body.append(el);
    }
    renderFooter();
    paintRange();
    if (focusedGroup !== undefined) {
      const button = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-group-button]')).find(button => button.dataset.groupButton === focusedGroup);
      button?.focus({ preventScroll: true });
    }
    if (focusedSummary) for (const cell of body.querySelectorAll<HTMLElement>('[data-summary-property]')) if (cell.dataset.summaryProperty === focusedSummary && cell.dataset.summaryGroup === focusedSummaryGroup) cell.focus({ preventScroll: true });
    if (preserveFocus && !focusedSummary && selection) for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === selection.path && cell.dataset.property === selection.property && (!selection.point || cell.dataset.group === String(selection.point.group) && cell.dataset.row === String(selection.point.row))) { cell.focus({ preventScroll: true }); break; }
    }
  }
  function createSummaryCell(property: string, groupIndex: number | null): HTMLElement {
    const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-summary-cell'; cell.setAttribute('role', 'gridcell'); cell.dataset.summaryProperty = property; cell.dataset.summaryGroup = groupIndex === null ? 'overall' : String(groupIndex);
    const summary = options.getSummary?.(property, groupIndex);
    if (summary) { if (summary.label) { const name = doc.createElement('span'); name.className = 'summary-function-name'; name.textContent = summary.label; cell.append(name); cell.title = summary.label; } const value = doc.createElement('span'); value.className = 'summary-function-value'; value.textContent = display(summary.value, result.shared !== undefined); cell.append(value); }
    else { const placeholder = doc.createElement('span'); placeholder.className = 'placeholder'; placeholder.textContent = 'Summarize'; cell.append(placeholder); }
    if (options.requestSummary && (options.getSummaryOptions || options.summaryOptions?.length)) {
      cell.tabIndex = 0; const token = revision;
      const open = (event: MouseEvent) => { if (destroyed || token !== revision || hasActiveEdits() || !cell.isConnected) return; event.preventDefault(); showSummaryPicker(property, cell, groupIndex); };
      cell.addEventListener('click', open); cell.addEventListener('contextmenu', open);
      cell.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(new win!.MouseEvent('click')); } });
    }
    return cell;
  }
  function renderFooter() {
    const focused = footer.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.summaryProperty : undefined;
    footer.replaceChildren(); footer.style.height = `${Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-row-height') ?? '') || 30}px`;
    const visible = result.properties.some(property => options.getSummary?.(property, null));
    footer.hidden = !visible; root.setAttribute('aria-rowcount', String(items.length + 1 + (options.onNew ? 1 : 0) + (visible ? 1 : 0))); if (!visible) return;
    footer.setAttribute('aria-rowindex', String(items.length + 2 + (options.onNew ? 1 : 0)));
    for (const property of result.properties) footer.append(createSummaryCell(property, null));
    if (focused) for (const cell of footer.querySelectorAll<HTMLElement>('[data-summary-property]')) if (cell.dataset.summaryProperty === focused) cell.focus({ preventScroll: true });
  }
  function pointOf(cell: HTMLElement): CellPoint {
    return { group: Number(cell.dataset.group), row: Number(cell.dataset.row), column: Number(cell.dataset.column) };
  }
  function paintRange() {
    for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      const point = pointOf(cell), selected = !!range && point.group === range.group && point.row >= range.top && point.row <= range.bottom && point.column >= range.start && point.column <= range.end;
      cell.classList.toggle('is-selected', selected); cell.setAttribute('aria-selected', String(selected));
    }
  }
  function selectedBounds(): CellRange | undefined {
    if (range) return range;
    const point = selection?.point;
    return point ? cellBounds(point) : undefined;
  }
  function editableRaw(row: BaseQueryRow, property: string): BaseExpressionValue | undefined {
    const value = options.getEditableValue ? options.getEditableValue(row, property) : row.values[property] ?? BASE_NULL;
    if (value === undefined) return;
    try { rawProperty(value); return value; } catch { return; }
  }
  function rawProperty(value: BaseExpressionValue): BaseValue {
    let budget = 10000; const ancestors = new Set<object>();
    const raw = (value: BaseExpressionValue, depth = 0): BaseValue => {
      if (--budget < 0 || depth > 64 || ancestors.has(value)) throw new Error('The saved property is too large or cyclic.');
      ancestors.add(value);
      try {
        if (value.type === 'null') return null;
        if (value.type === 'string' && typeof value.value === 'string' || value.type === 'boolean' && typeof value.value === 'boolean') return value.value;
        if (value.type === 'number' && Number.isFinite(value.value)) return value.value;
        if (value.type === 'list' && Array.isArray(value.value)) return value.value.map(value => raw(value, depth + 1));
        if (value.type === 'object' && value.value && [Object.prototype, null].includes(Object.getPrototypeOf(value.value))) return Object.fromEntries(Object.keys(value.value).map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(value.value, key)!;
          if (!('value' in descriptor)) throw new Error('Saved properties cannot contain accessors.');
          return [key, raw(descriptor.value, depth + 1)];
        }));
        throw new Error('The raw saved property is unavailable.');
      } finally { ancestors.delete(value); }
    };
    return raw(value);
  }
  function selectionClipboard(): Record<string, string> | undefined {
    const bounds = selectedBounds(), group = bounds && result.groups[bounds.group];
    if (!bounds || !group || bounds.start < 0 || bounds.end >= result.properties.length) return;
    const properties = result.properties.slice(bounds.start, bounds.end + 1);
    const rows = group.rows.slice(bounds.top, bounds.bottom + 1).map(row => properties.map(property => {
      const value = row.values[property] ?? BASE_NULL;
      return value.type === 'null' || value.type === 'error' ? '' : display(value, result.shared !== undefined);
    }));
    if (!rows.length) return;
    const header = properties.map(property => options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, ''));
    const formats = tableClipboard(header, rows);
    formats['obsidian/bases-cells'] = JSON.stringify(group.rows.slice(bounds.top, bounds.bottom + 1).map(row => properties.map(property => {
      const derived = ['rollup', 'reverseRelation', 'reverse-relation'].includes(options.getPropertyType?.(property) ?? '');
      const type = property.startsWith('note.') && !derived ? 'note' : property.startsWith('formula.') || derived ? 'formula' : 'file';
      const saved = type === 'note' ? editableRaw(row, property) : undefined;
      return { type, ...(saved === undefined ? {} : { data: rawProperty(saved) }) };
    })));
    formats['text/html'] = baseTableClipboardHTML(doc, header, rows, formats['obsidian/bases-cells']);
    return formats;
  }
  function textOwnsClipboard(event: Pick<Event, 'target'>): boolean {
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea')) return true;
    // Inline Bases live inside a noneditable widget in CodeMirror's editable
    // document. The nearest valid keyword owns inheritance, including false.
    let editable = target?.closest?.('[contenteditable]');
    while (editable) {
      const keyword = editable.getAttribute('contenteditable')!.toLowerCase();
      if (keyword === 'false') break;
      if (keyword === '' || keyword === 'true' || keyword === 'plaintext-only') return true;
      editable = editable.parentElement?.closest('[contenteditable]');
    }
    const selected = doc.getSelection();
    return !!selected && !selected.isCollapsed && !!selected.anchorNode && root.contains(selected.anchorNode);
  }
  function canWriteClipboard(): boolean {
    const Item = win?.ClipboardItem;
    try { return typeof win?.navigator.clipboard?.write === 'function' && typeof Item === 'function'
      && (!Item.supports || Item.supports('text/html') && Item.supports('text/plain')); }
    catch { return false; }
  }
  function canReadClipboard(): boolean { return typeof win?.navigator.clipboard?.read === 'function'; }
  function clipboardOwner(): (() => boolean) | undefined {
    const token = revision, epoch = focusEpoch, bounds = JSON.stringify(selectedBounds()), owner = doc.activeElement;
    if (!selectedBounds() || !owner || !body.contains(owner) || textOwnsClipboard({ target: owner })) return;
    return () => !destroyed && token === revision && epoch === focusEpoch && owner.isConnected && doc.activeElement === owner
      && bounds === JSON.stringify(selectedBounds()) && !hasActiveEdits();
  }
  async function copySelection() {
    const current = clipboardOwner(); if (!current || !canWriteClipboard()) return;
    try {
      const data = selectionClipboard(); if (!data || !current()) return;
      const item = new win!.ClipboardItem({
        'text/plain': new win!.Blob([data['text/plain']], { type: 'text/plain' }),
        'text/html': new win!.Blob([data['text/html']], { type: 'text/html' }),
      });
      if (!current()) return;
      await win!.navigator.clipboard.write([item]);
    } catch (error) { if (current()) report(error); }
  }
  async function pasteFromClipboard() {
    const owned = clipboardOwner(); if (!owned || !canReadClipboard()) return;
    const current = () => owned() && !propertyAdmissionBlocked();
    const text = async (item: ClipboardItem, type: string): Promise<string | undefined> => {
      const blob = await item.getType(type); if (!current()) return;
      if (blob.size > BASE_TABLE_CLIPBOARD_LIMIT) throw new Error('The pasted table is too large.');
      const value = await blob.text(); if (!current()) return;
      if (value.length > BASE_TABLE_CLIPBOARD_LIMIT) throw new Error('The pasted table is too large.');
      return value;
    };
    try {
      if (!current()) return;
      const items = await win!.navigator.clipboard.read(); if (!current()) return;
      const item = items.find(item => item.types.includes('text/html') || item.types.includes('text/plain')); if (!item) return;
      const formats: Record<string, string> = {};
      if (item.types.includes('text/html')) {
        const html = await text(item, 'text/html'); if (html === undefined || !current()) return;
        const cells = baseTableCellsFromHTML(doc, html);
        if (cells !== undefined) formats['obsidian/bases-cells'] = cells;
      }
      // Only an absent own marker permits ordinary external text semantics.
      // A malformed own payload throws above instead of losing its raw types.
      if (!formats['obsidian/bases-cells'] && item.types.includes('text/plain')) {
        const plain = await text(item, 'text/plain'); if (plain === undefined || !current()) return;
        formats['text/plain'] = plain;
      }
      if (!current()) return;
      pasteValues({ getData: type => formats[type] ?? '' });
    } catch (error) { if (current()) report(error); }
  }
  function onCopy(event: ClipboardEvent) {
    if (destroyed || event.defaultPrevented || !event.clipboardData || hasActiveEdits() || textOwnsClipboard(event)) return;
    try {
      const formats = selectionClipboard(); if (!formats) return;
      for (const [type, text] of Object.entries(formats)) event.clipboardData.setData(type, text);
      event.preventDefault();
    } catch (error) { report(error); }
  }
  async function commitBatch(edits: readonly BaseTableEdit[]) {
    if (!edits.length || !options.editProperties || hasActiveEdits() || propertyAdmissionBlocked()) return;
    const token = revision; bulkPending = true; root.setAttribute('aria-busy', 'true'); options.onEditStateChange?.(true);
    try { await options.editProperties(edits); if (!destroyed && token === revision) status.textContent = ''; }
    catch (error) { if (!destroyed && token === revision) report(error); }
    finally { bulkPending = false; root.removeAttribute('aria-busy'); if (!destroyed) options.onEditStateChange?.(hasActiveEdits()); }
  }
  async function clearSelection() {
    const bounds = selectedBounds(); if (!bounds || hasActiveEdits() || propertyAdmissionBlocked() || !options.editProperties) return;
    const edits: BaseTableEdit[] = [];
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      const row = result.groups[bounds.group]?.rows[r]; if (!row) continue;
      for (let c = bounds.start; c <= bounds.end; c++) {
        const property = result.properties[c], value = row.values[property] ?? BASE_NULL;
        if (writableProperty(row, property) && value.type !== 'null') edits.push({ version: result.version, path: row.path, property, value: BASE_NULL });
      }
    }
    await commitBatch(edits);
  }
  function onPaste(event: ClipboardEvent) {
    if (destroyed || event.defaultPrevented || !event.clipboardData || !options.editProperties || hasActiveEdits() || propertyAdmissionBlocked() || textOwnsClipboard(event)) return;
    const bounds = selectedBounds(); if (!bounds) return;
    event.preventDefault();
    pasteValues(event.clipboardData);
  }
  function pasteValues(clipboard: Pick<DataTransfer, 'getData'>) {
    try {
      const bounds = selectedBounds(); if (!bounds || hasActiveEdits() || propertyAdmissionBlocked() || !options.editProperties) return;
      let rows: string[][], plainScalar: string | undefined, rawRows: { type: string; data?: unknown }[][] | undefined;
      const cells = clipboard.getData('obsidian/bases-cells') || baseTableCellsFromHTML(doc, clipboard.getData('text/html'));
      if (cells) {
        if (cells.length > 8_000_000) throw new Error('The pasted table is too large.');
        const parsed: unknown = JSON.parse(cells);
        if (!Array.isArray(parsed) || !parsed.length || parsed.some(row => !Array.isArray(row) || !row.length || row.some(cell => !cell || typeof cell !== 'object' || typeof cell.type !== 'string')) || parsed.some(row => row.length !== parsed[0].length)) throw new Error('Invalid Bases clipboard.');
        rawRows = parsed;
      }
      const table = clipboard.getData('obsidian/table');
      if (rawRows) rows = rawRows.map(row => row.map(cell => cell.type === 'note' ? String(cell.data ?? '') : ''));
      else if (table) {
        if (table.length > 8_000_000) throw new Error('The pasted table is too large.');
        const parsed: unknown = JSON.parse(table);
        if (!parsed || typeof parsed !== 'object' || !('rows' in parsed) || !Array.isArray(parsed.rows) || !parsed.rows.length || parsed.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))) throw new Error('Invalid table clipboard.');
        rows = parsed.rows;
        if (rows.some(row => row.length !== rows[0].length)) throw new Error('Paste a rectangular table.');
      } else {
        const text = clipboard.getData('text/plain');
        if (text.length > 8_000_000) throw new Error('The pasted table is too large.');
        // A newline is literal in a single active cell. It becomes a column only
        // when the user already selected several rows, matching Bases' reader.
        if (text.includes('\t') || (bounds.top < bounds.bottom && /[\r\n]/.test(text))) rows = parseBaseTableTSV(text);
        else { if (!text) return; plainScalar = text; rows = [[text]]; }
      }
      if (rows.length > 100_000 || (rows[0]?.length ?? 0) > 10_000) throw new Error('The pasted table is too large.');
      const sourceHeight = rows.length, sourceWidth = rows[0]?.length ?? 0;
      if (!sourceWidth) return;
      const group = result.groups[bounds.group]; if (!group) return;
      const height = Math.max(bounds.bottom - bounds.top + 1, sourceHeight), width = Math.max(bounds.end - bounds.start + 1, sourceWidth);
      const bottom = Math.min(group.rows.length - 1, bounds.top + height - 1), end = Math.min(result.properties.length - 1, bounds.start + width - 1);
      const edits: BaseTableEdit[] = [];
      for (let r = bounds.top; r <= bottom; r++) {
        const row = group.rows[r], sourceRow = sourceHeight === 1 ? 0 : r - bounds.top;
        if (sourceRow >= sourceHeight) continue;
        for (let c = bounds.start; c <= end; c++) {
          const property = result.properties[c], current = row.values[property] ?? BASE_NULL;
          if (!writableProperty(row, property)) continue;
          const sourceColumn = sourceWidth === 1 ? 0 : c - bounds.start;
          if (sourceColumn >= sourceWidth) continue;
          const raw = rows[sourceRow][sourceColumn], rawCell = rawRows?.[sourceRow]?.[sourceColumn];
          if (rawCell && (rawCell.type !== 'note' || !Object.hasOwn(rawCell, 'data'))) continue;
          const saved = plainScalar !== undefined ? editableRaw(row, property) : undefined;
          if (plainScalar !== undefined && current.type === 'list' && saved === undefined) throw new Error('The raw saved property is unavailable; refresh before appending.');
          // Clipboard values remain raw: the reference does not coerce pasted
          // strings into numbers/booleans. Only a plain scalar appends to lists.
          const value: BaseExpressionValue = rawCell ? baseExpressionValue(rawCell.data)
            : plainScalar !== undefined && saved?.type === 'list' ? { type: 'list', value: [...saved.value, { type: 'string', value: plainScalar }] }
            : { type: 'string', value: raw };
          edits.push({ version: result.version, path: row.path, property, value: options.validatePropertyValue?.(value, property, row) ?? value });
        }
      }
      range = { group: bounds.group, top: bounds.top, bottom, start: bounds.start, end }; paintRange();
      // Complete validation precedes the host command. The host owns CAS, undo and partial failure reporting.
      void commitBatch(edits);
    } catch (error) { report(error); }
  }
  function onHistory(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || hasActiveEdits() || textOwnsClipboard(event) || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase(), callback = key === 'z' ? event.shiftKey ? options.redo : options.undo : key === 'y' ? options.redo : undefined;
    if (!callback) return;
    event.preventDefault(); Promise.resolve().then(callback).catch(report);
  }
  function protectRangeClick(event: MouseEvent) {
    const target = event.target as Element | null, cell = target?.closest<HTMLElement>('[role="gridcell"][data-path]');
    if (!cell || !body.contains(cell)) return;
    const writableTarget = cell.dataset.property?.startsWith('note.') || options.renameFile && (cell.dataset.property === 'file.name' || cell.dataset.property === 'file.file');
    if ((propertyAdmissionBlocked() || hasActiveEdits()) && writableTarget && !cell.hasAttribute('data-base-editing') && !cell.querySelector('[data-base-editing]') && (!target?.closest('a,[role=link]') || options.renameFile)) {
      blockedActivation = { cell, event, open: !!target?.closest('.zorid-bases-table-open'), title: !!target?.closest('.zorid-bases-table-title'), checkbox: !!target?.closest('input[type="checkbox"]') };
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!hasActiveEdits()) {
      editFocusEpochs.set(cell, focusEpoch); blockedActivation = undefined;
      if (event.type === 'click' && !event.shiftKey) { range = undefined; anchor = undefined; cell.focus({ preventScroll: true }); paintRange(); }
    }
    // Property widgets install their own target listeners before table handlers.
    // A selection gesture must reach table navigation without opening a widget.
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !editing && !cell.hasAttribute('data-base-editing')) event.preventDefault();
  }
  function onEditFocus(event: FocusEvent) {
    const target = event.target as Element | null, cell = target?.closest<HTMLElement>('[role="gridcell"][data-path]');
    if (cell && body.contains(cell)) {
      editFocusEpochs.set(cell, focusEpoch);
      if (cell.hasAttribute('data-base-editing') || cell.querySelector('[data-base-editing]')) blockedActivation = undefined;
    }
  }
  function onDocumentPointerDown(event: PointerEvent) {
    const target = event.target as Node | null;
    if (!target) return;
    if (root.contains(target)) {
      const cell = (target as Element).closest?.('[role="gridcell"][data-path]');
      if (cell?.hasAttribute('data-base-editing') || cell?.querySelector('[data-base-editing]')) blockedActivation = undefined;
      return;
    }
    const owner = basePropertyPopoverOwner(target);
    if (owner && root.contains(owner)) return;
    focusEpoch++; blockedActivation = undefined;
  }
  function onWindowBlur() { focusEpoch++; blockedActivation = undefined; }
  function canRetryCheckboxSpace(event: KeyboardEvent, cell: HTMLElement | null): boolean {
    if (event.key !== ' ' || event.repeat || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.getModifierState('AltGraph') || !cell || cell.getAttribute('role') !== 'gridcell' || !body.contains(cell) || cell.dataset.baseEditing !== 'draft' || range || destroyed || editing || bulkPending || configPending || newPending || resizeCommands.length || awaitingConfigurationResult || options.isConfigurationClosing?.()) return false;
    const owner = cellOwners.get(cell);
    if (!owner || !currentOwner(owner) || !cell.querySelector<HTMLInputElement>('input.metadata-input-checkbox[type="checkbox"]:not(:disabled)')) return false;
    if ([...root.querySelectorAll('[data-base-editing]')].some(draft => draft !== cell)) return false;
    return options.canRetryPropertyEdit ? options.canRetryPropertyEdit() : options.canBeginPropertyEdit?.() !== false;
  }
  function protectRangeKey(event: KeyboardEvent) {
    const cell = event.target as HTMLElement | null;
    const startsEdit = ['Enter', 'F2'].includes(event.key) || printableEditKey(event);
    if (!event.isComposing && (['Enter', 'Tab', 'Escape'].includes(event.key) && cell?.closest('[data-base-editing]') || ['Enter', 'F2'].includes(event.key) && !hasActiveEdits())) blockedActivation = undefined;
    if (!event.isComposing && (propertyAdmissionBlocked() || hasActiveEdits()) && cell?.getAttribute('role') === 'gridcell' && body.contains(cell) && (startsEdit || ['Delete', 'Backspace'].includes(event.key)) && !canRetryCheckboxSpace(event, cell)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!event.isComposing && range && cell?.getAttribute('role') === 'gridcell' && body.contains(cell) && startsEdit) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  function onPointerDown(event: PointerEvent) {
    if (destroyed || hasActiveEdits() || event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
    suppressClick = false;
    const target = event.target as Element, cell = target.closest<HTMLElement>('[role="gridcell"]');
    if (!cell || !cell.dataset.path || !body.contains(cell) || ((!event.shiftKey || event.metaKey || event.ctrlKey) && target.closest('a,textarea,input:not([type="checkbox"]),[draggable="true"]'))) return;
    stopDrag?.(); suppressClick = false;
    const start = pointOf(cell), token = revision;
    if (event.shiftKey && selection?.point?.group === start.group) {
      anchor = selection.point; range = cellBounds(anchor, start); event.preventDefault();
    } else {
      anchor = start; range = undefined;
      selection = { path: cell.dataset.path!, property: cell.dataset.property!, point: start };
      cell.focus({ preventScroll: true });
    }
    paintRange();
    const dragAnchor = anchor;
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (destroyed || token !== revision || moveEvent.pointerId !== event.pointerId) return;
      const hit = doc.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY) ?? moveEvent.target as Element | null;
      const candidate = hit && typeof hit.closest === 'function' ? hit.closest<HTMLElement>('[role="gridcell"]') : null;
      if (!candidate || !body.contains(candidate)) return;
      const point = pointOf(candidate);
      if (point.group !== dragAnchor.group) return;
      if (!moved && point.row === start.row && point.column === start.column) return;
      if (!moved) doc.getSelection()?.removeAllRanges();
      moved = true; suppressClick = true; range = cellBounds(dragAnchor, point);
      paintRange(); moveEvent.preventDefault();
    };
    const finish = (end: PointerEvent) => { if (end.pointerId === event.pointerId) { if (end.type === 'pointercancel') suppressClick = false; stopDrag?.(); } };
    const blur = () => { suppressClick = false; stopDrag?.(); };
    stopDrag = () => { win?.removeEventListener('blur', blur); win?.removeEventListener('pointermove', move); win?.removeEventListener('pointerup', finish); win?.removeEventListener('pointercancel', finish); stopDrag = undefined; };
    win?.addEventListener('blur', blur); win?.addEventListener('pointermove', move); win?.addEventListener('pointerup', finish); win?.addEventListener('pointercancel', finish);
  }
  let reportedEditState = false;
  const editObserver = win?.MutationObserver ? new win.MutationObserver(() => {
    if (destroyed) return;
    const active = hasActiveEdits();
    if (active !== reportedEditState) { reportedEditState = active; try { options.onEditStateChange?.(active); } catch (error) { report(error); } }
    if (!active) scheduleResizeCommands();
  }) : undefined;
  editObserver?.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-base-editing'] });
  root.addEventListener('click', protectRangeClick, true); root.addEventListener('dblclick', protectRangeClick, true); root.addEventListener('keydown', protectRangeKey, true);
  root.addEventListener('copy', onCopy);
  root.addEventListener('paste', onPaste); root.addEventListener('keydown', onHistory);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('focusin', onEditFocus);
  doc.addEventListener('pointerdown', onDocumentPointerDown, true);
  win?.addEventListener('blur', onWindowBlur);
  function schedule() { if (frame === undefined && win) frame = win.requestAnimationFrame(() => { frame = undefined; renderRows(); }); }
  root.addEventListener('scroll', schedule);
  const resize = win && 'ResizeObserver' in win ? new win.ResizeObserver(() => { dimensions(); rebuildItems(); schedule(); }) : undefined;
  resize?.observe(root);
  function update(next: BaseQueryResult) {
    if (destroyed || (initialized && next === result)) return;
    const selectedEntryId = selection && result.rows.find(row => row.path === selection!.path)?.entryId;
    const entryId = options.getConfigurationIdentity?.();
    const nextCollapseContext = collapseContext(next, entryId);
    if (!sameConfigurationValue(collapsedContext, nextCollapseContext)) collapsed.clear();
    collapsedContext = nextCollapseContext;
    const groupIdentities = new Set(next.groups.map(groupIdentity));
    for (const identity of collapsed) if (!groupIdentities.has(identity)) collapsed.delete(identity);
    if (initialized && (next.view.name !== result.view.name || next.view.type !== result.view.type || entryId !== configurationEntryId)) configurationScope++;
    configurationEntryId = entryId;
    for (const command of resizeCommands) if (!next.properties.includes(command.property)) command.retired = true;
    const configurationConflict = reconcileConfigurationAcknowledgement(next);
    // Query/save acknowledgements rebuild headers too. Retain the user's live
    // keyboard target by property, rather than its previous column position.
    const focusedHeader = initialized && next.view.name === result.view.name && next.view.type === result.view.type && header.contains(doc.activeElement) ? doc.activeElement as HTMLElement : undefined;
    const focusedColumn = focusedHeader?.closest<HTMLElement>('[role="columnheader"]');
    const headerFocus = focusedColumn && (focusedHeader === focusedColumn || focusedHeader?.getAttribute('role') === 'separator') ? { property: focusedColumn.dataset.property!, separator: focusedHeader !== focusedColumn } : undefined;
    const cancelledDraft = !!editing;
    initialized = true; revision++; stopRename?.(); stopDrag?.(); stopResize?.(); closeMenu?.(); closePicker?.(); draggedColumn = undefined; resizeWidths.clear(); measuredWidths.clear(); for (const cell of [...widgetDisposers.keys()]) releaseCell(cell); for (const cell of root.querySelectorAll('[data-base-editing]')) cell.removeAttribute('data-base-editing'); range = undefined; anchor = undefined; if (selection) selection.point = undefined; editing = undefined; result = next;
    status.textContent = cancelledDraft ? 'Results changed. The unfinished edit was cancelled.' : '';
    root.dataset.baseRenderedVersion = String(result.version);
    root.setAttribute('aria-label', result.view.name);
    if (selection && selectedEntryId) {
      const selectedRow = result.rows.find(row => row.entryId === selectedEntryId);
      if (selectedRow) selection.path = selectedRow.path;
    }
    if (!selection || !result.rows.some(row => row.path === selection!.path) || !result.properties.includes(selection.property)) selection = result.rows[0] && result.properties[0] ? { path: result.rows[0].path, property: result.properties[0] } : undefined;
    dimensions(); rebuildItems();
    let selectedItem = items.find(item => item.row?.path === selection?.path);
    // A saved edit may move the selected row into a retained collapsed group.
    // Keep keyboard entry on visible rows without expanding or moving outside focus.
    if (selection && !selectedItem?.row) {
      selectedItem = items.find(item => item.row);
      if (selectedItem?.row) selection.path = selectedItem.row.path;
    }
    if (selection && selectedItem?.row) selection.point = { group: selectedItem.groupIndex, row: selectedItem.rowIndex, column: result.properties.indexOf(selection.property) };
    // Disposal/host callbacks may have deliberately moved focus outside. Only
    // replace a target that was still focused immediately before its removal.
    const retainHeaderFocus = headerFocus && doc.activeElement === focusedHeader;
    renderHeader(); renderRows();
    if (retainHeaderFocus && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)) {
      const column = Array.from(header.querySelectorAll<HTMLElement>('[role="columnheader"]')).find(cell => cell.dataset.property === headerFocus.property);
      const target = headerFocus.separator ? column?.querySelector<HTMLElement>('[role="separator"]') : column;
      target?.focus({ preventScroll: true });
    }
    if (!result.rows.length) status.textContent += `${status.textContent ? ' ' : ''}No results`;
    if (configurationConflict) reportConfigurationConflict();
    scheduleResizeCommands();
  }
  update(result);
  return { canCaptureRawDraft:()=>rawEditor?.canCapture()===true,captureRawDraft:()=>rawEditor?.capture(),restoreRawDraft,rawPropertyElement,editFileTitle, completePropertyEdit, openSummaryPicker(property, anchor, groupIndex = null) {
    if (destroyed || !root.isConnected || !result.properties.includes(property)) return;
    const origin = summaryOrigins.get(anchor);
    if (!origin || origin.property !== property || origin.scope !== configurationScope || origin.overall !== (groupIndex === null)) return;
    const scope = groupIndex === null ? 'overall' : String(groupIndex);
    const replacement = [...root.querySelectorAll<HTMLElement>('[data-summary-property]')].find(cell => cell.dataset.summaryProperty === property && cell.dataset.summaryGroup === scope);
    const headerCell = header.children[result.properties.indexOf(property)] as HTMLElement | undefined;
    // Overall editor returns use the current property header. Unlike footer
    // cells, that anchor survives an already queued row paint. Query updates
    // still invalidate its picker by revision; group anchors remain virtual.
    const target = groupIndex === null ? headerCell : anchor.isConnected && root.contains(anchor) ? anchor : replacement ?? headerCell;
    if (target) showSummaryPicker(property, target, groupIndex);
  }, update, dismissCleanPanels() { closeMenu?.(); closePicker?.(); }, refreshLayout() { if (!destroyed) { dimensions(); rebuildItems(); renderRows(); } }, hasActiveEdits, hasQueuedConfiguration: () => !destroyed && !!resizeCommands.length, destroy() { if (destroyed) return; destroyed = true; stopRename?.(); resizeCommands.length = 0; awaitingConfigurationResult = undefined; revision++; stopDrag?.(); stopResize?.(); closeMenu?.(); closePicker?.(); draggedColumn = undefined; editObserver?.disconnect(); for (const cell of [...widgetDisposers.keys()]) releaseCell(cell); root.removeEventListener('click', protectRangeClick, true); root.removeEventListener('dblclick', protectRangeClick, true); root.removeEventListener('keydown', protectRangeKey, true); root.removeEventListener('paste', onPaste); root.removeEventListener('keydown', onHistory); root.removeEventListener('copy', onCopy); root.removeEventListener('pointerdown', onPointerDown); root.removeEventListener('focusin', onEditFocus); doc.removeEventListener('pointerdown', onDocumentPointerDown, true); win?.removeEventListener('blur', onWindowBlur); blockedActivation = undefined; editing = undefined; if (frame !== undefined) win?.cancelAnimationFrame(frame); resize?.disconnect(); root.removeEventListener('scroll', schedule); root.remove(); status.remove(); } };
}
