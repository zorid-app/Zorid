/** Real rendered Files tree only; no Workspace or bridge opening capability. */
export function sampleFileTree({path,reveal=false}){
  const tree=document.querySelector('.sidebar-content .file-tree[role="tree"]'),scroll=tree?.closest('.sidebar-content');
  if(!tree||!scroll)return {available:false};
  const rows=[...tree.querySelectorAll('.tree-row[data-path]')],row=rows.find(row=>row.dataset.path===path);
  if(row&&reveal)row.scrollIntoView({block:'center'});
  const viewport=scroll.getBoundingClientRect(),rect=row?.getBoundingClientRect();
  return {available:viewport.width>0&&viewport.height>0,top:scroll.scrollTop,height:scroll.clientHeight,extent:scroll.scrollHeight,
    viewport:{left:viewport.left,top:viewport.top,width:viewport.width,height:viewport.height},renderedRows:rows.length,
    mountedRange:[rows[0]?.dataset.path??null,rows.at(-1)?.dataset.path??null],found:!!row,
    visible:!!rect&&rect.width>0&&rect.height>0&&rect.top>=viewport.top&&rect.bottom<=viewport.bottom,
    point:rect?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null};
}
export async function navigateFileTree(renderer,path,{now=()=>performance.now(),timeoutMs=30000,receipt={}}={}){
  Object.assign(receipt,{path,startedAtMs:now(),scrollSteps:0,rowUnavailableWaitMs:0});
  let value=await renderer.evaluate(`(${sampleFileTree.toString()})(${JSON.stringify({path,reveal:true})})`);
  if(!value.found||!value.visible)throw Object.assign(Error('Expected normal UI control missing'),{navigation:receipt});
  receipt.locatedAtMs=now();
  await renderer.call('Input.dispatchMouseEvent',{type:'mousePressed',...value.point,button:'left',clickCount:1});
  await renderer.call('Input.dispatchMouseEvent',{type:'mouseReleased',...value.point,button:'left',clickCount:1});
  receipt.clickedAtMs=now();receipt.totalMs=receipt.clickedAtMs-receipt.startedAtMs;return receipt;
}
