import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../src/ui/workspace.ts';

const open = Reflect.get(Workspace.prototype, 'openPropertyLink') as (...args: unknown[]) => Promise<void>;
function fixture() {
  const opened: unknown[] = [], followed: unknown[] = [];
  const entries = new Map([
    ['People/Old.md', { type: 'file', path: 'People/Old.md', entryId: 'replacement', revision: 'r1' }],
    ['People/Renamed.md', { type: 'file', path: 'People/Renamed.md', entryId: 'ada', revision: 'r1' }],
  ]);
  const owner = { vault: { entries }, async openNote(...args: unknown[]) { opened.push(args); }, async followLink(...args: unknown[]) { followed.push(args); } };
  const pane = {};
  return { entries, opened, followed, run: (witness?: { entryId: string; revision: string }) => open.call(owner, 'Books/Note.md', 'People/Old.md', pane, witness), pane };
}

test('ordinary property links follow captured identity across rename and path reuse', async () => {
  const f = fixture(); await f.run({ entryId: 'ada', revision: 'r1' });
  const [path,newTab,pane,record,fragment,_activation,guard,id] = f.opened[0] as unknown[];
  assert.deepEqual([path,newTab,pane,record,fragment,id], ['People/Renamed.md', false, f.pane,true,'','ada']);
  assert.equal((guard as ()=>boolean)(),true);
  f.entries.get('People/Renamed.md')!.revision='r2';assert.equal((guard as ()=>boolean)(),false);
  assert.deepEqual(f.followed, []);
});

test('real note admission refuses a target replaced while the previous editor flushes', async () => {
  const f=fixture(), pane={renderVersion:1};let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});let rendered=false;
  const owner={vault:{entries:f.entries},vaultGeneration:1,platform:{editorOnly:false},panes:[pane],navigationIntent:new Map(),
    flushPane:()=>held,bufferFor:async(_path:string,_id:string,validate:()=>void)=>{validate();},
    openNote:Reflect.get(Workspace.prototype,'openNote'),renderPane:()=>{rendered=true;}};
  const opening=open.call(owner,'Books/Note.md','People/Old.md',pane,{entryId:'ada',revision:'r1'});
  f.entries.set('People/Renamed.md',{type:'file',path:'People/Renamed.md',entryId:'replacement',revision:'r2'});release();
  await assert.rejects(opening,/selected note changed/);assert.equal(rendered,false);
});

test('retired or changed property targets cannot open or create a replacement', async () => {
  for (const revision of ['r2', undefined]) {
    const f = fixture();
    if (revision) f.entries.get('People/Renamed.md')!.revision = revision;
    else f.entries.delete('People/Renamed.md');
    await assert.rejects(f.run({ entryId: 'ada', revision: 'r1' }), /related note changed/);
    assert.deepEqual(f.opened, []); assert.deepEqual(f.followed, []);
  }
});

test('witnessed opens preserve a proven heading suffix without inventing one from a renamed filename',async()=>{
  const f=fixture();const args:unknown[][]=[];
  const owner={vault:{entries:f.entries},openNote:async(...value:unknown[])=>{args.push(value);}};
  await open.call(owner,'Books/Note.md','People/Renamed.md#Heading',f.pane,{entryId:'ada',revision:'r1'});
  await open.call(owner,'Books/Note.md','People/Old#literal.md',f.pane,{entryId:'ada',revision:'r1'});
  assert.equal(args[0][4],'#Heading');assert.equal(args[1][4],'');
});

test('ordinary unresolved text retains the existing follow-link behavior', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.followed, [['Books/Note.md', 'People/Old.md', f.pane]]);
  assert.deepEqual(f.opened, []);
});
