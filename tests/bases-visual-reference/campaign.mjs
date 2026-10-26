import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {delay,until} from '../tasks-electron-integration/cdp.mjs';
import {fixtureFiles,template,singleBase} from './fixtures.mjs';
export {fixtureFiles,template};
export const vaultName='ReferenceVault';

const active='.pane.is-active .bases-session';
const panel=name=>`[role="dialog"][aria-label=${JSON.stringify(name)}]`;
const input=(label,scope='body')=>`${scope} input[aria-label=${JSON.stringify(label)}],${scope} [contenteditable=true][aria-label=${JSON.stringify(label)}]`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const specs={
  baseline:['Initial Table; three ordinary property notes.'],
  'view-menu':['Initial Table/Cards/List/Board ordering.'],
  'table-view-settings':['Configure Table while Table remains the active layout.'],
  'view-actions':['View actions; reference shell/menu glyph differences remain reviewable.'],
  'results-menu':['Three results; no limit.'],
  'filter-menu':['Same Base-wide two-condition membership.'],
  'properties-menu':['Five displayed properties; no registry.'],
  'sort-menu':['No configured sort.'],
  'group-menu':['Table has no grouping.'],
  'cost-header-menu':['Cost numeric header context menu.'],
  'summary-menu':['Cost header Summarize menu, prior to selecting a summary.'],
  'summary-picker':['Cost previews from numeric10/20 and one null; selected Sum preview must be30.'],
  'summary-sum-selected':['Selected Sum30 with all three notes.'],
  'cards-view-settings':['Configure Cards while Table is still active; size200, no image, ratio1.'],
  'cards-layout':['Cards renamed Gallery; same three notes and ordered file/status/cost fields.'],
  'list-view-settings':['Configure List while Gallery remains active.'],
  'list-layout':['Bullet list; separator comma-space; no indentation.'],
  'kanban-view-settings':['Configure Board while List remains active; width280, no image, ratio0.5.'],
  'kanban-layout':['Board groups Done/In progress/Planned, one item each.'],
  'kanban-group-menu':['Same Board groups and saved manual order.'],
  'new-item-template-popover':['Reference Board with one new template note; cost7, statusPlanned.','Zorid deliberately retains the full literal template body; Obsidian copies only its properties.'],
  'new-title-focused':['Separate Single/Solo table state; three originals, priorUntitled and newUntitled1.','Template body remains a deliberate Zorid addition; title focus and exact selected text are independently asserted.'],
  'new-title-focus-retained':['Same New title remains selected after1000ms with no input.'],
};

// A fresh reference version must carry its own successful runtime provenance;
// old screenshots are not relabelled merely because the installed app updated.
export function validateReferenceProvenance(value,labels=Object.keys(specs)){
  assert.equal(value?.schemaVersion,1,'Known visual reference provenance schema');
  assert.equal(value.kind,'actual-obsidian-bases-visual-reference');
  assert.equal(value.status,'passed','Complete reference capture run required');
  assert.equal(value.application?.name,'Obsidian');
  assert.match(value.application.version,/^\d+\.\d+\.\d+$/,'Explicit observed reference version');
  assert.equal(value.runtime?.applicationVersion,value.application.version,'Observed runtime and selected package version agree');
  for(const key of ['sha256','appJsSHA256'])assert.match(value.application.artifact?.[key]??'',/^[a-f0-9]{64}$/,'Pinned reference artifact '+key);
  assert.deepEqual(value.viewport,{width:1024,height:800,deviceScaleFactor:2});
  assert.equal(value.theme,'dark');assert.equal(value.nativeMenus,false);
  assert.equal(value.sourceFrozen,true,'Reference helper/fixtures remained unchanged');
  assert.equal(value.cleanup?.verified,true,'Reference owned-process cleanup verified');
  assert.ok(Array.isArray(value.states));
  assert.deepEqual(value.states.map(state=>state.label),labels,'Exact complete matched state sequence');
  for(const state of value.states){
    assert.ok(Array.isArray(state.notes)&&state.notes.every(note=>typeof note==='string'),'Observed per-state notes');
    assert.match(state.sourceSHA256??'',/^[a-f0-9]{64}$/,'Exact captured Base source identity');
  }
  assert.ok(value.files&&typeof value.files==='object'&&!Array.isArray(value.files));
  for(const file of [...labels.flatMap(label=>[label+'.png',label+'.json']),'capture-catalog.json','before-template-base.txt'])assert.match(value.files[file]??'',/^[a-f0-9]{64}$/,'Reference file identity '+file);
  return value;
}

