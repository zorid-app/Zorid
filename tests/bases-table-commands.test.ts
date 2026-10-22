import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableEdit } from '../src/bases/table-view.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';
import { parseBaseTableTSV } from '../src/bases/table-clipboard.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}) {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true });
  const main = dom.window.document.querySelector('main')!;
  const rows = [0, 1, 2].map(i => ({ path: `${i}.md`, values: { 'file.name': { type: 'string' as const, value: String(i) }, 'note.text': { type: 'string' as const, value: `Text ${i}` }, 'note.score': { type: 'number' as const, value: i } } }));
  const result: BaseQueryResult = { version: 7, view: { type: 'table', name: 'Table', columnSize: { 'note.score': 170 } }, rows, groups: [{ key: null, rows }], properties: ['file.name', 'note.text', 'note.score'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 3, matched: 3, afterGroupOrder: 3, afterSearch: 3, returned: 3 } };
  const batches: readonly BaseTableEdit[][] = []; const writes = batches as BaseTableEdit[][];
  const patches: unknown[] = [];
  const view = createBaseTableView(main, { result, openFile() {}, editProperty: async () => {}, editProperties: async edits => { writes.push([...edits]); }, patchView: async patch => { patches.push(patch); }, ...extra });
  const cell = (row: number, property: string) => main.querySelector<HTMLElement>(`[data-path="${row}.md"][data-property="${property}"]`)!;
  const key = (element: Element, key: string, extra: KeyboardEventInit = {}) => { const e = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); element.dispatchEvent(e); return e; };
  const paste = (element: Element, values: Record<string, string>) => { const e = new dom.window.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'clipboardData', { value: { getData: (type: string) => values[type] ?? '' } }); element.dispatchEvent(e); return e; };
  const menu = (element: Element) => { element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]; };
  return { dom, main, view, result, batches, patches, cell, key, paste, menu, close() { view.destroy(); dom.window.close(); } };
}

test('TSV reads quoted rectangles without destroying tabs, line breaks or final empty cells', () => {
  assert.deepEqual(parseBaseTableTSV('"a\tb"\t"c""d"\r\n"first\nlast"\t'), [['a\tb', 'c"d'], ['first\nlast', '']]);
  assert.deepEqual(parseBaseTableTSV('a\tb\n'), [['a', 'b']]);
  assert.throws(() => parseBaseTableTSV('a\tb\nc'), /rectangular/);
  assert.throws(() => parseBaseTableTSV('"unfinished'), /Unclosed/);
});

test('paste validates complete rectangle before one host batch and leaves file cells read-only', async () => {
  const f = fixture(); f.cell(0, 'file.name').focus();
  f.paste(f.cell(0, 'file.name'), { 'text/plain': 'ignored\tChanged\t12\nignored\tOther\t13' }); await tick();
  assert.deepEqual(f.batches[0], [
    { version: 7, path: '0.md', property: 'note.text', value: { type: 'string', value: 'Changed' } },
    { version: 7, path: '0.md', property: 'note.score', value: { type: 'string', value: '12' } },
    { version: 7, path: '1.md', property: 'note.text', value: { type: 'string', value: 'Other' } },
    { version: 7, path: '1.md', property: 'note.score', value: { type: 'string', value: '13' } },
  ]);
  f.paste(f.cell(0, 'file.name'), { 'text/plain': 'ignored\tGood\t12\nignored\tBad\tinvalid' }); await tick();
  assert.equal(f.batches.length, 2); assert.deepEqual(f.batches[1].at(-1)!.value, {type:'string',value:'invalid'}); f.close();
});

test('selected rectangle broadcasts a single pasted value and clear skips file properties', async () => {
  const f = fixture(); f.cell(0, 'note.text').focus(); f.key(f.cell(0, 'note.text'), 'ArrowDown', { shiftKey: true });
  f.paste(f.cell(1, 'note.text'), { 'text/plain': 'Same' }); await tick();
  assert.equal(f.batches[0].length, 2); assert.ok(f.batches[0].every(e => e.value.type === 'string' && e.value.value === 'Same'));
  f.key(f.cell(1, 'note.text'), 'a', { metaKey: true }); f.key(f.cell(1, 'note.text'), 'Delete'); await tick();
  assert.equal(f.batches[1].length, 6); assert.ok(f.batches[1].every(e => e.property.startsWith('note.') && e.value.type === 'null')); f.close();
});

