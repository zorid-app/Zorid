import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBaseTableView } from '../src/bases/table-view.ts';
import type { BaseTableOptions, BaseTableView } from '../src/bases/table-view.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
import type { BasePropertyWidgetEdit } from '../src/bases/property-widgets.ts';
import type { BaseQueryResult } from '../src/bases/query.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra: Partial<BaseTableOptions> = {}, picker = false, checkbox = false) {
  const dom = new JSDOM('<main></main><button id="outside">Outside</button>', { pretendToBeVisual: true }), doc = dom.window.document, main = doc.querySelector('main')!;
  const rows = ['One', 'Two'].map((name, i) => ({ path: `${name}.md`, entryId: `entry-${i}`, revision: 'r1', values: { 'file.name': { type: 'string' as const, value: name }, 'note.text': { type: 'string' as const, value: 'Original' }, 'note.next': checkbox ? { type: 'boolean' as const, value: false } : { type: 'string' as const, value: 'Next' } } }));
  const result: BaseQueryResult = { version: 1, view: { type: 'table', name: 'Main' }, rows, groups: [{ key: null, rows }], properties: ['file.name', 'note.text', 'note.next'], availableProperties: [], groupOptions: [], diagnostics: [], counts: { scanned: 2, matched: 2, afterGroupOrder: 2, afterSearch: 2, returned: 2 } };
  let pending = false, release!: () => void, reject!: (error: Error) => void;
  const writes: BasePropertyWidgetEdit[] = [], opens: unknown[][] = [];
  let view!: BaseTableView;
  view = createBaseTableView(main, { result, openFile(...args) { opens.push(args); }, editProperty: async () => {}, canBeginPropertyEdit: () => !pending,
    renderProperty(element, presentation) { return mountBasePropertyWidget(element, presentation, { getDefinition: property => picker && property === 'note.text' ? { type: 'select', options: [{ value: 'Original' }, { value: 'Done' }] } : checkbox && property === 'note.next' ? { type: 'checkbox' } : { type: 'text' }, canBegin: () => !pending,
      commit(edit) { writes.push(edit); pending = true; return new Promise<void>((yes, no) => { release = yes; reject = no; }).then(() => ({ version: 2, row: { ...edit.row, revision: 'r2' }, value: edit.value })).finally(() => { pending = false; }); },
      onEditorComplete: (element, presentation, intent) => view.completePropertyEdit(element, presentation, intent),
    }); }, ...extra,
  });
  const cell = (property: string, row = 0) => main.querySelector<HTMLElement>(`[role="gridcell"][data-property="${property}"][data-row="${row}"]`)!;
  const key = (target: Element, key: string, shiftKey = false) => { const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event; };
  const pointerClick = (target: HTMLElement) => { target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })); target.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true })); };
  return { dom, doc, main, rows, result, view, writes, opens, cell, key, pointerClick, release() { release(); }, reject() { reject(new Error('Save failed')); }, close() { view.destroy(); dom.window.close(); } };
}

for (const [key, shift, expected] of [['Enter', false, 'note.text'], ['Tab', false, 'note.next'], ['Tab', true, 'file.name']] as const) test(`rich ${shift ? 'Shift+' : ''}${key} returns to the expected selected cell after save`, async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed'; f.key(input, key, shift);
    assert.equal(f.writes.length, 1); f.release(); await tick();
    assert.equal(f.doc.querySelector('input'), null); assert.equal((f.doc.activeElement as HTMLElement).dataset.property, expected);
  } finally { f.close(); }
});

test('Tab leaving a property picker selects the next grid cell after the portal closes', () => {
  const f = fixture({}, true); try {
    f.cell('note.text').click(); const popup = f.doc.querySelector('.bases-property-popover')!, input = popup.querySelector('input')!; f.key(input, 'Tab');
    assert.equal(f.doc.querySelector('.bases-property-popover'), null); assert.equal(f.doc.activeElement, f.cell('note.next')); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('a next-cell click swallowed during save activates that exact destination after acknowledgement', async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed';
    f.pointerClick(f.cell('note.next')); assert.equal(f.writes.length, 1); assert.equal(f.cell('note.next').querySelector('input'), null);
    f.release(); await tick(); const next = f.cell('note.next').querySelector('input'); assert.ok(next); assert.equal(f.doc.activeElement, next);
  } finally { f.close(); }
});

test('a queued checkbox click toggles the fresh checkbox after the preceding save', async () => {
  const f = fixture({}, false, true); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed';
    f.pointerClick(f.cell('note.next').querySelector<HTMLInputElement>('input[type="checkbox"]')!); assert.equal(f.writes.length, 1);
    f.release(); await tick(); assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1].value, { type: 'boolean', value: true });
    f.release(); await tick(); assert.equal(f.cell('note.next').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true);
  } finally { f.close(); }
});

