import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { availableFolderPath, createFolderInline, FileTreeRenameSession } from '../src/ui/file-tree-create.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise, resolve}; }
function setup(options: Partial<ConstructorParameters<typeof FileTreeRenameSession>[0]> = {}) {
  const dom = new JSDOM('<body><div class="tree-row" draggable="true"><span class="tree-label">Untitled folder</span></div><button>Elsewhere</button></body>', {pretendToBeVisual:true});
  const row = dom.window.document.querySelector<HTMLElement>('.tree-row')!, label = row.querySelector<HTMLElement>('.tree-label')!;
  const writes: string[] = [], finishes: string[] = [], errors: unknown[] = [];
  const session = new FileTreeRenameSession({name:'Untitled folder',save:async name=>{ writes.push(name); },isCurrent:()=>true,onFinish:reason=>{finishes.push(reason);},onError:error=>errors.push(error),...options});
  session.attach(row,label);
  const key = (value: string, isComposing = false) => label.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,isComposing,bubbles:true,cancelable:true}));
  return {dom,row,label,session,writes,finishes,errors,key};
}

test('folder name allocation respects folders/files, case, parent and numeric gaps', () => {
  assert.equal(availableFolderPath(['Untitled folder','UNTITLED FOLDER 1','Untitled folder 3']), 'Untitled folder 2');
  assert.equal(availableFolderPath(['P/untitled folder','Other/Untitled folder 1'],'P'),'P/Untitled folder 1');
  assert.equal(availableFolderPath(['Café'],'','Cafe\u0301'),'Cafe\u0301 1');
});

test('creates before reveal, suppresses stale reveal and propagates creation failure', async () => {
  const deferred = gate(), events: string[] = []; let current = true;
  const promise = createFolderInline({owner:{},paths:()=>[],createFolder:async path=>{events.push(path);await deferred.promise;},isCurrent:()=>current,revealAndEdit:path=>{events.push(`edit:${path}`);}},'Parent');
  await tick(); assert.deepEqual(events,['Parent/Untitled folder']); current = false; deferred.resolve();
  assert.equal(await promise,'Parent/Untitled folder'); assert.equal(events.length,1);
  await assert.rejects(createFolderInline({owner:{},paths:()=>[],createFolder:async()=>{throw new Error('Read-only folder');},isCurrent:()=>true,revealAndEdit:()=>assert.fail('must not edit after failure')}),/Read-only/);
});

test('focus selects complete title, Escape preserves real default folder and blocks row activation', async () => {
  const ui = setup(); let clicks = 0; ui.row.onclick=()=>clicks++;
  await tick(); assert.equal(ui.dom.window.document.activeElement,ui.label);
  assert.equal(ui.dom.window.getSelection()?.toString(),'Untitled folder');
  ui.label.click(); assert.equal(clicks,0); ui.label.textContent='Discarded'; ui.key('Escape'); await tick();
  assert.deepEqual(ui.writes,[]); assert.deepEqual(ui.finishes,['escape']); assert.equal(ui.label.textContent,'Untitled folder');
  assert.equal(ui.label.hasAttribute('contenteditable'),false); assert.equal(ui.row.draggable,true); ui.dom.window.close();
});

test('composition Enter is ignored; Enter trims and saves once despite repeats and blur', async () => {
  const deferred = gate(), writes: string[] = [], ui = setup({save:async name=>{writes.push(name);await deferred.promise;}});
  await tick(); ui.label.textContent='  Plans  '; ui.key('Enter',true); await tick(); assert.deepEqual(writes,[]);
  ui.key('Enter'); ui.key('Enter'); await tick(); assert.deepEqual(writes,['Plans']);
  ui.dom.window.document.querySelector('button')!.focus(); deferred.resolve(); await tick();
  assert.deepEqual(writes,['Plans']); assert.deepEqual(ui.finishes,['blur']);
  assert.equal(ui.dom.window.document.activeElement?.tagName,'BUTTON'); assert.equal(ui.label.textContent,'Plans'); ui.dom.window.close();
});

