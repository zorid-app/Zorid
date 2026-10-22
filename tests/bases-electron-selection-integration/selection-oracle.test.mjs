import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {phases,prefix,word,targetLine,body,sources,fixtureFiles} from './fixtures.mjs';
import {assertSelection,assertMapping,selectionFrame} from './selection-oracle.mjs';

function frame(phase){return{editorFocused:true,rangeCount:1,collapsed:phase.collapsed,selectedText:phase.selected,
  anchor:{lineText:targetLine,column:phase.anchor,linePrefix:targetLine.slice(0,phase.anchor)},head:{lineText:targetLine,column:phase.head,linePrefix:targetLine.slice(0,phase.head)}};}
test('independent mapping pins positive and negative frontmatter deltas with unchanged body offsets',()=>{
  assert.equal(phases.length,2);assert.equal(prefix.length,[...prefix].length+1,'Visible crab occupies two UTF16 units but one keyboard character');
  for(const phase of phases){const mapping=assertMapping(frame(phase),frame(phase),phase,phase.before,phase.after);
    assert.equal(mapping.deltaUTF16,phase.delta);assert.equal(mapping.points.anchor.bodyUTF16,body.indexOf(targetLine)+prefix.length);
    assert.equal(mapping.points.head.afterSourceUTF16-mapping.points.head.beforeSourceUTF16,phase.delta);
    assert.equal(phase.after.slice(mapping.points.anchor.afterSourceUTF16,mapping.points.head.afterSourceUTF16),phase.selected);
  }
});
test('caret/range oracle rejects collapsed selection loss, direction changes, wrong Unicode column and shifted visible text',()=>{
  const phase=phases[1];assertSelection(frame(phase),phase);
  for(const mutate of [value=>{value.collapsed=true;},value=>{value.selectedText='CHARLIE';},value=>{value.anchor.column--;},value=>{value.head.lineText='Changed body';},value=>{value.editorFocused=false;},value=>{value.rangeCount=0;},value=>{[value.anchor,value.head]=[value.head,value.anchor];}]){const wrong=frame(phase);mutate(wrong);assert.throws(()=>assertSelection(wrong,phase));}
  const caret=frame(phases[0]);caret.selectedText=word;assert.throws(()=>assertSelection(caret,phases[0]));
});
test('whole-source mapping rejects body edits or a property result with no expected prefix growth',()=>{
  const phase=phases[0];
  assert.throws(()=>assertMapping(frame(phase),frame(phase),phase,phase.before,phase.after.replace(word,'XXXXX')));
  assert.throws(()=>assertMapping(frame(phase),frame(phase),phase,phase.before,sources.initial));
  assert.equal(fixtureFiles().get('Selection note.md'),sources.initial);
});
test('passive DOM frame reads native range UTF16 columns without installing or resetting a selection',()=>{
  const dom=new JSDOM('<div id="editor" tabindex="0" contenteditable="true"><div class="cm-line"></div></div>'),document=dom.window.document;
  try{
    const editor=document.querySelector('#editor'),line=editor.firstElementChild;line.textContent=targetLine;editor.focus();
    const selection=document.getSelection();
    for(const phase of phases){
      // This is offline DOM fixture setup only. The actual campaign establishes
      // its range exclusively with trusted keyboard input.
      const range=document.createRange();range.setStart(line.firstChild,phase.anchor);range.setEnd(line.firstChild,phase.head);selection.removeAllRanges();selection.addRange(range);
      const anchor=selection.anchorNode,head=selection.focusNode;
      const setters=['removeAllRanges','addRange','collapse','setBaseAndExtent'],original=new Map(setters.map(name=>[name,selection[name]]));
      try{
        for(const name of setters)selection[name]=()=>{throw Error('Passive capture cannot change native Selection');};
        assertSelection(selectionFrame(document,'#editor'),phase);assert.equal(selection.anchorNode,anchor);assert.equal(selection.focusNode,head);assert.equal(line.textContent,targetLine);
      }finally{for(const[name,value]of original)selection[name]=value;}
    }
  }finally{dom.window.close();}
});