test('compatible raw Bases clipboard preserves lists and excludes formula/file source cells', async () => {
  const f = fixture(); f.cell(0, 'note.text').focus();
  f.paste(f.cell(0, 'note.text'), { 'obsidian/bases-cells': JSON.stringify([[{ type: 'note', data: ['One', 'Two'] }, { type: 'formula' }]]) }); await tick();
  assert.deepEqual(f.batches[0], [{ version: 7, path: '0.md', property: 'note.text', value: { type: 'list', value: [{ type: 'string', value: 'One' }, { type: 'string', value: 'Two' }] } }]); f.close();
});

test('pending batch blocks duplicate paste/clear; rejected host batch reports actual failure', async () => {
  let reject!: (error: Error) => void; let calls = 0;
  const f = fixture({ editProperties: async () => { calls++; await new Promise<void>((_, fail) => { reject = fail; }); } });
  f.cell(0, 'note.text').focus(); f.paste(f.cell(0, 'note.text'), { 'text/plain': 'one' });
  assert.equal(f.view.hasActiveEdits(), true); f.paste(f.cell(0, 'note.text'), { 'text/plain': 'two' }); f.key(f.cell(0, 'note.text'), 'Delete');
  assert.equal(calls, 1); reject(new Error('1 of 2 changes saved; retry remaining file.')); await tick();
  assert.equal(f.view.hasActiveEdits(), false); assert.match(f.main.textContent!, /1 of 2 changes saved/); f.close();
});

test('text inputs own paste, undo and composition while table history routes through host', async () => {
  let undo = 0, redo = 0;
  const f = fixture({ undo: () => { undo++; }, redo: () => { redo++; } }); f.cell(0, 'note.text').focus();
  f.key(f.cell(0, 'note.text'), 'z', { metaKey: true }); f.key(f.cell(0, 'note.text'), 'z', { metaKey: true, shiftKey: true }); await tick(); assert.equal(undo, 1); assert.equal(redo, 1);
  f.key(f.cell(0, 'note.text'), 'Enter'); const input = f.cell(0, 'note.text').querySelector('input')!;
  assert.equal(f.paste(input, { 'text/plain': 'native' }).defaultPrevented, false); f.key(input, 'z', { metaKey: true }); await tick(); assert.equal(undo, 1); f.close();
});

test('header click toggles sort; context menu uses reference actions and stale menu actions cannot save', async () => {
  const f = fixture({ requestEditProperty() {}, summaryOptions: [{ id: 'Sum', label: 'Sum' }], requestSummary() {} });
  const header = f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[1]; header.click(); await tick();
  assert.deepEqual(f.patches[0], { sort: [{ property: 'note.text', direction: 'ASC' }] });
  const menu = f.menu(header); assert.deepEqual(menu.map(item => item.textContent), ['Hide column', 'Summarize...', 'Group by this property', 'Sort A → Z', 'Sort Z → A', 'Edit property...', 'Property type']);
  f.view.update({ ...f.result, version: 8 }); menu[0].click(); await tick(); assert.equal(f.patches.length, 1); f.close();
});

test('resizer keyboard persists width and double-click resets custom width', async () => {
  const f = fixture(); const resize = f.main.querySelectorAll<HTMLElement>('[role=separator]')[2];
  f.key(resize, 'ArrowRight'); await tick(); assert.deepEqual(f.patches[0], { columnSize: { 'note.score': 180 } });
  f.view.update({ ...f.result, version: 8, view: { ...f.result.view, columnSize: { 'note.score': 180 } } });
  f.main.querySelectorAll<HTMLElement>('[role=separator]')[2].dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); await tick(); assert.deepEqual(f.patches[1], { columnSize: {} }); f.close();
});

test('summary footer displays host-computed overall values without aggregating visible rows', () => {
  const f = fixture({ getSummary: (property, group) => property === 'note.score' && group === null ? { value: { type: 'number', value: 123456 }, label: 'Sum' } : undefined });
  const footer = f.main.querySelector('.zorid-bases-table-footer')!;
  assert.equal(footer.querySelector('[data-summary-property="note.score"]')!.textContent, 'Sum123456'); assert.equal(footer.querySelector('[data-summary-property="note.score"]')!.getAttribute('title'), 'Sum'); f.close();
});

