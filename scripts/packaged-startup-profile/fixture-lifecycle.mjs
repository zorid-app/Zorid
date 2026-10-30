import assert from 'node:assert/strict';

export const autosaveFixtures=args=>args.includes('--autosave-fixtures');
const keys={Home:{key:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:0x73},ArrowRight:{key:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:0x7c},Backspace:{key:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:0x33}};
export async function pressFixtureKey(renderer,code){
  const mapping=keys[code];assert.ok(mapping,'Only ordinary fixture restoration keys are permitted');
  for(const type of ['keyDown','keyUp'])await renderer.call('Input.dispatchKeyEvent',{type,code,modifiers:0,...mapping});
}
/** Reads the current real editor; the only installed listener observes deletion. */
export function fixtureEditor(config,action='read'){
  if(action==='dispose'){const observed=window.__zoridFixtureDeletion;if(observed?.identity!==config.identity)throw Error('Fixture deletion cleanup scope differs');observed.dispose();delete window.__zoridFixtureDeletion;return true;}
  const pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
  if(window.__zoridPackagedProbe?.identity!==config.identity||!view||view.contentDOM!==node||pane.querySelector('.note-title')?.value!==config.path.split('/').at(-1).replace(/\.md$/i,'')||node.closest('[inert]')||node.getAttribute('contenteditable')!=='true'||!node.contains(document.activeElement)||document.hidden||document.visibilityState!=='visible'||!document.hasFocus())throw Error('Fixture restoration editor scope or focus changed');
  if(action==='observe'){
    if(window.__zoridFixtureDeletion)throw Error('Fixture deletion observer already installed');
    const events=[],listener=event=>{if(node.contains(event.target)&&event.inputType==='deleteContentBackward')events.push({trusted:event.isTrusted===true,inputType:event.inputType});};
    document.addEventListener('beforeinput',listener,true);
    window.__zoridFixtureDeletion={identity:config.identity,node,events,dispose:()=>document.removeEventListener('beforeinput',listener,true)};
  }
  const observed=window.__zoridFixtureDeletion;
  if(observed&&(observed.identity!==config.identity||observed.node!==node))throw Error('Fixture deletion observer scope changed');
  const result={body:view.state.doc.toString(),head:view.state.selection.main.head,anchor:view.state.selection.main.anchor,ranges:view.state.selection.ranges.length,deletions:observed?.events.map(event=>({...event}))??[]};
  return result;
}
export const fixtureEditorSource=(config,action)=>`(${fixtureEditor.toString()})(${JSON.stringify(config)},${JSON.stringify(action??'read')})`;
export function assertFixtureSelection(snapshot,body,head){
  assert.equal(snapshot.body,body,'Selected fixture differs during restoration');
  assert.equal(snapshot.ranges,1,'Fixture restoration requires one selection');
  assert.equal(snapshot.anchor,snapshot.head,'Fixture restoration requires a collapsed caret');
  if(head!==undefined)assert.equal(snapshot.head,head,'Fixture restoration caret differs');
}
/** No retry, activation, transaction, bridge write, or source mutation. */
export async function restoreAutosavedFixture({markers,original,read,key,guard}){
  assert.match(markers,/^[xy]{1,2}$/,'Only confirmed ASCII probe markers may be restored');
  const expected=markers+original;await guard();assertFixtureSelection(await read(),expected,markers.length);
  await key('Home');await guard();assertFixtureSelection(await read(),expected,0);
  for(let i=0;i<markers.length;i++){await key('ArrowRight');await guard();assertFixtureSelection(await read(),expected,i+1);}
  const receipts=[];
  for(let i=0;i<markers.length;i++){
    await guard();assertFixtureSelection(await read(),markers.slice(0,markers.length-i)+original,markers.length-i);
    await key('Backspace');await guard();const snapshot=await read();assertFixtureSelection(snapshot,markers.slice(0,markers.length-i-1)+original,markers.length-i-1);
    assert.equal(snapshot.deletions.length,i+1,'Trusted deletion event not acknowledged');assert.ok(snapshot.deletions.every(event=>event.trusted===true&&event.inputType==='deleteContentBackward'),'Untrusted fixture deletion');
    receipts.push({key:'Backspace',head:snapshot.head,exact:true,trusted:true});
  }
  return {mode:'autosave-trusted-backspace',markers:markers.length,receipts};
}
