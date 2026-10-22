import assert from 'node:assert/strict';
import {delay,until} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {createClipboardGuard} from './clipboard.mjs';
import {nativePasteReceipt} from './paste-probe.mjs';
export const vaultName='native-clipboard-vault';
const active='.pane.is-active .bases-session';
const dialog=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const base=`formulas:\n  derived: '"computed"'\nviews:\n  - name: Source\n    type: table\n    filters: lane == "source"\n    order: [file.name, note.sourceA, note.sourceB]\n    sort: [{property: file.name, direction: ASC}]\n  - name: Target\n    type: table\n    filters: lane == "target"\n    order: [file.name, note.prefix, note.left, note.right, formula.derived, note.topics, note.tail]\n    sort: [{property: file.name, direction: ASC}]\n  - name: Mixed\n    type: table\n    filters: lane == "target"\n    order: [file.name, note.left, formula.derived, note.right]\n    sort: [{property: file.name, direction: ASC}]\n  - name: Lists\n    type: table\n    filters: lane == "target"\n    order: [file.name, note.topics, note.tail]\n    sort: [{property: file.name, direction: ASC}]\n`;
export function fixtureFiles(){
  const files=new Map([['Clipboard.base',base],['Properties.yaml',`properties:\n  sourceA: {type: text}\n  sourceB: {type: number}\n  prefix: {type: text}\n  left: {type: text}\n  right: {type: number}\n  topics: {type: list}\n  tail: {type: text}\n`]]);
  for(let n=1;n<=2;n++)files.set(`Source 0${n}.md`,`---\nlane: source\nsourceA: L${n-1}\nsourceB: ${n*10}\nuntouched: source-${n}\n---\n# Source 0${n}\nKeep this source body.\n`);
  for(let n=1;n<=3;n++)files.set(`Target 0${n}.md`,`---\nlane: target\nprefix: prefix-${n}\nleft: left-${n}\nright: ${n}\ntopics:\n  - "[[Target 03|Existing alias]]"\n  - Existing\ntail: tail-${n}\nuntouched: target-${n}\n---\n# Target 0${n}\nKeep this target body.\n`);
  return files;
}
async function choose(c,name){await c.ui.button('Views',active);await c.ui.button(`Open view ${name}`,dialog('Views'));await c.ui.idle();}
async function nativeCommand(c,command){
  const mapping={copy:['c',MOD.meta],paste:['v',MOD.meta],undo:['z',MOD.meta],redo:['z',MOD.meta|MOD.shift]};const [key,modifiers]=mapping[command];
  await c.ui.key(key,{modifiers,commands:[command]});c.evidence.actions.push({action:'actual-chromium-editing-command',command,transport:'Input.dispatchKeyEvent.commands'});
}
async function acknowledgeCopy(c,clipboard,expected,name){
  await nativeCommand(c,'copy');
  const owned=await until(()=>clipboard.recordOwnedClipboard(expected),10000);
  assert.equal(await clipboard.readPlainText(),expected,'Independent pbpaste agrees with fixture TSV');
  c.evidence.checks.push({name,transport:'native-os-clipboard',plain:expected,...owned});
}
function fixtureClipboard({plain,raw,headers,rows}){
  if(!raw)return{'text/plain':plain,'text/markdown':'','obsidian/table':'','obsidian/bases-cells':''};
  const widths=headers.map((header,index)=>Math.max(header.length,...rows.map(row=>row[index].length))+2);
  const line=row=>'|'+row.map((value,index)=>{const remaining=widths[index]-value.length,left=Math.floor(remaining/2);return ' '.repeat(left)+value+' '.repeat(remaining-left);}).join('|')+'|';
  return{'text/plain':rows.map(row=>row.join('\t')).join('\n'),'text/markdown':[line(headers),'|'+widths.map(width=>' '+'-'.repeat(width-2)+' ').join('|')+'|',...rows.map(line)].join('\n'),'obsidian/table':JSON.stringify({header:headers,rows,alignment:headers.map(()=>null)}),'obsidian/bases-cells':JSON.stringify(raw)};
}
async function observeClipboard(c){
  await c.ui.dom(`window.__basesNativeClipboardProbe={pastes:[],expected:null};document.addEventListener('paste',event=>{const probe=window.__basesNativeClipboardProbe;probe.pastes.push((${nativePasteReceipt.toString()})(event,probe.expected));probe.expected=null;},{capture:true});return true;`);
}
async function paste(c,name,fixture){
  const expected=fixtureClipboard(fixture),before=await c.ui.dom(`window.__basesNativeClipboardProbe.expected=${JSON.stringify(expected)};return window.__basesNativeClipboardProbe.pastes.length;`);await nativeCommand(c,'paste');
  const observed=await c.ui.wait(`return window.__basesNativeClipboardProbe.pastes[${before}]??false;`,'Actual trusted native paste event');assert.equal(observed.trusted,true);assert.equal(observed.accepted,true,'Native clipboard formats did not match the fixture; paste was blocked for privacy.');
  if(fixture.raw)assert.ok(observed.types.includes('obsidian/bases-cells'),'Native clipboard route retained generated Bases custom MIME');
  // Only known fixture data may reach evidence; actual unexpected bytes remain
  // transient inside the browser and are blocked before production paste.
  c.evidence.checks.push({name,transport:'actual-native-paste-event',...observed,validatedFixtureFormats:expected});await c.ui.idle();
}
async function savedProperties(c,file,check,name){return c.saved(file,source=>{check(c.frontmatter(source));assert.match(source,/Keep this (?:source|target) body\./);},name);}
async function sourceRectangle(c,clipboard){
  await choose(c,'Source');await c.ui.selectCell('Source 01.md','note.sourceA');await c.ui.key('ArrowRight',{modifiers:MOD.shift});await c.ui.key('ArrowDown',{modifiers:MOD.shift});
  await acknowledgeCopy(c,clipboard,'L0\t10\nL1\t20','native-generated-two-by-two-copy');
}
async function restoreHistory(c,file,property,value,name){await c.ui.key('z',{modifiers:MOD.meta});await c.ui.idle();await savedProperties(c,file,p=>assert.deepEqual(p[property],value),name);}
async function editable(c,file,property){
  const cell=c.ui.cell(file,property);await c.ui.click(cell);const selector=`${cell} input:not([type="checkbox"]),${cell} textarea`;
  await c.ui.wait(`return document.activeElement?.matches(${JSON.stringify(selector)});`,'Actual metadata input owns focus');return selector;
}
async function pointerResize(c){
  await choose(c,'Source');const header=`${active} [role="columnheader"][title="note.sourceA"]`,handle=header+' .zorid-bases-table-resize';
  const width=await c.ui.dom(`return document.querySelector(${JSON.stringify(header)}).getBoundingClientRect().width;`),from=await c.ui.point(handle),to={x:from.x+64,y:from.y};
  await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});await c.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...from});
  for(let i=1;i<=8;i++)await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:from.x+8*i,y:from.y});
  await c.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...to});await c.ui.idle();c.evidence.actions.push({action:'trusted-pointer-column-resize',selector:handle,from,to,deltaX:64});
  await c.saved('Clipboard.base',source=>assert.ok(Math.abs(c.yaml.parse(source).views.find(v=>v.name==='Source').columnSize['note.sourceA']-(width+64))<=1),'pointer-column-resize-persists-intended-delta');
  await c.ui.click(handle,{count:2});await c.ui.idle();await c.saved('Clipboard.base',source=>assert.equal(c.yaml.parse(source).views.find(v=>v.name==='Source').columnSize?.['note.sourceA'],undefined),'double-click-resets-to-automatic-width');
  await c.ui.button('Views',active);await c.ui.button('Configure view Source',dialog('Views'));await c.ui.select(`${dialog('View options')} select[aria-label="Row height"]`,'Tall');
  for(let i=0;i<3&&await c.ui.dom(`return !!document.querySelector(${JSON.stringify(dialog('View options'))});`);i++){await c.ui.key('Escape');await delay(100);}
  await c.saved('Clipboard.base',source=>assert.equal(c.yaml.parse(source).views.find(v=>v.name==='Source').rowHeight,'tall'),'row-height-setting-is-durable');
  await c.ui.wait(`return document.querySelector('${active} .zorid-bases-table').style.getPropertyValue('--zorid-base-row-height')==='120px';`,'Tall rows use reference fourfold geometry');await c.screenshot('native-clipboard-pointer-resize-and-tall-rows');
}
async function inputOwnership(c,clipboard){
  await choose(c,'Target');const original=await c.read('Target 01.md');await editable(c,'Target 01.md','note.left');
  await c.ui.key('a',{modifiers:MOD.meta,commands:['selectAll']});await c.cdp.call('Input.insertText',{text:'unsubmitted native draft'});
  await nativeCommand(c,'undo');await c.ui.wait(`return document.activeElement?.value==='L0';`,'Native input undo restores local draft baseline');assert.equal(await c.read('Target 01.md'),original,'Input undo cannot consume Bases history');
  await c.ui.key('Escape');await c.ui.idle();assert.equal(await c.read('Target 01.md'),original,'Escape discards local input draft without Base undo');
  await editable(c,'Target 01.md','note.left');
  await c.ui.dom(`window.__basesCompositionProbe=[];for(const type of ['compositionstart','compositionupdate','compositionend','keydown'])document.addEventListener(type,event=>{if(event.target?.matches('input.metadata-input,textarea'))window.__basesCompositionProbe.push({type:event.type,trusted:event.isTrusted,key:event.key??null,composing:event.isComposing??null});},{capture:true});return true;`);
  await c.ui.key('a',{modifiers:MOD.meta,commands:['selectAll']});
  await c.cdp.call('Input.imeSetComposition',{text:'に',selectionStart:1,selectionEnd:1});c.evidence.actions.push({action:'chromium-ime-composition-protocol',text:'に',selectionStart:1,selectionEnd:1});
  await c.ui.key('Enter');await delay(150);assert.equal(await c.read('Target 01.md'),original,'Composition Enter cannot save a property or invoke Bases history');
  await c.cdp.call('Input.insertText',{text:'にほん'});await c.ui.wait(`return document.activeElement?.value?.includes('にほん');`,'Trusted composition commits to the local input only');
  for(let i=0;i<2&&await c.ui.dom(`return !!document.querySelector(${JSON.stringify(c.ui.cell('Target 01.md','note.left')+' [data-base-editing],'+c.ui.cell('Target 01.md','note.left')+' input')});`);i++)await c.ui.key('Escape');
  assert.equal(await c.read('Target 01.md'),original,'Cancelling composed input preserves durable note');
  const events=await c.ui.dom('return window.__basesCompositionProbe;');assert.ok(events.some(event=>event.type==='compositionstart'&&event.trusted),'CDP exercised real Chromium compositionstart');assert.ok(events.some(event=>event.type==='keydown'&&event.key==='Enter'&&event.composing&&event.trusted),'Enter belonged to a trusted active composition');
  c.evidence.checks.push({name:'native-input-undo-escape-and-chromium-composition-ownership',events,limitation:'Chromium IME protocol, not a physical macOS input-source keyboard session'});
}
export async function journey(c){
  const clipboard=createClipboardGuard();await clipboard.capture();
  try{
    await c.launch('actual-os-clipboard-and-input-ownership');await c.ui.openFile('Clipboard.base');await c.ui.idle();await observeClipboard(c);
    await sourceRectangle(c,clipboard);await choose(c,'Target');await c.ui.selectCell('Target 01.md','note.left');
    await paste(c,'native-custom-mime-offset-paste',{headers:['sourceA','sourceB'],rows:[['L0','10'],['L1','20']],raw:[[{type:'note',data:'L0'},{type:'note',data:10}],[{type:'note',data:'L1'},{type:'note',data:20}]]});
    for(const[n,left,right]of[[1,'L0',10],[2,'L1',20]])await savedProperties(c,`Target 0${n}.md`,p=>{assert.equal(p.left,left);assert.equal(p.right,right);assert.equal(typeof p.right,'number');assert.equal(p.prefix,`prefix-${n}`);},'native-offset-paste-'+n);
    await sourceRectangle(c,clipboard);await choose(c,'Target');await c.ui.selectCell('Target 03.md','note.right');await paste(c,'native-clipped-paste-skips-derived-target',{headers:['sourceA','sourceB'],rows:[['L0','10'],['L1','20']],raw:[[{type:'note',data:'L0'},{type:'note',data:10}],[{type:'note',data:'L1'},{type:'note',data:20}]]});
    await savedProperties(c,'Target 03.md',p=>{assert.equal(p.right,'L0');assert.equal(p.left,'left-3');assert.equal(p.derived,undefined);},'native-clipped-last-row');await restoreHistory(c,'Target 03.md','right',3,'undo-clipped-native-paste');
    await choose(c,'Source');await c.ui.selectCell('Source 01.md','note.sourceA');await c.ui.key(' ',{code:'Space',modifiers:MOD.control});await acknowledgeCopy(c,clipboard,'L0\nL1','native-copy-selected-column');
    await c.ui.key('Escape');await c.ui.selectCell('Source 01.md','note.sourceA');await c.ui.key(' ',{code:'Space',modifiers:MOD.shift});await acknowledgeCopy(c,clipboard,'Source 01\tL0\t10','native-copy-selected-row');
    await choose(c,'Mixed');await c.ui.selectCell('Target 03.md','note.left');await paste(c,'native-mixed-readonly-source-and-destination',{headers:['file name','sourceA','sourceB'],rows:[['Source 01','L0','10']],raw:[[{type:'file'},{type:'note',data:'L0'},{type:'note',data:10}]]});
    await savedProperties(c,'Target 03.md',p=>{assert.equal(p.left,'left-3');assert.equal(p.right,10);assert.equal(p.derived,undefined);},'native-mixed-readonly-paste');await restoreHistory(c,'Target 03.md','right',3,'undo-mixed-native-paste');
    await choose(c,'Source');await c.ui.selectCell('Source 01.md','note.sourceA');await c.ui.key('a',{modifiers:MOD.meta});await acknowledgeCopy(c,clipboard,'Source 01\tL0\t10\nSource 02\tL1\t20','native-copy-whole-current-group');
    await c.ui.key('Escape');await editable(c,'Source 01.md','note.sourceA');await c.ui.key('a',{modifiers:MOD.meta,commands:['selectAll']});await acknowledgeCopy(c,clipboard,'L0','native-copy-from-real-input');await c.ui.key('Escape');
    await choose(c,'Lists');await c.ui.selectCell('Target 01.md','note.topics');await paste(c,'native-plain-scalar-appends-readable-raw-list',{plain:'L0'});
    await savedProperties(c,'Target 01.md',p=>assert.deepEqual(p.topics,['[[Target 03|Existing alias]]','Existing','L0']),'native-list-append-preserves-alias-and-existing-values');
    await pointerResize(c);await inputOwnership(c,clipboard);await c.screenshot('native-clipboard-final');await c.quit('clipboard-campaign-normal-quit');
  }finally{const restored=await clipboard.restore();c.evidence.checks.push({name:'private-original-os-clipboard-restored',...restored});}
}