test('rich widget drafts stay mounted across scrolling and every acquired widget disposes once', async () => {
  let mounted = 0, disposed = 0;
  const f = fixture({ renderProperty(element) { mounted++; const button = element.ownerDocument.createElement('button'); button.textContent = 'Edit'; button.addEventListener('click', () => { element.dataset.baseEditing = 'draft'; }); element.append(button); return () => { disposed++; }; } });
  const cell = f.cell(0, 'note.text'); cell.querySelector('button')!.click(); assert.equal(f.view.hasActiveEdits(), true);
  f.view.refreshLayout(); assert.equal(cell.isConnected, true); assert.equal(f.view.hasActiveEdits(), true);
  f.view.destroy(); assert.equal(disposed, mounted); f.dom.window.close();
});


test('header sort cycles ascending, descending and unsorted while retaining other criteria', async () => {
  const f = fixture();
  for (const [direction, expected] of [['ASC', 'DESC'], ['DESC', undefined]] as const) {
    f.view.update({ ...f.result, version: direction, view: { ...f.result.view, sort: [{ property: 'note.text', direction }, { property: 'note.score', direction: 'DESC' }] } });
    f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[1].click(); await tick();
    assert.deepEqual(f.patches.at(-1), { sort: [...(expected ? [{ property: 'note.text', direction: expected }] : []), { property: 'note.score', direction: 'DESC' }] });
  }
  f.close();
});

test('header drag drops on either side and destroy leaves retained drag callbacks inert', async () => {
  const f = fixture(); const headers = [...f.main.querySelectorAll<HTMLElement>('[role=columnheader]')];
  Object.defineProperty(headers[1], 'getBoundingClientRect', { value: () => ({ left: 100, width: 100 }) });
  headers[0].dispatchEvent(new f.dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true }));
  headers[1].dispatchEvent(new f.dom.window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 190 })); await tick();
  assert.deepEqual(f.patches[0], { order: ['note.text', 'file.name', 'note.score'] });
  f.view.destroy(); headers[0].dispatchEvent(new f.dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true })); headers[1].dispatchEvent(new f.dom.window.MouseEvent('drop', { bubbles: true, cancelable: true })); await tick(); assert.equal(f.patches.length, 1); f.dom.window.close();
});


test('refresh invalidates an active column drag instead of reintroducing its removed property', async () => {
  const f = fixture(); const header = f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[1];
  header.dispatchEvent(new f.dom.window.MouseEvent('dragstart', { bubbles: true, cancelable: true }));
  f.view.update({ ...f.result, version: 8, properties: ['file.name', 'note.score'] });
  f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[1].dispatchEvent(new f.dom.window.MouseEvent('drop', { bubbles: true, cancelable: true })); await tick();
  assert.equal(f.patches.length, 0); f.close();
});

test('derived property definitions remain read-only under clear and every clipboard format', async () => {
  for (const type of ['rollup', 'reverseRelation']) {
    const f = fixture({ getPropertyType: property => property === 'note.score' ? type : 'text', renderProperty() {} });
    const cell = f.cell(0, 'note.score'); cell.focus(); assert.equal(cell.getAttribute('aria-readonly'), 'true');
    f.key(cell, 'Delete'); f.paste(cell, { 'text/plain': '3' }); f.paste(cell, { 'obsidian/bases-cells': JSON.stringify([[{ type: 'note', data: 3 }]]) }); await tick();
    assert.equal(f.batches.length, 0); f.close();
  }
});

test('raw clipboard passes shared definition validation before any host write', async () => {
  const f = fixture({ validatePropertyValue(value) { if (value.type !== 'string') throw new Error('This property requires text.'); return value; } });
  f.cell(0, 'note.text').focus(); f.paste(f.cell(0, 'note.text'), { 'obsidian/bases-cells': JSON.stringify([[{ type: 'note', data: 7 }]]) }); await tick();
  assert.equal(f.batches.length, 0); assert.match(f.main.textContent!, /requires text/); f.close();
});

