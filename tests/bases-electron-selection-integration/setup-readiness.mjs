// These are observed UI setup boundaries, not workspace/navigation APIs.
export function selectionSplitReady(document,originalTabId){
  const panes=[...document.querySelectorAll('.pane')];
  if(panes.length!==2||!originalTabId)return false;
  const states=panes.map(pane=>{
    const sessions=pane.querySelectorAll('.bases-session'),session=sessions[0],grid=session?.querySelector('.zorid-bases-table[role="grid"]');
    const tab=pane.querySelector('.tab.is-active'),version=session?.getAttribute('data-base-controller-version');
    if(sessions.length!==1||!grid?.isConnected||grid.getAttribute('aria-rowcount')!=='2'||!tab?.dataset.tabId)return null;
    if(!/^(0|[1-9]\d*)$/.test(version??'')||grid.getAttribute('data-base-rendered-version')!==version)return null;
    if(session.getAttribute('data-base-controller-updating')!=='false'||session.getAttribute('data-base-controller-error')!=='false'||session.querySelector('.bases-session-content')?.getAttribute('aria-busy')!=='false')return null;
    return{tabId:tab.dataset.tabId,active:pane.classList.contains('is-active'),rowCount:2,version};
  });
  if(states.some(state=>!state)||states.filter(state=>state.active).length!==1)return false;
  const original=states.find(state=>state.tabId===originalTabId),active=states.find(state=>state.active);
  if(!original||active.tabId===originalTabId||states[0].tabId===states[1].tabId)return false;
  return{paneCount:2,originalTabId,newActiveTabId:active.tabId,states,observedAt:Date.now()};
}
export function selectionNoteMode(document,title){
  const panes=[...document.querySelectorAll('.pane')].filter(pane=>pane.querySelector('input.note-title')?.value===title);
  if(panes.length!==1||!panes[0].classList.contains('is-active'))return false;
  const pane=panes[0],toggle=pane.querySelector('button[data-hotkey-command="toggle-reading"]'),name=toggle?.getAttribute('data-hotkey-name');
  const preview=pane.querySelector('.markdown-preview'),editor=pane.querySelector('.cm-content[contenteditable="true"]');
  let mode;if(name==='Switch to Live Edit'&&preview?.isConnected&&!editor)mode='reading';
  else if(name==='Switch to reading view'&&editor?.isConnected&&!preview)mode='live';
  else return false;
  return{title,mode,tabId:pane.querySelector('.tab.is-active')?.getAttribute('data-tab-id')??null,observedAt:Date.now()};
}
export async function waitSelectionNoteLive(c){
  const title='Selection note',read=`(${selectionNoteMode.toString()})(document,${JSON.stringify(title)})`;
  const initial=await c.ui.wait(`return ${read};`,'Expected note title and mounted mode surface');
  c.evidence.actions.push({action:'selection-note-mode-mounted',initial,at:Date.now()});
  if(initial.mode==='reading')await c.ui.click('.pane.is-active button[data-hotkey-command="toggle-reading"][data-hotkey-name="Switch to Live Edit"]');
  const final=initial.mode==='live'?initial:await c.ui.wait(`const state=${read};return state?.mode==='live'?state:false;`,'Ordinary Live Edit surface after one mode switch');
  c.evidence.actions.push({action:'selection-note-live-ready',final,at:Date.now()});return final;
}
