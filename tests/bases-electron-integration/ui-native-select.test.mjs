import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {UI} from './ui.mjs';

// DOM-only diagnostic contract. JSDOM deliberately does not implement a native
// select menu; this test cannot establish platform keyboard behavior.
test('native select keeps every original key and failed readback while retaining passive frames',async()=>{
  const dom=new JSDOM('<body><select aria-label="Option color"><option value="">Default</option>'+['gray','red','orange','yellow','green','cyan','blue','purple','pink','brown'].map(x=>`<option>${x}</option>`).join('')+'</select></body>',{runScripts:'outside-only'});
  const {document,HTMLElement}=dom.window,select=document.querySelector('select'),calls=[],actions=[],reads=[];
  const rect={x:0,y:0,width:100,height:20};HTMLElement.prototype.getClientRects=()=>[rect];HTMLElement.prototype.getBoundingClientRect=()=>rect;HTMLElement.prototype.scrollIntoView=()=>{};document.elementFromPoint=()=>select;
  const cdp={evaluate(source){reads.push(source);return structuredClone(dom.window.eval(source));},async call(method,params){calls.push({method,params});if(params.type==='mouseReleased')select.focus();}};
  const ui=new UI(cdp,actions),wait=ui.wait.bind(ui);ui.wait=(body,label,timeout)=>wait(body,label,Math.min(timeout??20000,30));
  try{
    await assert.rejects(ui.select('select','purple'),/Native select accepted keyboard input/);
    assert.equal(select.value,'','Diagnostics did not select or assign an option');
    assert.deepEqual(calls.filter(x=>x.params.type==='keyDown').map(x=>x.params.key),['Home',...Array(8).fill('ArrowDown'),'Enter']);
    assert.equal(calls.filter(x=>x.params.type==='mousePressed').length,1);
    const frames=actions.filter(x=>x.action==='native-select-frame');assert.equal(frames.length,23);
    assert.deepEqual(frames.map(x=>x.phase),['before-click','after-click','before-Home','after-Home',...Array.from({length:8},(_,i)=>['before-ArrowDown-'+(i+1),'after-ArrowDown-'+(i+1)]).flat(),'before-Enter','after-Enter','readback-failed']);
    assert.ok(frames.every(x=>x.value===''&&x.selectedIndex===0&&x.expectedValue==='purple'&&x.matches===1&&x.connected));
    assert.equal(frames[0].focus.isSelect,false);assert.equal(frames.at(-1).focus.isSelect,true);assert.equal(frames.at(-1).focus.label,'Option color');
    assert.deepEqual(frames.at(-1).options.map(x=>x.value),['','gray','red','orange','yellow','green','cyan','blue','purple','pink','brown']);
    assert.ok(frames.every(x=>x.open===null||typeof x.open==='boolean'),'Unsupported :open remains explicit');
    assert.ok(reads.every(source=>!source.includes('dispatchEvent')&&!/\.value\s*=(?!=)/.test(source)),'Renderer calls never inject native-select value/events');
  }finally{dom.window.close();}
});
