import assert from 'node:assert/strict';

export const autosaveFixtures=args=>args.includes('--autosave-fixtures');
const keys={Home:{key:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:0x73},ArrowRight:{key:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:0x7c},Backspace:{key:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:0x33}};
export async function pressFixtureKey(renderer,code){
  const mapping=keys[code];assert.ok(mapping,'Only ordinary fixture restoration keys are permitted');
  for(const type of ['keyDown','keyUp'])await renderer.call('Input.dispatchKeyEvent',{type,code,modifiers:0,...mapping});
}
/** Reads the real editor; listeners only observe normal key/input events. */
export function fixtureEditor(config,action='read'){
  if(action==='dispose'){const observed=window.__zoridFixtureDeletion;if(observed?.identity!==config.identity)throw Error('Fixture deletion cleanup scope differs');observed.dispose();delete window.__zoridFixtureDeletion;return true;}
  const pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
  if(window.__zoridPackagedProbe?.identity!==config.identity||!view||view.contentDOM!==node||pane.querySelector('.note-title')?.value!==config.path.split('/').at(-1).replace(/\.md$/i,'')||node.closest('[inert]')||node.getAttribute('contenteditable')!=='true'||!node.contains(document.activeElement)||document.hidden||document.visibilityState!=='visible'||!document.hasFocus())throw Error('Fixture restoration editor scope or focus changed');
  if(action==='observe'){
    if(window.__zoridFixtureDeletion)throw Error('Fixture deletion observer already installed');
    const events=[],listener=event=>{if(node.contains(event.target)&&event.inputType==='deleteContentBackward')events.push({trusted:event.isTrusted===true,inputType:event.inputType});};
    // CodeMirror may handle Backspace on keydown and prevent the browser default,
    // so a normal command need not emit beforeinput. Keep the event reference to
    // observe defaultPrevented AFTER the editor handler has completed.
    const keydowns=[],keydown=event=>{if(node.contains(event.target)&&event.key==='Backspace')keydowns.push(event);};
    document.addEventListener('beforeinput',listener,true);document.addEventListener('keydown',keydown,true);
    window.__zoridFixtureDeletion={identity:config.identity,node,events,keydowns,dispose:()=>{document.removeEventListener('beforeinput',listener,true);document.removeEventListener('keydown',keydown,true);}};
  }
  const observed=window.__zoridFixtureDeletion;
  if(observed&&(observed.identity!==config.identity||observed.node!==node))throw Error('Fixture deletion observer scope changed');
  const result={body:view.state.doc.toString(),head:view.state.selection.main.head,anchor:view.state.selection.main.anchor,ranges:view.state.selection.ranges.length,deletions:observed?.events.map(event=>({...event}))??[],backspaces:observed?.keydowns.map(event=>({trusted:event.isTrusted===true,key:event.key,code:event.code,modifiers:(event.altKey?1:0)|(event.ctrlKey?2:0)|(event.metaKey?4:0)|(event.shiftKey?8:0),defaultPrevented:event.defaultPrevented===true}))??[]};
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
    await guard();const before=await read();assertFixtureSelection(before,markers.slice(0,markers.length-i)+original,markers.length-i);assert.equal(before.backspaces.length,i,'Unexpected Backspace before dispatch');const beforeInputCount=before.deletions.length;
    await key('Backspace');await guard();const snapshot=await read();assertFixtureSelection(snapshot,markers.slice(0,markers.length-i-1)+original,markers.length-i-1);
    assert.equal(snapshot.backspaces.length,i+1,'Trusted Backspace keydown not acknowledged');assert.ok(snapshot.backspaces.every(event=>event.trusted===true&&event.key==='Backspace'&&event.code==='Backspace'&&event.modifiers===0),'Untrusted fixture Backspace');
    assert.ok(snapshot.deletions.length>=beforeInputCount&&snapshot.deletions.length<=beforeInputCount+1,'Duplicate or retired fixture beforeinput');assert.ok(snapshot.deletions.every(event=>event.trusted===true&&event.inputType==='deleteContentBackward'),'Untrusted fixture deletion');
    receipts.push({key:'Backspace',head:snapshot.head,exact:true,trusted:true,defaultPrevented:snapshot.backspaces[i].defaultPrevented,beforeInputObserved:snapshot.deletions.length>beforeInputCount,beforeInputEvents:snapshot.deletions.slice(beforeInputCount).map(event=>({...event}))});
  }
  return {mode:'autosave-trusted-backspace',markers:markers.length,receipts};
}