test('summary picker searches Rust previews, applies selection and ignores stale async options', async () => {
  const selected: string[] = []; let resolve!: (value: {id:string;label:string;preview:{type:'number';value:number}}[]) => void;
  const f = fixture({ getSummaryOptions: async () => new Promise(done => { resolve = done; }), requestSummary: (_, id) => { selected.push(id); }, requestAddSummary() {} });
  f.menu(f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[2]).find(button => button.textContent === 'Summarize...')!.click(); await tick();
  assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]')!.textContent!.includes('Loading'), true);
  resolve([{ id: 'Sum', label: 'Sum', preview: { type: 'number', value: 12345 } }, { id: 'Average', label: 'Average', preview: { type: 'number', value: 4115 } }]); await tick();
  const input = f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Find or create summary"]')!; input.value = 'sum'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const option = f.dom.window.document.querySelector<HTMLElement>('[role=option]')!; assert.match(option.textContent!, /Sum12345/); f.key(input, 'Enter'); await tick(); assert.deepEqual(selected, ['Sum']);
  f.menu(f.main.querySelectorAll<HTMLElement>('[role=columnheader]')[2]).find(button => button.textContent === 'Summarize...')!.click(); await tick(); f.view.update({ ...f.result, version: 8 }); resolve([{ id: 'Old', label: 'Old', preview: { type: 'number', value: 1 } }]); await tick(); assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]'), null); f.close();
});


test('oversized clipboard rectangles clamp to existing group rows and visible properties', async () => {
  const f = fixture(); f.cell(1, 'note.score').focus();
  f.paste(f.cell(1, 'note.score'), { 'text/plain': 'A\tunused\nB\tunused\nC\tunused' }); await tick();
  assert.deepEqual(f.batches[0], [
    {version:7,path:'1.md',property:'note.score',value:{type:'string',value:'A'}},
    {version:7,path:'2.md',property:'note.score',value:{type:'string',value:'B'}},
  ]); f.close();
});

test('plain scalar appends literally to lists while table and raw clipboard replace them', async () => {
  const f = fixture(); const rows = f.result.rows.map(row => ({...row, values: {...row.values,'note.text':{type:'list' as const,value:[{type:'string' as const,value:'existing'}]}}}));
  f.view.update({...f.result,version:8,rows,groups:[{key:null,rows}]}); f.cell(0,'note.text').focus();
  f.paste(f.cell(0,'note.text'), {'text/plain':'new'}); await tick();
  assert.deepEqual(f.batches[0][0].value,{type:'list',value:[{type:'string',value:'existing'},{type:'string',value:'new'}]});
  f.paste(f.cell(0,'note.text'), {'obsidian/table':JSON.stringify({rows:[['replacement']]})}); await tick();
  assert.deepEqual(f.batches[1][0].value,{type:'string',value:'replacement'});
  f.paste(f.cell(0,'note.text'), {'obsidian/bases-cells':JSON.stringify([[{type:'note',data:['raw']} ]])}); await tick();
  assert.deepEqual(f.batches[2][0].value,{type:'list',value:[{type:'string',value:'raw'}]}); f.close();
});

test('newline text stays scalar in one active cell and becomes a column across multiple selected rows', async () => {
  const f=fixture();f.cell(0,'note.text').focus();f.paste(f.cell(0,'note.text'),{'text/plain':'first\nsecond'});await tick();
  assert.deepEqual(f.batches[0],[{version:7,path:'0.md',property:'note.text',value:{type:'string',value:'first\nsecond'}}]);
  f.key(f.cell(0,'note.text'),'Escape');f.key(f.cell(0,'note.text'),'ArrowDown',{shiftKey:true});f.paste(f.cell(1,'note.text'),{'text/plain':'first\nsecond'});await tick();
  assert.deepEqual(f.batches[1].map(edit=>edit.value),[{type:'string',value:'first'},{type:'string',value:'second'}]);f.close();
});

test('multirow clipboard fills available source rows once while a single source row broadcasts', async () => {
  const f=fixture();f.cell(0,'note.text').focus();f.key(f.cell(0,'note.text'),'a',{metaKey:true});
  f.paste(f.cell(0,'note.text'),{'obsidian/table':JSON.stringify({rows:[['first'],['second']]})});await tick();
  assert.equal(f.batches[0].length,4);assert.ok(f.batches[0].every(edit=>edit.path!=='2.md'));
  f.paste(f.cell(0,'note.text'),{'obsidian/table':JSON.stringify({rows:[['repeat']]})});await tick();assert.equal(f.batches[1].length,6);f.close();
});


test('every clamped writable mutation validates before a batch starts', async () => {
  const f=fixture({ validatePropertyValue(value) { if (value.type==='string'&&value.value==='blocked') throw new Error('The last target is unavailable.'); return value; } });
  f.cell(0,'note.text').focus();f.paste(f.cell(0,'note.text'),{'text/plain':'first\tsecond\nthird\tblocked'});await tick();
  assert.equal(f.batches.length,0);assert.match(f.main.textContent!,/last target is unavailable/);f.close();
});