test('plain title click clears an old cell range before entering the title editor', () => {
  const f = fixture({ renameFile: async () => {} }); try {
    f.cell('note.text').focus(); f.key(f.cell('note.text'), 'ArrowRight', true); assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 2);
    f.cell('file.name').querySelector<HTMLElement>('.zorid-bases-table-title')!.click(); assert.ok(f.cell('file.name').querySelector('input')); assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 0);
  } finally { f.close(); }
});

test('unchanged outside-cell click is handled once by the original browser click', async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); f.pointerClick(f.cell('note.next')); await tick();
    assert.equal(f.writes.length, 0); assert.equal(f.doc.querySelectorAll('input').length, 1); assert.equal(f.doc.activeElement, f.cell('note.next').querySelector('input'));
  } finally { f.close(); }
});

test('failed save never replays the queued destination and preserves the original draft', async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Unaccepted'; f.pointerClick(f.cell('note.next')); f.reject(); await tick();
    assert.equal(input.isConnected, true); assert.equal(input.value, 'Unaccepted'); assert.equal(f.cell('note.next').querySelector('input'), null);
  } finally { f.close(); }
});

test('leaving the table or window invalidates an accepted keyboard continuation', async () => {
  for (const leave of ['pointer', 'window']) {
    const f = fixture(); try {
      f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed'; f.key(input, 'Tab');
      const outside = f.doc.querySelector<HTMLElement>('#outside')!;
      if (leave === 'pointer') f.pointerClick(outside); else f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
      outside.focus(); f.release(); await tick(); assert.equal(f.doc.activeElement, outside, leave);
    } finally { f.close(); }
  }
});

test('reused destination paths cannot receive a delayed click for the old entry', async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed'; f.pointerClick(f.cell('note.next', 1));
    const rows = [f.rows[0], { ...f.rows[1], entryId: 'replacement' }]; f.view.update({ ...f.result, version: 3, rows, groups: [{ key: null, rows }] });
    f.release(); await tick(); assert.equal(f.cell('note.next', 1).querySelector('input'), null);
  } finally { f.close(); }
});

test('title click edits, Enter submits its saved witness, and hover Open remains a distinct action', async () => {
  const renames: unknown[] = [];
  const f = fixture({ renameFile: async edit => { renames.push(edit); return { path: edit.path }; } }); try {
    f.cell('file.name').querySelector<HTMLElement>('.zorid-bases-table-title')!.click();
    const input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; assert.equal(input.value, 'One'); input.value = 'Renamed'; f.key(input, 'Enter'); await tick();
    assert.deepEqual(renames, [{ version: 1, path: 'One.md', name: 'Renamed', witness: { entryId: 'entry-0', revision: 'r1' } }]);
    assert.equal(f.doc.activeElement, f.cell('file.name')); assert.equal(f.opens.length, 0);
    f.cell('file.name').querySelector<HTMLElement>('.zorid-bases-table-open')!.click(); assert.equal(f.opens.length, 1); assert.equal(f.opens[0][0], 'One.md'); assert.deepEqual(f.opens[0][2], { entryId: 'entry-0', revision: 'r1' });
  } finally { f.close(); }
});

test('title Tab selects the next cell, Escape cancels, and invalid names retain the editor', async () => {
  const renames: unknown[] = [];
  const f = fixture({ renameFile: async edit => { renames.push(edit); } }); try {
    f.cell('file.name').click(); f.key(f.cell('file.name').querySelector('input')!, 'Tab'); assert.equal(f.doc.activeElement, f.cell('note.text'));
    f.cell('file.name').click(); let input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'Discard'; f.key(input, 'Escape'); assert.equal(renames.length, 0);
    f.cell('file.name').click(); input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'bad/name'; f.key(input, 'Enter'); await tick(); assert.equal(input.isConnected, true); assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(renames.length, 0);
  } finally { f.close(); }
});

test('clicking another field during title rename saves before activating it', async () => {
  let accept!: () => void; const names: string[] = [];
  const f = fixture({ renameFile: edit => { names.push(edit.name); return new Promise<void>(resolve => { accept = resolve; }); } }); try {
    f.cell('file.name').click(); const input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'Renamed';
    f.pointerClick(f.cell('note.text')); assert.deepEqual(names, ['Renamed']); assert.equal(f.cell('note.text').querySelector('input'), null);
    accept(); await tick(); assert.equal(f.doc.activeElement, f.cell('note.text').querySelector('input'));
  } finally { f.close(); }
});