async function dismiss(c,label){
  for(let i=0;i<3&&await c.ui.dom(`return !!document.querySelector(${JSON.stringify(panel(label))});`);i++){await c.ui.key('Escape');await delay(300);}
  await c.ui.wait(`return !document.querySelector(${JSON.stringify(panel(label))});`,'Dismiss '+label);await c.ui.idle();
}
async function choose(c,name){await c.ui.button('Views',active);await c.ui.button('Open view '+name,panel('Views'));await c.ui.wait(`return document.querySelector('${active} button[aria-label="Views"]')?.textContent===${JSON.stringify(name)};`,'Selected '+name);await c.ui.idle();}
async function configure(c,name){await c.ui.button('Views',active);await c.ui.button('Configure view '+name,panel('Views'));await c.ui.wait(`return !!document.querySelector(${JSON.stringify(panel('View options'))});`,'Configure '+name);}
async function viewport(c){
  await c.cdp.call('Emulation.setDeviceMetricsOverride',{width:1024,height:800,deviceScaleFactor:2,mobile:false,screenWidth:1024,screenHeight:800});
  await c.cdp.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
  await c.ui.wait(`return innerWidth===1024&&innerHeight===800&&devicePixelRatio===2&&document.documentElement.dataset.theme==='dark';`,'Exact1024×800 DPR2 dark reference viewport');
}
async function offline(c,label,files){
  for(const[file,source]of files){assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'));await fs.mkdir(path.dirname(path.join(c.vault,file)),{recursive:true});await fs.writeFile(path.join(c.vault,file),source);}
  c.evidence.actions.push({action:'offline-reference-fixture-stage',label,files:[...files].map(([file,source])=>({file,source,sha256:hash(source)})),at:Date.now()});
}

export async function journey(c){
  const arg=process.argv.indexOf('--reference');assert.ok(arg>=0&&process.argv[arg+1],'Explicit --reference');
  const reference=await fs.realpath(process.argv[arg+1]);
  const provenanceBytes=await fs.readFile(path.join(reference,'reference-provenance.json'));
  const provenance=validateReferenceProvenance(JSON.parse(provenanceBytes));
  const referenceFiles=new Map([['reference-provenance.json',hash(provenanceBytes)]]),captures=[];
  for(const[file,expected]of Object.entries(provenance.files)){
    assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'),'Owned relative reference file');
    assert.equal(hash(await fs.readFile(path.join(reference,file))),expected,'Reference provenance file identity '+file);
    referenceFiles.set(file,expected);
  }
  const catalog=JSON.parse(await fs.readFile(path.join(reference,'capture-catalog.json'),'utf8'));
  assert.ok(Array.isArray(catalog));assert.deepEqual(catalog.map(item=>item.label),Object.keys(specs),'Exact matched capture catalog');
  const notes=label=>[...specs[label],...provenance.states.find(state=>state.label===label).notes];
  for(const label of Object.keys(specs)){
    const png=await fs.readFile(path.join(reference,label+'.png')),json=await fs.readFile(path.join(reference,label+'.json'));
    const expected=catalog.find(item=>item.label===label);assert.ok(expected,'Known reference state '+label);assert.equal(hash(png),expected.sha256,'Retained reference PNG identity '+label);
    const state=JSON.parse(json),declared=provenance.states.find(item=>item.label===label);
    assert.equal(state.applicationVersion,provenance.application.version,'Reference state version '+label);
    assert.deepEqual(state.viewport,provenance.viewport,'Reference state viewport '+label);assert.equal(state.theme,'dark','Reference state theme '+label);
    assert.equal(typeof state.baseSource,'string');assert.equal(hash(state.baseSource),declared.sourceSHA256,'Reference state source identity '+label);
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[2048,1600],'Reference pixels '+label);
    for(const[ext,bytes]of[['png',png],['json',json]]){referenceFiles.set(label+'.'+ext,hash(bytes));await fs.writeFile(path.join(c.outputDirectory,'obsidian-'+label+'.'+ext),bytes);}
  }
  const reconstruction=await fs.readFile(path.join(reference,'before-template-base.txt'));referenceFiles.set('before-template-base.txt',hash(reconstruction));
  c.evidence.reference={directory:reference,application:provenance.application,runtime:provenance.runtime,files:Object.fromEntries(referenceFiles),reconstructionSource:reconstruction.toString(),captureSpecs:specs};
  c.evidence.limitations.push('Matching reference data/viewport and paired screenshots are inputs to visual review, not an automated pixel-parity assertion.','Per-state reference observations and deliberate Zorid additions are recorded separately; an older reference version is not assumed equivalent.');
  const capture=async(label,extra={})=>{
    assert.ok(Object.hasOwn(specs,label));await c.ui.wait(`return innerWidth===1024&&innerHeight===800&&devicePixelRatio===2;`,'Capture viewport '+label);
    await c.screenshot(label);
    const snapshot=await c.ui.dom(`const rect=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,fontSize:s.fontSize,padding:s.padding,border:s.border,bg:s.backgroundColor}};const visible=e=>e.getClientRects().length&&!e.closest('[hidden]');const focused=document.activeElement;return{title:document.title,viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio},theme:document.documentElement.dataset.theme,focused:focused?{tag:focused.tagName,cls:focused.className,text:focused.innerText?.slice(0,200),value:focused.value??null,selectedText:document.getSelection()?.toString()}:null,body:document.body.innerText,menus:[...document.querySelectorAll('[role=dialog],[role=menu],.bases-new-item-popover')].filter(visible).map(e=>({cls:e.className,aria:e.getAttribute('aria-label'),text:e.innerText,rect:rect(e)})),inputs:[...document.querySelectorAll('input,textarea,select')].filter(visible).map(e=>({tag:e.tagName,type:e.type,value:e.value,aria:e.getAttribute('aria-label'),cls:e.className})),metrics:[...document.querySelectorAll('.bases-session-toolbar,.bases-toolbar-action,.zorid-bases-table-header,.zorid-bases-table-column,.zorid-bases-table-body [role=row],.bases-cards-item,.bases-list-item,.bases-kanban-column,.bases-kanban-card')].filter(visible).slice(0,80).map(e=>({cls:e.className,text:e.innerText.slice(0,100),...rect(e)}))};`);
    const png=await fs.readFile(path.join(c.outputDirectory,label+'.png'));assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[2048,1600],'Actual capture pixels');
    const row={label,referencePNG:'obsidian-'+label+'.png',actualPNG:label+'.png',referenceJSON:'obsidian-'+label+'.json',actualJSON:label+'.json',actualSHA256:hash(png),notes:notes(label),...extra};
    await fs.writeFile(path.join(c.outputDirectory,label+'.json'),JSON.stringify({...snapshot,...row,baseSource:await c.read(label.startsWith('new-title')?'Single.base':'Reference.base')},null,2));captures.push(row);c.evidence.checks.push({name:'matched-reference-capture-'+label,...row});
  };
  try{
    await c.launch('reference-three-note-baseline');await viewport(c);await c.ui.openFile('Reference.base');await c.ui.idle();
    await c.ui.wait(`return document.querySelector('${active} [role=grid]')?.getAttribute('aria-rowcount')==='4';`,'Exactly three reference items without summary');
    assert.ok(!(await fs.readdir(c.vault)).includes('Properties.yaml'),'No definition registry fixture');
    for(const[file,cost,status,favorite,due]of[['Alpha',10,'Planned',true,'2026-10-22'],['Beta',20,'In progress',false,'2026-10-23'],['Gamma',null,'Done',false,null]]){
      const raw=c.frontmatter(await c.read('Items/'+file+'.md'));assert.equal(raw.cost,cost);assert.equal(raw.status,status);assert.equal(raw.favorite,favorite);assert.equal(raw.due,due);
      await c.ui.wait(`const e=document.querySelector(${JSON.stringify(c.ui.cell('Items/'+file+'.md','note.cost'))});return e&&e.textContent.trim()===${JSON.stringify(cost===null?'':String(cost))};`,'Actual inferred cost '+file);
    }
    await capture('baseline');
    await c.ui.button('Views',active);await capture('view-menu');await dismiss(c,'Views');
    await configure(c,'Table');await capture('table-view-settings');await c.ui.button('View actions',panel('View options'));await capture('view-actions');await dismiss(c,'View options');
    for(const[name,label]of[['Results','results-menu'],['Filter','filter-menu'],['Properties','properties-menu'],['Sort','sort-menu'],['Group','group-menu']]){await c.ui.button(name,active);await c.ui.wait(`return !!document.querySelector(${JSON.stringify(panel(name))});`,'Visible '+name);await capture(label);await dismiss(c,name);}
    await c.ui.click(`${active} [role=columnheader][title="note.cost"]`,{button:'right'});await c.ui.wait(`return !!document.querySelector('.context-menu');`,'Cost header context menu');await capture('cost-header-menu');await capture('summary-menu');await c.ui.button('Summarize...','.context-menu');
    await c.ui.wait(`const row=document.querySelector('.zorid-bases-summary-picker [data-summary-id="Sum"]');return row?.querySelector('.zorid-bases-summary-preview')?.textContent==='30';`,'Rust reference summary preview30');await capture('summary-picker');
    await c.ui.click('.zorid-bases-summary-picker [data-summary-id="Sum"]');await c.saved('Reference.base',source=>assert.equal(c.yaml.parse(source).views.find(v=>v.name==='Table').summaries['note.cost'],'Sum'),'reference-cost-sum-config');
    await c.ui.wait(`return document.querySelector('${active} [data-summary-property="note.cost"] .summary-function-name')?.textContent==='Sum'&&document.querySelector('${active} [data-summary-property="note.cost"] .summary-function-value')?.textContent==='30';`,'Reference visible Sum30');await capture('summary-sum-selected');
    await configure(c,'Cards');await capture('cards-view-settings');await c.ui.type(input('View name',panel('View options')),'Gallery');await dismiss(c,'View options');await choose(c,'Gallery');
    await c.ui.wait(`return document.querySelectorAll('${active} .bases-cards-item').length===3;`,'Three Gallery cards');await capture('cards-layout');
    await configure(c,'List');await capture('list-view-settings');await dismiss(c,'View options');await choose(c,'List');await c.ui.wait(`return document.querySelectorAll('${active} .bases-list-item').length===3;`,'Three List items');await capture('list-layout');
    await configure(c,'Board');await capture('kanban-view-settings');await dismiss(c,'View options');await choose(c,'Board');
    await c.ui.wait(`return document.querySelectorAll('${active} .bases-kanban-card').length===3;`,'Three Board cards');
    assert.deepEqual(await c.ui.dom(`return [...document.querySelectorAll('${active} .bases-kanban-column-body')].map(e=>e.getAttribute('aria-label'));`),['Done','In progress','Planned']);await capture('kanban-layout');
    await c.ui.button('Group',active);await capture('kanban-group-menu');await dismiss(c,'Group');await c.quit('normal-quit-before-offline-template-fixture');

    const configured=c.yaml.parse(await c.read('Reference.base'));configured.newItemFolder='Items';configured.newItemTemplate='Templates/Full.md';
    await offline(c,'reference-template-state',new Map([['Reference.base',c.yaml.stringify(configured)],['Templates/Full.md',template]]));
    await c.launch('reference-full-template-new-popover');await viewport(c);await c.ui.openFile('Reference.base');await c.ui.idle();await choose(c,'Board');
    const old=new Set(await fs.readdir(path.join(c.vault,'Items')));await c.ui.button('New',active);
    const newFile=await until(async()=>{const added=(await fs.readdir(path.join(c.vault,'Items'))).filter(name=>!old.has(name));assert.equal(added.length,1);return 'Items/'+added[0];},30000);
    await c.saved(newFile,source=>assert.equal(source,template),'visual-New-copies-full-literal-template');
    const popup='.bases-new-item-popover[aria-label="New item"]';
    await c.ui.wait(`const root=document.querySelector(${JSON.stringify(popup)}),title=root?.querySelector('.inline-title');return title&&document.activeElement===title&&document.getSelection()?.toString()===title.textContent;`,'New popover selects and focuses title');await capture('new-item-template-popover',{created:newFile});
    await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector(${JSON.stringify(popup)});`,'Close New');await c.quit('normal-quit-before-offline-single-fixture');

    // Recreate the separate Single reference's priorUntitled. This offline step
    // cannot count as positive user creation or template execution acceptance.
    if(newFile!=='Items/Untitled.md'){await fs.rename(path.join(c.vault,newFile),path.join(c.vault,'Items/Untitled.md'));c.evidence.actions.push({action:'offline-reference-fixture-rename',from:newFile,to:'Items/Untitled.md'});}
    await offline(c,'single-title-focus-state',new Map([['Single.base',singleBase]]));
    await c.launch('reference-single-title-keyboard');await viewport(c);await c.ui.openFile('Single.base');await c.ui.idle();await c.ui.button('New',active);
    await c.ui.wait(`const title=document.querySelector('${popup} .inline-title');return title?.textContent==='Untitled 1'&&document.activeElement===title&&document.getSelection()?.toString()==='Untitled 1';`,'Separate Single new title selected');await capture('new-title-focused');await delay(1000);
    await c.ui.wait(`const title=document.querySelector('${popup} .inline-title');return document.activeElement===title&&document.getSelection()?.toString()==='Untitled 1';`,'Title focus retained after reference interval');await capture('new-title-focus-retained');
    await c.ui.key('Enter');await c.ui.wait(`return !!document.querySelector('${popup} .cm-content[contenteditable=true]')&&document.activeElement?.classList.contains('cm-content');`,'Enter title opens and focuses real body editor');
    c.evidence.checks.push({name:'New-title-Enter-focuses-body-editor'});await c.ui.key('Escape');await c.ui.wait(`return !document.querySelector(${JSON.stringify(popup)});`,'Keyboard closes hover editor after save');await c.quit('visual-campaign-final-normal-quit');
  }finally{
    for(const[file,expected]of referenceFiles)assert.equal(hash(await fs.readFile(path.join(reference,file))),expected,'Reference capture remained immutable '+file);
    c.evidence.visualCaptures=captures;c.evidence.reference.verifiedAfter=true;
    await fs.writeFile(path.join(c.outputDirectory,'visual-comparison.json'),JSON.stringify({viewport:{width:1024,height:800,deviceScaleFactor:2},reference:Object.fromEntries(referenceFiles),captures,reviewStatus:'Paired evidence only; visual review pending'},null,2));
    const rows=captures.map(row=>`<section><h2>${escape(row.label)}</h2><p>${row.notes.map(escape).join(' ')}</p><div class="pair"><figure><figcaption>Obsidian ${escape(provenance.application.version)}</figcaption><img src="${escape(row.referencePNG)}"></figure><figure><figcaption>Zorid</figcaption><img src="${escape(row.actualPNG)}"></figure></div><a href="${escape(row.referenceJSON)}">Reference state</a> · <a href="${escape(row.actualJSON)}">Actual state</a></section>`).join('\n');
    await fs.writeFile(path.join(c.outputDirectory,'visual-comparison.html'),`<!doctype html><meta charset="utf-8"><title>Bases matched visual evidence</title><style>body{margin:24px;background:#171717;color:#ddd;font:15px system-ui}section{margin:28px 0;border-top:1px solid #555}.pair{display:flex;gap:16px;overflow:auto}figure{margin:0;min-width:512px;flex:1}img{width:100%;height:auto}a{color:#b9a4ff}figcaption{padding:8px}</style><h1>Bases matched visual evidence</h1><p>1024×800 CSS pixels, DPR2, dark, three-note reference fixture. These pairs require visual review; capture completion is not a parity claim. Per-state differences are explicit.</p>${rows}`);
  }
}
