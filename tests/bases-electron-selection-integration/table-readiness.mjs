// A fixture precondition for the next intentional property edit. Read only the
// existing published DOM diagnostics; never advance/flush a product controller.
export function selectionTableReady(document,selector){
  const matches=document.querySelectorAll(selector),cell=matches[0];
  if(matches.length!==1||!cell?.isConnected)return false;
  const table=cell.closest('.zorid-bases-table[role="grid"]'),session=cell.closest('.bases-session'),content=session?.querySelector('.bases-session-content');
  if(!table||!session||!content?.contains(table)||!table.contains(cell))return false;
  const controller=session.getAttribute('data-base-controller-version'),rendered=table.getAttribute('data-base-rendered-version'),widget=cell.getAttribute('data-base-widget-version');
  const updating=session.getAttribute('data-base-controller-updating'),error=session.getAttribute('data-base-controller-error'),busy=content.getAttribute('aria-busy');
  if(!/^(0|[1-9]\d*)$/.test(controller??'')||controller!==rendered||controller!==widget)return false;
  if(updating!=='false'||error!=='false'||busy!=='false')return false;
  if(cell.hasAttribute('data-base-editing')||cell.querySelector('[data-base-editing],.zorid-bases-table-input')||cell.closest('[aria-disabled="true"],[inert]')||cell.matches(':disabled'))return false;
  return{controllerVersion:controller,renderedVersion:rendered,widgetVersion:widget,updating,error,busy,editing:null,rowCount:table.getAttribute('aria-rowcount'),observedAt:Date.now()};
}