test('plain scalar paste retains the clipboard resource bound before allocating a command', async () => {
  const f=fixture();f.cell(0,'note.text').focus();f.paste(f.cell(0,'note.text'),{'text/plain':'x'.repeat(8_000_001)});await tick();
  assert.equal(f.batches.length,0);assert.match(f.main.textContent!,/pasted table is too large/);f.close();
});


test('shared rich renderer presents computed values read-only and retains native file opening', async () => {
  const seen:string[]=[], f=fixture({renderProperty(element,presentation){seen.push(presentation.property);element.textContent=`Rich ${presentation.property}`;}});
  const rows=f.result.rows.map(row=>({...row,values:{...row.values,'formula.cover':{type:'string' as const,value:'rich output'},'file.tags':{type:'list' as const,value:[]}}}));
  f.view.update({...f.result,version:8,rows,groups:[{key:null,rows}],properties:['file.name','note.text','formula.cover','file.tags']});
  const formula=f.cell(0,'formula.cover');assert.equal(formula.textContent,'Rich formula.cover');assert.equal(formula.getAttribute('aria-readonly'),'true');
  assert.ok(seen.includes('formula.cover'));assert.ok(seen.includes('file.tags'));assert.ok(!seen.includes('file.name'));assert.ok(f.cell(0,'file.name').querySelector('a'));
  formula.focus();f.key(formula,'Delete');await tick();assert.equal(f.batches.length,0);f.close();
});

test('group summary picker preserves group scope in preview and edit callbacks', async () => {
  const scopes:(number|null|undefined)[]=[], edits:(number|null|undefined)[]=[];
  const f=fixture({getSummary:(property,group)=>property==='note.score'?{value:{type:'number',value:group===null?3:1},label:'Sum'}:undefined,getSummaryOptions:async(_property,group)=>{scopes.push(group);return[{id:'Range',label:'Range',preview:{type:'number',value:1}}];},requestSummary(){},requestEditSummary(_property,_id,_anchor,group){edits.push(group);}});
  f.view.update({...f.result,version:8,groups:[{key:{type:'string',value:'A'},rows:f.result.rows.slice(0,2)},{key:{type:'string',value:'B'},rows:f.result.rows.slice(2)}]});
  const group=f.main.querySelector<HTMLElement>('[data-summary-property="note.score"][data-summary-group="1"]')!;assert.ok(group);group.click();await tick();
  assert.deepEqual(scopes,[1]);const input=f.dom.window.document.querySelector<HTMLInputElement>('[aria-label="Find or create summary"]')!;f.key(input,'ArrowRight');assert.deepEqual(edits,[1]);
  assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]'),null);f.close();
});


test('virtualized summary anchors close their popup and public return chooser resolves a current anchor', async () => {
  const f=fixture({getSummaryOptions:async()=>[{id:'Sum',label:'Sum'}],getSummary:property=>property==='note.score'?{label:'Sum',value:{type:'number',value:3}}:undefined,requestSummary(){}});
  const old=f.main.querySelector<HTMLElement>('[data-summary-property="note.score"]')!;old.click();await tick();assert.ok(f.dom.window.document.querySelector('[aria-label="Summarize"]'));
  f.view.refreshLayout();assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]'),null);assert.equal(old.isConnected,false);
  f.view.openSummaryPicker('note.score',old,null);await tick();assert.ok(f.dom.window.document.querySelector('[aria-label="Summarize"]'));
  f.view.destroy();assert.equal(f.dom.window.document.querySelector('[aria-label="Summarize"]'),null);f.dom.window.close();
});


test('summary footer starts hidden, then exposes selected function name and value', () => {
  const plain=fixture({requestSummary(){},summaryOptions:[{id:'Sum',label:'Sum'}]});assert.equal(plain.main.querySelector<HTMLElement>('.zorid-bases-table-footer')!.hidden,true);plain.close();
  const selected=fixture({getSummary:(property)=>property==='note.score'?{label:'Sum',value:{type:'number',value:3}}:undefined});assert.equal(selected.main.querySelector<HTMLElement>('.zorid-bases-table-footer')!.hidden,false);assert.match(selected.main.querySelector('[data-summary-property="note.score"]')!.textContent!,/Sum3/);selected.close();
});