test('unchanged title completion preserves the original destination element for its click', () => {
  const f = fixture({ renameFile: async () => { assert.fail('unchanged title must not write'); } }); try {
    f.cell('file.name').click(); const destination = f.cell('note.text'); f.pointerClick(destination);
    assert.equal(destination.isConnected, true); assert.equal(f.doc.activeElement, destination.querySelector('input'));
  } finally { f.close(); }
});

test('rename failure keeps the title draft and rejects its queued next click', async () => {
  let reject!: (error: Error) => void;
  const f = fixture({ renameFile: () => new Promise<void>((_resolve, no) => { reject = no; }) }); try {
    f.cell('file.name').click(); const input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'Unaccepted'; f.pointerClick(f.cell('note.text'));
    reject(new Error('Rename failed')); await tick(); assert.equal(input.isConnected, true); assert.equal(input.value, 'Unaccepted'); assert.equal(f.cell('note.text').querySelector('input'), null);
  } finally { f.close(); }
});

test('Escape after a failed title rename cannot replay its stale queued Open action', async () => {
  let reject!: (error: Error) => void;
  const f = fixture({ renameFile: () => new Promise<void>((_resolve, no) => { reject = no; }) }); try {
    f.cell('file.name').click(); const input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'Unaccepted';
    f.pointerClick(f.cell('file.name', 1).querySelector<HTMLElement>('.zorid-bases-table-open')!); reject(new Error('Rename failed')); await tick();
    f.key(input, 'Escape'); assert.equal(f.opens.length, 0); assert.equal(f.doc.activeElement, f.cell('file.name')); assert.equal(f.main.querySelector('input'), null);
  } finally { f.close(); }
});

test('accepted title rename cannot reclaim focus after leaving the table or window', async () => {
  let accept!: () => void;
  const f = fixture({ renameFile: () => new Promise<void>(resolve => { accept = resolve; }) }); try {
    f.cell('file.name').click(); const input = f.cell('file.name').querySelector<HTMLInputElement>('input')!; input.value = 'Renamed'; f.key(input, 'Enter');
    const outside = f.doc.querySelector<HTMLElement>('#outside')!; f.dom.window.dispatchEvent(new f.dom.window.Event('blur')); outside.focus(); accept(); await tick(); assert.equal(f.doc.activeElement, outside);
  } finally { f.close(); }
});

test('a delayed Shift-click extends selection from the edited source without opening the destination', async () => {
  const f = fixture(); try {
    f.cell('note.text').click(); const input = f.cell('note.text').querySelector<HTMLInputElement>('input')!; input.value = 'Changed';
    const destination = f.cell('note.next'); destination.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { button: 0, shiftKey: true, bubbles: true, cancelable: true })); destination.dispatchEvent(new f.dom.window.MouseEvent('click', { button: 0, shiftKey: true, bubbles: true, cancelable: true }));
    f.release(); await tick(); assert.equal(f.doc.querySelector('input'), null); assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 2); assert.equal(f.doc.activeElement, f.cell('note.text'));
  } finally { f.close(); }
});

test('trailing add-property control is outside data columns and invokes only the current anchor', () => {
  const calls: HTMLElement[] = [], f = fixture({ requestAddProperty: anchor => calls.push(anchor) }); try {
    const add = f.main.querySelector<HTMLButtonElement>('.zorid-bases-table-add-property')!; add.click(); assert.deepEqual(calls, [add]); assert.equal(f.main.querySelector('[role=grid]')!.getAttribute('aria-colcount'), '3');
    f.view.update({ ...f.result, version: 2 }); add.click(); assert.equal(calls.length, 1);
  } finally { f.close(); }
});

for(const [key,shift,expected] of [['Enter',false,'note.text'],['Tab',false,'note.next'],['Tab',true,'file.name']] as const)test(`accepted ${shift?'Shift+':''}${key} waits for current admission before restoring its owned keyboard target`,async()=>{
  let admitted=true,baseIdentity='base-entry';const f=fixture({canBeginPropertyEdit:()=>admitted,getConfigurationIdentity:()=>baseIdentity});
  try{
    f.cell('note.text').click();const input=f.cell('note.text').querySelector<HTMLInputElement>('input')!;input.value='Changed';f.key(input,key,shift);admitted=false;f.release();await tick();
    assert.equal(f.doc.activeElement,f.doc.body,'the completed input was removed while query admission is pending');
    admitted=true;const rows=f.rows.map((row,index)=>index?row:{...row,revision:'r2',values:{...row.values,'note.text':{type:'string' as const,value:'Changed'}}});
    f.view.update({...f.result,version:2,rows,groups:[{key:null,rows}]});await tick();
    assert.equal((f.doc.activeElement as HTMLElement).dataset.property,expected,'accepted key intent survives the current-result handoff');
    assert.equal((f.doc.activeElement as HTMLElement).dataset.path,'One.md');
  }finally{f.close();}
});

