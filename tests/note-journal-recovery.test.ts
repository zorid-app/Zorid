import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountNoteJournalRecovery} from '../src/ui/note-journal-recovery.ts';
import type {IndependentDraftCandidate,IndependentDraftProvider,IndependentDraftReceipt} from '../src/core/independent-drafts.ts';

const scope={vaultId:'vault-private',clientId:'client-private',incarnationId:'current-private'};
const receipt=(revision='1'):IndependentDraftReceipt=>({...scope,incarnationId:'prior-private',entryId:'entry-private',writer:'writer-private',revision,generation:2,deleted:false});
const candidate=(revision='1'):IndependentDraftCandidate=>({...receipt(revision),deleted:false,baseline:{entryId:'entry-private',path:'Folder/Note.md',revision:'source-revision',content:'baseline'},draft:'\ufeff<script>raw</script>\r\nexact',checkpointRevision:'checkpoint-private',pendingOperation:'PRIVATE CAPSULE'});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const held=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};
function setup(t:TestContext,overrides:Partial<IndependentDraftProvider>={},extra:Record<string,unknown>={}){
  const dom=new JSDOM('<body><button id="opener">Drafts</button><main></main></body>',{pretendToBeVisual:true});
  t.after(()=>dom.window.close());const document=dom.window.document;
  document.querySelector<HTMLButtonElement>('#opener')!.focus();
  let current:{entryId:string|null;scope:typeof scope}|null={entryId:'entry-private',scope};
  const copies:string[]=[];const requests:unknown[]=[];
  const provider:IndependentDraftProvider={scope,compareAndSwap:async()=>{throw new Error('No writes allowed');},retire:async()=>{throw new Error('No retirement allowed');},list:async options=>{requests.push(options);return[receipt()];},read:async address=>{requests.push(address);return candidate();},...overrides};
  const controller=mountNoteJournalRecovery({host:document.querySelector('main')!,entryId:'entry-private',noteLabel:'/private/Folder/Note.md',provider,getCurrentEntry:()=>current,copyText:async text=>{copies.push(text);},...extra});
  const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
  const select=async()=>{document.querySelector<HTMLButtonElement>('.version-history-version')!.click();await settle();};
  return{document,provider,controller,button,select,copies,requests,setCurrent:(value:typeof current)=>{current=value;controller.updateOwner();}};
}
test('targeted inventory requires explicit selection, previews safely and copies original exact bytes',async t=>{
  const s=setup(t);await s.controller.refresh();
  assert.deepEqual(s.requests,[{entryId:'entry-private'}]);assert.equal(s.document.querySelector('textarea')!.value,'');
  await s.select();assert.equal(s.document.querySelector('script'),null);assert.equal(s.document.querySelector('textarea')!.value,candidate().draft.replace(/\r\n/g,'\n'));
  s.button('Copy preview text').click();await settle();assert.deepEqual(s.copies,[candidate().draft]);
  assert.doesNotMatch(s.document.body.innerHTML,/vault-private|client-private|entry-private|writer-private|current-private|prior-private|checkpoint-private|PRIVATE CAPSULE|\/private\/Folder/);
  assert.equal(s.button('Create recovery copy'),undefined);assert.equal(s.document.querySelector('[role=region]')!.getAttribute('aria-busy'),'false');
});
test('candidate changed between list and read is refreshed without automatic selection or mutation',async t=>{
  let reads=0;const s=setup(t,{read:async()=>{reads++;return candidate('2');}});await s.controller.refresh();await s.select();
  assert.equal(reads,1);assert.equal(s.document.querySelector('textarea')!.value,'');assert.match(s.document.body.textContent!,/changed/);assert.equal(s.button('Copy preview text').disabled,true);
});
test('creation rechecks pinned receipt and current authority and passes no operation capsule',async t=>{
  let calls=0;let selection:any;const result={operationId:'create-op',entryId:'new-entry',revision:'new-revision',path:'Recovery.md',sequence:'7'};
  const s=setup(t,{}, {requestRecoveryCopy:async(value:unknown)=>{calls++;selection=value;return result;}});await s.controller.refresh();await s.select();
  s.button('Create recovery copy').click();s.button('Create recovery copy').click();await settle();
  assert.equal(calls,1);assert.equal(selection.draft,candidate().draft);assert.deepEqual(Object.keys(selection).sort(),['baseline','draft','hasRecoveryDetails','receipt']);assert.equal(Object.isFrozen(selection),true);
  assert.match(s.document.body.textContent!,/Recovery copy created/);assert.equal(s.button('Create recovery copy').disabled,true);
});
test('changed head blocks creation but preserves previously verified clipboard text',async t=>{
  let next=candidate();let created=0;const s=setup(t,{read:async()=>next},{requestRecoveryCopy:async()=>{created++;throw new Error('unreachable');}});
  await s.controller.refresh();await s.select();next=candidate('2');s.button('Create recovery copy').click();await settle();
  assert.equal(created,0);assert.match(s.document.body.textContent!,/changed/);s.button('Copy preview text').click();await settle();assert.deepEqual(s.copies,[candidate().draft]);
});
test('deleted or replaced current owner permits cached clipboard but never creates under stale authority',async t=>{
  let created=0;const s=setup(t,{}, {requestRecoveryCopy:async()=>{created++;throw new Error('unreachable');}});await s.controller.refresh();await s.select();
  s.setCurrent({entryId:null,scope});assert.equal(s.button('Create recovery copy').disabled,true);s.button('Copy preview text').click();await settle();assert.deepEqual(s.copies,[candidate().draft]);assert.equal(created,0);
});
test('late read after scope change cannot expose old preview or enable creation',async t=>{
  const read=held<IndependentDraftCandidate>();const s=setup(t,{read:()=>read.promise});await s.controller.refresh();s.document.querySelector<HTMLButtonElement>('.version-history-version')!.click();
  s.setCurrent({entryId:'entry-private',scope:{...scope,vaultId:'other'}});read.resolve(candidate());await settle();assert.equal(s.document.querySelector('textarea')!.value,'');assert.equal(s.button('Copy preview text').disabled,true);
});
test('close does not cancel, replay or discard pending creation and fences all later UI effects',async t=>{
  const pending=held<any>();let opens=0;const s=setup(t,{}, {requestRecoveryCopy:()=>pending.promise,onOpenCopy:async()=>{opens++;}});await s.controller.refresh();await s.select();
  s.button('Create recovery copy').click();await settle();s.controller.focus();s.controller.close();pending.resolve({operationId:'op',entryId:'new',revision:'rev',path:'New.md',sequence:'1'});await settle();
  assert.equal(s.document.querySelector('[role=region]'),null);assert.equal(s.document.activeElement?.id,'opener');assert.equal(opens,0);
});
test('foreign, inherited, extra-field and malformed receipts fail closed without body reads',async t=>{
  const bad=[{...receipt(),entryId:'foreign'},Object.create(receipt()),{...receipt(),privateExtra:true},{...receipt(),revision:'01'},{...receipt(),generation:-0}];
  for(const value of bad){let reads=0;const s=setup(t,{list:async()=>[value],read:async()=>{reads++;return candidate();}});await s.controller.refresh();assert.equal(reads,0);assert.equal(s.document.querySelector('.version-history-version'),null);assert.match(s.document.body.textContent!,/couldn’t be listed/);}
});
test('capsule is opaque and failed providers never leak private messages or imply an empty inventory',async t=>{
  const s=setup(t,{list:async()=>{throw new Error('/private/secret CORE_FAILURE');}});await s.controller.refresh();assert.match(s.document.body.textContent!,/couldn’t be listed/);assert.doesNotMatch(s.document.body.innerHTML,/secret|CORE_FAILURE|No protected drafts/);
});
test('competing writers remain visible and never acquire an implicit newest winner',async t=>{
  const other={...receipt('8'),writer:'another-private-writer',generation:99};let reads=0;
  const s=setup(t,{list:async()=>[other,receipt()],read:async()=>{reads++;return candidate();}});await s.controller.refresh();
  assert.equal(s.document.querySelectorAll('.version-history-version').length,2);assert.equal(reads,0);
  assert.equal(s.document.querySelector('[aria-pressed=true]'),null);assert.equal(s.button('Copy preview text').disabled,true);
});
test('malformed candidate body is never promoted to a preview and private details are not rendered',async t=>{
  const values=[{...candidate(),baseline:{...candidate().baseline,entryId:'wrong'}},{...candidate(),baseline:{...candidate().baseline,path:'/private/secret'}},{...candidate(),injected:'private-extra'},Object.assign(Object.create({draft:'bad'}),candidate()),{...candidate(),pendingOperation:{execute:true}}];
  for(const value of values){const s=setup(t,{read:async()=>value as any});await s.controller.refresh();await s.select();assert.equal(s.document.querySelector('textarea')!.value,'');assert.equal(s.button('Copy preview text').disabled,true);assert.doesNotMatch(s.document.body.innerHTML,/private-extra|\/private\/secret|execute/);}
});
test('same receipt with changed bytes blocks creation rather than trusting revision alone',async t=>{
  let reads=0,creates=0;const s=setup(t,{read:async()=>++reads===1?candidate():{...candidate(),draft:'changed bytes'}},{requestRecoveryCopy:async()=>{creates++;throw new Error('unreachable');}});
  await s.controller.refresh();await s.select();s.button('Create recovery copy').click();await settle();assert.equal(creates,0);assert.match(s.document.body.textContent!,/changed/);
});
test('authority is rechecked after a held precreation read and provider scope mutation is fenced',async t=>{
  const pending=held<IndependentDraftCandidate>();let reads=0,creates=0;const s=setup(t,{read:()=>++reads===1?Promise.resolve(candidate()):pending.promise},{requestRecoveryCopy:async()=>{creates++;throw new Error('unreachable');}});
  await s.controller.refresh();await s.select();s.button('Create recovery copy').click();s.setCurrent({entryId:'replacement',scope});pending.resolve(candidate());await settle();assert.equal(creates,0);
  const nextScope={...scope};const q=setup(t,{scope:nextScope});await q.controller.refresh();nextScope.incarnationId='replaced';q.controller.updateOwner();assert.equal(q.button('Refresh versions').disabled,true);
});
test('unconfirmed copy keeps storage and allows the same captured request to be finished',async t=>{
  let calls=0;const seen:unknown[]=[];const s=setup(t,{}, {requestRecoveryCopy:async(value:unknown)=>{seen.push(value);if(++calls===1)throw new Error('/private/path HOST_DIED');return{operationId:'same-op',entryId:'new',revision:'rev',path:'Copy.md',sequence:'2'};}});
  await s.controller.refresh();await s.select();s.button('Create recovery copy').click();await settle();assert.match(s.document.body.textContent!,/has not been confirmed/);assert.doesNotMatch(s.document.body.innerHTML,/HOST_DIED|\/private\/path/);
  s.button('Create recovery copy').click();await settle();assert.equal(calls,2);assert.deepEqual(seen[0],seen[1]);assert.match(s.document.body.textContent!,/Recovery copy created/);
});
test('large previews are bounded while clipboard and creation retain the complete exact source',async t=>{
  const draft='x'.repeat(1024*1024)+'\r\nEND';let created:string|undefined;
  const s=setup(t,{read:async()=>({...candidate(),draft})},{requestRecoveryCopy:async(value:any)=>{created=value.draft;return{operationId:'op',entryId:'new',revision:'rev',path:'Copy.md',sequence:'1'};}});
  await s.controller.refresh();await s.select();assert.equal(s.document.querySelector('textarea')!.value.length,1024*1024);assert.match(s.document.body.textContent!,/Preview limited/);
  s.button('Copy preview text').click();await settle();assert.equal(s.copies[0],draft);s.button('Create recovery copy').click();await settle();assert.equal(created,draft);
});
test('confirmed copy opens only on explicit action and rejects malformed creation receipts',async t=>{
  let opens=0;const s=setup(t,{}, {requestRecoveryCopy:async()=>({operationId:'op',entryId:'new',revision:'rev',path:'Copy.md',sequence:'1'}),onOpenCopy:async()=>{opens++;}});
  await s.controller.refresh();await s.select();s.button('Create recovery copy').click();await settle();assert.equal(opens,0);s.button('Open recovery copy').click();await settle();assert.equal(opens,1);
  const q=setup(t,{}, {requestRecoveryCopy:async()=>({operationId:'op',entryId:'entry-private',revision:'rev',path:'../Bad.md',sequence:'1'})});await q.controller.refresh();await q.select();q.button('Create recovery copy').click();await settle();assert.match(q.document.body.textContent!,/has not been confirmed/);
});
