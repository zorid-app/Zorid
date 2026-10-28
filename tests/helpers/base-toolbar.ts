/** Exercise the public settings navigation after secondary toolbar actions move
 * into their supported settings panels. Returns the persistent opening anchor. */
export function openBaseToolbarPanel(doc:Document,name:'Group'|'Properties'|'Results'):HTMLButtonElement|undefined {
 const current=doc.querySelector<HTMLElement>('.bases-toolbar-popover');
 if(current?.dataset.panel===name){current.querySelector<HTMLButtonElement>('[data-panel-action="close"]')?.click();return;}
 const settings=doc.querySelector<HTMLButtonElement>('[data-toolbar-action="settings"]');
 if(!settings&&name==='Results'){
  const views=doc.querySelector<HTMLButtonElement>('button[aria-label="Views"]');views?.click();
  doc.querySelector<HTMLButtonElement>('.bases-toolbar-popover button[aria-label="Results"]')?.click();return views??undefined;
 }
 if(!settings)return;
 if(current?.dataset.panel!=='View settings')settings.click();
 const overview=doc.querySelector<HTMLElement>('.bases-toolbar-popover[data-panel="View settings"]');
 if(!overview)return settings;
 if(name==='Results'){
  overview.querySelector<HTMLButtonElement>('[data-setting="layout"]')?.click();
  doc.querySelector<HTMLButtonElement>('.bases-toolbar-popover button[aria-label="Load limit"]')?.click();
 }else overview.querySelector<HTMLButtonElement>(`[data-setting="${name==='Group'?'group':'property-visibility'}"]`)?.click();
 return settings;
}
