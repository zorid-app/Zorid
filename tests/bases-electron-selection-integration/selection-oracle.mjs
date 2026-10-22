import assert from 'node:assert/strict';
import {body,targetLine} from './fixtures.mjs';

// Serialized into the renderer. This reads native DOM Selection only. A detached
// Range counts the visible line prefix; it is never installed as the Selection.
export function selectionFrame(document,selector){
  const editor=document.querySelector(selector),selection=document.getSelection();
  function point(node,offset){
    if(!editor||!node||!editor.contains(node))return null;
    const element=node.nodeType===1?node:node.parentElement,line=element?.closest('.cm-line');
    if(!line||!editor.contains(line))return null;
    const range=document.createRange();range.selectNodeContents(line);range.setEnd(node,offset);
    const linePrefix=range.toString();return{lineText:line.textContent,column:linePrefix.length,linePrefix};
  }
  return{rangeCount:selection?.rangeCount??0,collapsed:selection?.isCollapsed??null,selectedText:selection?.toString()??null,
    editorFocused:!!editor&&(document.activeElement===editor||editor.contains(document.activeElement)),
    anchor:selection?point(selection.anchorNode,selection.anchorOffset):null,head:selection?point(selection.focusNode,selection.focusOffset):null,
    document:{visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus()}};
}
export function assertSelection(frame,phase){
  assert.equal(frame.editorFocused,true,'Actual DOM focus returns to the ordinary editor');assert.equal(frame.rangeCount,1);
  assert.equal(frame.collapsed,phase.collapsed);assert.equal(frame.selectedText,phase.selected);
  for(const key of ['anchor','head']){
    assert.equal(frame[key]?.lineText,targetLine,'Selection remains on the exact body line');
    assert.equal(frame[key].column,phase[key],'Exact UTF16 line column and direction');
    assert.equal(frame[key].linePrefix,targetLine.slice(0,phase[key]),'Visible prefix independently agrees with the column');
  }
}
export function assertMapping(before,after,phase,sourceBefore,sourceAfter){
  assert.equal(sourceBefore,phase.before,'Exact independently expected pre-edit source');assert.equal(sourceAfter,phase.after,'Exact independently expected post-edit source');
  assertSelection(before,phase);assertSelection(after,phase);
  const start=source=>{const at=source.indexOf(body);assert.ok(at>=0&&source.endsWith(body)&&source.indexOf(body,at+1)===-1);return at;};
  const beforePrefix=start(sourceBefore),afterPrefix=start(sourceAfter);
  assert.equal(afterPrefix-beforePrefix,phase.delta,'Expected frontmatter prefix length change');
  const bodyLine=body.indexOf(targetLine),points={};assert.ok(bodyLine>=0);
  for(const key of ['anchor','head']){
    const bodyOffset=bodyLine+phase[key],oldAbsolute=beforePrefix+bodyOffset,newAbsolute=afterPrefix+bodyOffset;
    assert.equal(newAbsolute-oldAbsolute,phase.delta);points[key]={bodyUTF16:bodyOffset,beforeSourceUTF16:oldAbsolute,afterSourceUTF16:newAbsolute};
  }
  return{frontmatterBeforeUTF16:beforePrefix,frontmatterAfterUTF16:afterPrefix,deltaUTF16:phase.delta,selectedText:phase.selected,points};
}