test('failed Enter keeps draft editable; failed blur exits and restores original', async () => {
  const ui = setup({save:async()=>{throw new Error('A folder with that name already exists.');}});
  await tick(); ui.label.textContent='Taken'; assert.equal(await ui.session.commit('enter'),false);
  assert.equal(ui.session.isActive,true); assert.equal(ui.label.textContent,'Taken'); assert.equal(ui.label.getAttribute('contenteditable'),'true');
  assert.match(ui.row.querySelector('[role="alert"]')!.textContent!,/already exists/);
  assert.equal(await ui.session.commit('blur'),false); assert.equal(ui.session.isActive,false);
  assert.equal(ui.label.textContent,'Untitled folder'); assert.deepEqual(ui.finishes,['blur']); ui.dom.window.close();
});

test('empty title cannot save, and a corrected error can be retried', async () => {
  const ui = setup(); await tick(); ui.label.textContent='  ';
  assert.equal(await ui.session.commit('enter'),false); assert.deepEqual(ui.writes,[]);
  ui.label.textContent='Projects'; assert.equal(await ui.session.commit('enter'),true);
  assert.deepEqual(ui.writes,['Projects']); assert.deepEqual(ui.finishes,['enter']); ui.dom.window.close();
});

test('tree reconstruction preserves draft and binds only the current row', async () => {
  const ui = setup(); await tick(); ui.label.textContent='Draft';
  const nextRow=ui.dom.window.document.createElement('div'), nextLabel=ui.dom.window.document.createElement('span');
  nextRow.append(nextLabel); ui.row.replaceWith(nextRow); ui.session.attach(nextRow,nextLabel); await tick();
  assert.equal(nextLabel.textContent,'Draft'); assert.equal(ui.label.hasAttribute('contenteditable'),false);
  ui.key('Enter'); await tick(); assert.deepEqual(ui.writes,[]);
  await ui.session.commit('enter'); assert.deepEqual(ui.writes,['Draft']); ui.dom.window.close();
});

test('ownership changes suppress save start, late error and focus transfer', async () => {
  let current=true; const deferred=gate(), ui=setup({isCurrent:()=>current,save:async()=>{await deferred.promise;throw new Error('Old vault failure');}});
  await tick(); ui.label.textContent='New'; const saving=ui.session.commit('enter'); await tick(); current=false;
  ui.dom.window.document.querySelector('button')!.focus(); deferred.resolve(); await saving;
  assert.deepEqual(ui.errors,[]); assert.deepEqual(ui.finishes,[]); assert.equal(ui.dom.window.document.activeElement?.tagName,'BUTTON');
  ui.session.dispose(); ui.dom.window.close();
  const stale=setup({isCurrent:()=>false}); stale.label.textContent='No write'; await stale.session.commit('enter');
  assert.deepEqual(stale.writes,[]); stale.session.dispose(); stale.dom.window.close();
});


test('simultaneous creation requests reserve unique names in their captured vault', async () => {
  const owner={}, paths=new Set(['UNTITLED FOLDER']), deferred=gate(), revealed:string[]=[];
  const makeHost=()=>({owner, paths:()=>paths, isCurrent:()=>true,
    createFolder:async(path:string)=>{await deferred.promise;assert.equal(paths.has(path),false);paths.add(path);},
    revealAndEdit:(path:string)=>{revealed.push(path);}});
  const first=createFolderInline(makeHost()), second=createFolderInline(makeHost());
  deferred.resolve();
  assert.deepEqual(await Promise.all([first,second]),['Untitled folder 1','Untitled folder 2']);
  assert.deepEqual(revealed,['Untitled folder 1','Untitled folder 2']);
});


test('inline title cannot create hidden files or move through path syntax', async () => {
  for (const name of ['.hidden','Parent/Child','Parent\\Child','Name:Part']) {
    const ui=setup(); ui.label.textContent=name;
    assert.equal(await ui.session.commit('enter'),false); assert.deepEqual(ui.writes,[]);
    ui.session.dispose(); ui.dom.window.close();
  }
});


test('formatted pasted title becomes plain text and keeps the caret', async () => {
  const ui=setup(); await tick(); ui.label.innerHTML='New <b>folder</b>';
  const text=ui.label.querySelector('b')!.firstChild!;
  ui.dom.window.getSelection()!.setBaseAndExtent(text,3,text,3);
  ui.label.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}));
  assert.equal(ui.label.innerHTML,'New folder'); assert.equal(ui.dom.window.getSelection()!.focusOffset,7);
  await ui.session.commit('enter'); assert.deepEqual(ui.writes,['New folder']); ui.dom.window.close();
});
