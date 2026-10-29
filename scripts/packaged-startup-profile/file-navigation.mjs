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
export async function navigateFileTree(renderer,path,{now=()=>performance.now(),timeoutMs=30000,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),receipt={}}={}){
  Object.assign(receipt,{path,startedAtMs:now(),scrollSteps:0,rowReveals:0,rowUnavailableWaitMs:0});
  const sample=reveal=>renderer.evaluate(`(${sampleFileTree.toString()})(${JSON.stringify({path,reveal})})`);
  const frames=()=>renderer.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  let beganScan=false,extent=null;
  while(now()-receipt.startedAtMs<timeoutMs){
    const value=await sample(false);receipt.lastTree=value;
    if(value.available&&value.found){
      if(!value.visible){await sample(true);receipt.rowReveals++;await frames();continue;}
      receipt.locatedAtMs=now();
      await renderer.call('Input.dispatchMouseEvent',{type:'mousePressed',...value.point,button:'left',clickCount:1});
      await renderer.call('Input.dispatchMouseEvent',{type:'mouseReleased',...value.point,button:'left',clickCount:1});
      receipt.clickedAtMs=now();receipt.totalMs=receipt.clickedAtMs-receipt.startedAtMs;return receipt;
    }
    if(value.available){
      // Start at the top once; a growing namespace can insert the target above
      // the current window, so restart the normal scan when extent changes.
      const restart=!beganScan||extent!==null&&extent!==value.extent;
      extent=value.extent;beganScan=true;
      const delta=restart&&value.top>0?-value.extent:value.top+value.height<value.extent-1?Math.max(1,value.height*0.75):0;
      if(delta){
        await renderer.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:value.viewport.left+value.viewport.width/2,y:value.viewport.top+value.viewport.height/2,deltaX:0,deltaY:delta});
        receipt.scrollSteps++;await frames();continue;
      }
    }
    // An absent/unmounted row is not proof of virtualization or complete
    // inventory. Wait for ordinary UI publication, within this same clock.
    const before=now();await pause(25);receipt.rowUnavailableWaitMs+=now()-before;
  }
  receipt.totalMs=now()-receipt.startedAtMs;
  throw Object.assign(Error('Normal filetree target did not become available before navigation deadline: '+path),{navigation:receipt});
}