for(const change of ['outside-focus','dialog-then-body','outside-pointer','navigation','window-blur','other-cell','new-view','new-view-id','new-source','hidden','replacement-base','replacement-actor','removed-row','removed-property','destroy'] as const)test(`a deferred accepted keyboard completion cannot reclaim focus after ${change}`,async()=>{
  let admitted=true,baseIdentity='base-entry';const f=fixture({canBeginPropertyEdit:()=>admitted,getConfigurationIdentity:()=>baseIdentity});
  try{
    f.cell('note.text').click();const input=f.cell('note.text').querySelector<HTMLInputElement>('input')!;input.value='Changed';f.key(input,'Enter');admitted=false;f.release();await tick();
    assert.equal(f.doc.activeElement,f.doc.body);
    const outside=f.doc.querySelector<HTMLElement>('#outside')!;
    if(change==='outside-focus')outside.focus();
    if(change==='dialog-then-body'){const dialog=f.doc.createElement('div');dialog.tabIndex=-1;dialog.setAttribute('role','dialog');f.doc.body.append(dialog);dialog.focus();dialog.remove();assert.equal(f.doc.activeElement,f.doc.body);}
    if(change==='outside-pointer')outside.dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));
    if(change==='navigation')f.key(f.doc.body,'Tab');
    if(change==='window-blur')f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
    if(change==='hidden'){Object.defineProperty(f.doc,'hidden',{value:true,configurable:true});f.doc.dispatchEvent(new f.dom.window.Event('visibilitychange'));Object.defineProperty(f.doc,'hidden',{value:false,configurable:true});}
    if(change==='replacement-base'){baseIdentity='replacement-base';f.view.resumePropertyCompletion();}
    if(change==='other-cell')f.cell('note.next').focus();
    if(change==='destroy'){f.view.destroy();admitted=true;f.view.resumePropertyCompletion();assert.equal(f.doc.activeElement,f.doc.body);return;}
    admitted=true;
    let rows=f.rows.map((row,index)=>index?row:{...row,revision:'r2',values:{...row.values,'note.text':{type:'string' as const,value:'Changed'}}});
    if(change==='replacement-actor')rows=rows.map((row,index)=>index?row:{...row,entryId:'replacement-entry'});
    if(change==='removed-row')rows=rows.slice(1);
    const next={...f.result,version:2,rows,groups:[{key:null,rows}],...(change==='new-view'?{view:{...f.result.view,name:'Another view'}}:{}),...(change==='new-view-id'?{view:{...f.result.view,id:'abcdefghijkl'}}:{}),...(change==='new-source'?{view:{...f.result.view,source:{kind:'collection',id:'abcdefghijkl'}}}:{}),...(change==='removed-property'?{properties:f.result.properties.filter(property=>property!=='note.text')}:{})};
    f.view.update(next);await tick();f.view.resumePropertyCompletion();
    assert.notEqual((f.doc.activeElement as HTMLElement)?.dataset.property,'note.text',change);
    if(change==='outside-focus')assert.equal(f.doc.activeElement,outside);
  }finally{f.close();}
});

test('a cell click captured before accepted Enter survives the still-blocked completion handoff',async()=>{
  let admitted=true;const f=fixture({canBeginPropertyEdit:()=>admitted});
  try{
    f.cell('note.text').click();const input=f.cell('note.text').querySelector<HTMLInputElement>('input')!;input.value='Changed';f.key(input,'Enter');
    f.pointerClick(f.cell('note.next'));admitted=false;f.release();await tick();
    assert.equal(f.doc.activeElement,f.doc.body);
    admitted=true;const rows=f.rows.map((row,index)=>index?row:{...row,revision:'r2',values:{...row.values,'note.text':{type:'string' as const,value:'Changed'}}});
    f.view.update({...f.result,version:2,rows,groups:[{key:null,rows}]});await tick();
    const destination=f.cell('note.next'),nextInput=destination.querySelector<HTMLInputElement>('input');
    assert.ok(nextInput,'the original blocked destination click must remain actionable');assert.equal(f.doc.activeElement,nextInput);
    assert.equal(f.writes.length,1,'replaying the user destination does not resubmit the accepted source');
  }finally{f.close();}
});