test('rich widgets cannot consume shift selections, range Enter or the click after a drag', () => {
  let activations=0;
  const f=fixture({renderProperty(element){const click=(event:MouseEvent)=>{if(!event.defaultPrevented)activations++;};const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&event.key==='Enter')activations++;};element.addEventListener('click',click);element.addEventListener('keydown',key);return()=>{element.removeEventListener('click',click);element.removeEventListener('keydown',key);};}});
  f.cell(0,'note.text').focus();f.cell(1,'note.text').dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:true}));assert.equal(activations,0);f.key(f.cell(0,'note.text'),'Enter');assert.equal(activations,0);
  f.key(f.cell(0,'note.text'),'Escape');f.cell(0,'note.text').dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));f.cell(1,'note.text').dispatchEvent(new f.dom.window.MouseEvent('pointermove',{bubbles:true,cancelable:true}));f.cell(1,'note.text').dispatchEvent(new f.dom.window.MouseEvent('pointerup',{bubbles:true,cancelable:true}));f.cell(1,'note.text').click();assert.equal(activations,0);f.close();
});


test('raw clipboard and scalar append preserve saved link aliases and date spelling', async () => {
  const saved={type:'list' as const,value:[{type:'string' as const,value:'[[Projects/Alpha|An alias]]'},{type:'string' as const,value:'2026-10-22T10:00:00-04:00'}]};
  const f=fixture({getEditableValue:(_row,property)=>property==='note.text'?saved:undefined});
  const rows=f.result.rows.map(row=>({...row,values:{...row.values,'note.text':{type:'list' as const,value:[{type:'namespace' as const,name:'An alias',get(){throw Error('no resolver calls');}}]}}}));f.view.update({...f.result,shared:{} as NonNullable<BaseQueryResult['shared']>,version:8,rows,groups:[{key:null,rows}]});f.cell(0,'note.text').focus();
  const formats=new Map<string,string>();const copy=new f.dom.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:{setData:(type:string,text:string)=>formats.set(type,text)}});f.cell(0,'note.text').dispatchEvent(copy);
  assert.deepEqual(JSON.parse(formats.get('obsidian/bases-cells')!),[[{type:'note',data:['[[Projects/Alpha|An alias]]','2026-10-22T10:00:00-04:00']}]]);
  f.paste(f.cell(0,'note.text'),{'text/plain':'next'});await tick();assert.deepEqual(f.batches[0][0].value,{type:'list',value:[...saved.value,{type:'string',value:'next'}]});f.close();
});

test('unavailable formatted values never become raw clipboard data or append baselines', async () => {
  const f=fixture();const rows=f.result.rows.map(row=>({...row,values:{...row.values,'note.text':{type:'list' as const,value:[{type:'namespace' as const,name:'Display only',get(){throw Error('no resolver calls');}}]}}}));f.view.update({...f.result,shared:{} as NonNullable<BaseQueryResult['shared']>,version:8,rows,groups:[{key:null,rows}]});f.cell(0,'note.text').focus();
  const formats=new Map<string,string>();const copy=new f.dom.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:{setData:(type:string,text:string)=>formats.set(type,text)}});f.cell(0,'note.text').dispatchEvent(copy);
  assert.deepEqual(JSON.parse(formats.get('obsidian/bases-cells')!),[[{type:'note'}]]);assert.equal(formats.get('text/plain'),'Display only');
  f.paste(f.cell(0,'note.text'),{'text/plain':'next'});await tick();assert.equal(f.batches.length,0);assert.match(f.main.textContent!,/raw saved property is unavailable/);f.close();
});

test('derived computed values copy as formula cells rather than fabricated saved properties', async () => {
  const f=fixture({getPropertyType:property=>property==='note.score'?'rollup':'text',getEditableValue:()=>({type:'number',value:99})});f.cell(0,'note.score').focus();
  const formats=new Map<string,string>();const copy=new f.dom.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:{setData:(type:string,text:string)=>formats.set(type,text)}});f.cell(0,'note.score').dispatchEvent(copy);
  assert.deepEqual(JSON.parse(formats.get('obsidian/bases-cells')!),[[{type:'formula'}]]);f.cell(0,'note.text').focus();f.paste(f.cell(0,'note.text'),{'obsidian/bases-cells':formats.get('obsidian/bases-cells')!});await tick();assert.equal(f.batches.length,0);f.close();
});
