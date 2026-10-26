// A durable source read does not acknowledge the toolbar save/publication tail.
// Observe only the current public UI before issuing the existing close key.
export function filterCloseReadiness(document,panelName='Filter',triggerLabel=panelName,requireTable=true) {
  const panels=[...document.querySelectorAll(`[role="dialog"][aria-label=${JSON.stringify(panelName)}]`)].filter(node=>node.isConnected&&!node.closest('[hidden],[aria-hidden="true"]'));
  const panel=panels[0],session=document.querySelector('.pane.is-active .bases-session'),content=session?.querySelector('.bases-session-content'),grid=content?.querySelector('[role="grid"]');
  const focused=document.activeElement,attr=(node,name)=>node?.getAttribute(name)??null;
  const controllerVersion=attr(session,'data-base-controller-version'),renderedVersion=attr(grid,'data-base-rendered-version');
  const busy=attr(content,'aria-busy'),updating=attr(session,'data-base-controller-updating'),error=attr(session,'data-base-controller-error');
  const alerts=panel?[...panel.querySelectorAll('[role="alert"]')].filter(node=>!node.closest('[hidden],[aria-hidden="true"]')).map(node=>node.textContent.trim()).filter(Boolean):[];
  const trigger=session?.querySelector(`button[aria-label=${JSON.stringify(triggerLabel)}]`),ownedFocus=!!focused?.isConnected&&!!panel?.contains(focused);
  const disabled=!!focused?.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],[inert]')||!!focused?.matches(':disabled');
  const expanded=!!panel?.querySelector('[role="combobox"][aria-expanded="true"],.cm-tooltip-autocomplete');
  const ready=panels.length===1&&!!session?.isConnected&&(requireTable===false||!!grid?.isConnected)&&attr(trigger,'aria-expanded')==='true'&&ownedFocus&&!disabled&&!expanded&&!alerts.length
    &&busy==='false'&&updating==='false'&&error==='false'&&/^(0|[1-9]\d*)$/.test(controllerVersion??'')&&(!grid||controllerVersion===renderedVersion);
  return {ready,observedAt:Date.now(),panelName,triggerLabel,requireTable,gridPresent:!!grid?.isConnected,panelCount:panels.length,controllerVersion,renderedVersion,busy,updating,error,alerts,expanded,ownedFocus,disabled,
    focus:{tag:focused?.tagName??null,role:attr(focused,'role'),label:attr(focused,'aria-label')}};
}

export async function closeAcknowledgedToolbarPanel(c,{panelName='Filter',triggerLabel=panelName,action='typed-filter-close-ready',requireTable=true}={}) {
  // Keep the existing single child-popup dismissal. The next key belongs to
  // the parent only after the real current save has finished acknowledging.
  const selector=`[role="dialog"][aria-label=${JSON.stringify(panelName)}]`;
  if(await c.ui.dom(`const panel=document.querySelector(${JSON.stringify(selector)});return !![...(panel?.querySelectorAll('[role="listbox"],.cm-tooltip-autocomplete')??[])].find(e=>e.getClientRects().length);`))await c.ui.key('Escape');
  const frame=await c.ui.wait(`const frame=(${filterCloseReadiness.toString()})(document,${JSON.stringify(panelName)},${JSON.stringify(triggerLabel)},${JSON.stringify(requireTable)});return frame.ready?frame:false;`,`Current ${panelName} close input is settled`,45000);
  c.evidence.actions.push({action,...frame});
  await c.ui.key('Escape');
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(selector)});`,`${panelName} closes after acknowledgement`);
}

export async function closeTypedFilter(c) { await closeAcknowledgedToolbarPanel(c); }
