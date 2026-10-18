'use strict';
// Explicit real-runtime proof, not part of node --test. Run this file with Node
// only after the coordinator freezes the native + binding + UI assembly.
// Required: ZORID_CALENDAR_TARGET, ZORID_CALENDAR_EXPECTED_SHA,
// ZORID_CALENDAR_ELECTRON_BIN, ZORID_DESKTOP_HOST_BIN (all paths absolute).
// Uses the normal desktop main/preload/Workspace and disposable owned fixtures.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const env=process.env;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function requiredPath(name){const value=env[name];assert.ok(value&&path.isAbsolute(value),name+' must be an absolute path');return fs.realpathSync(value);}
function treeHash(root){const items=[];function walk(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);assert.ok(!stat.isSymbolicLink(),'proof source must not be a symlink');if(stat.isDirectory())walk(file);else if(stat.isFile())items.push([path.relative(root,file),sha(fs.readFileSync(file))]);}}walk(root);return sha(JSON.stringify(items));}
function provenance(target,native){
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:target,encoding:'utf8'}).trim();assert.equal(commit,env.ZORID_CALENDAR_EXPECTED_SHA,'assembly moved');
  execFileSync('git',['diff','--quiet','HEAD','--','src','desktop','crates','package.json','pnpm-lock.yaml','Cargo.toml','Cargo.lock','vite.config.mjs'],{cwd:target});
  assert.equal(execFileSync('git',['ls-files','--others','--exclude-standard','--','src','desktop','crates'],{cwd:target,encoding:'utf8'}).trim(),'','untracked runtime source invalidates freeze');
  return{commit,source:treeHash(path.join(target,'src')),desktop:treeHash(path.join(target,'desktop')),dist:treeHash(path.join(target,'dist')),native:sha(fs.readFileSync(native)),harness:sha(fs.readFileSync(__filename)),package:sha(fs.readFileSync(path.join(target,'package.json'))),lock:sha(fs.readFileSync(path.join(target,'pnpm-lock.yaml')))};
}
async function driver(){
  const target=requiredPath('ZORID_CALENDAR_TARGET'),native=requiredPath('ZORID_DESKTOP_HOST_BIN'),electron=requiredPath('ZORID_CALENDAR_ELECTRON_BIN');
  const before=provenance(target,native),output=fs.mkdtempSync(path.join(os.tmpdir(),'zorid-calendar-proof-'));
  const vault=path.join(output,'vault'),profile=path.join(output,'profile');fs.mkdirSync(vault);fs.mkdirSync(profile);
  fs.writeFileSync(path.join(vault,'Calendar fixture.md'),'# Calendar fixture\n\nDisposable Calendar verification note.\n');
  fs.writeFileSync(path.join(profile,'vault.json'),JSON.stringify({path:fs.realpathSync(vault)}));
  const report={started:new Date().toISOString(),target,output,provenance:before,phases:[],passed:false};
  console.log('Calendar fixture proof: '+output);
  try{
    for(const phase of ['author','reopen-delete','reopen-deleted']){
      const childEnv={...env,ZORID_CALENDAR_PROOF_DIR:output,ZORID_CALENDAR_PHASE:phase};
      for(const key of Object.keys(childEnv))if(key.startsWith('ZORID_FIXTURE_')||['ZORID_DEV_URL','ZORID_DESKTOP_FAMILY_FIXTURE','ZORID_EDITOR_RUST','ELECTRON_RUN_AS_NODE'].includes(key))delete childEnv[key];
      await new Promise((resolve,reject)=>{
        const child=spawn(electron,[__filename,'--user-data-dir='+profile],{cwd:target,env:childEnv,stdio:['ignore','pipe','pipe']});
        const log=fs.createWriteStream(path.join(output,phase+'.log'));child.stdout.pipe(log);child.stderr.pipe(log);
        const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('owned Electron phase timed out: '+phase));},150000);
        child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);log.end();code===0?resolve():reject(Error(phase+' exited '+code));});
      });
      report.phases.push(JSON.parse(fs.readFileSync(path.join(output,phase+'.json'),'utf8')));
      assert.equal(report.phases.at(-1).passed,true);assert.deepEqual(provenance(target,native),before,'source/dist/native bytes changed during proof');
    }
    report.passed=true;
  }catch(error){report.error=error.stack||String(error);process.exitCode=1;console.error(report.error);}
  finally{report.finished=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('Calendar report: '+path.join(output,'report.json'));}
}
async function electronProof(){
  const {app,BrowserWindow,dialog}=require('electron');
  const target=requiredPath('ZORID_CALENDAR_TARGET'),output=requiredPath('ZORID_CALENDAR_PROOF_DIR'),phase=env.ZORID_CALENDAR_PHASE;
  assert.ok(['author','reopen-delete','reopen-deleted'].includes(phase));
  app.setPath('userData',path.join(output,'profile'));
  const report={phase,started:new Date().toISOString(),steps:[],screenshots:[],passed:false,versions:process.versions};
  let owned,finished=false;
  const watchdog=setTimeout(()=>fail(Error('Calendar runtime timeout')),135000);
  // Keep unexpected startup/close errors from leaving blocking native dialogs.
  // This changes only the test-side dialog surface, never product IPC or state.
  dialog.showErrorBox=(title,content)=>{throw Error(title+': '+content);};
  dialog.showMessageBox=async(_window,options)=>{throw Error('Unexpected native dialog: '+options.message);};
  function persist(){fs.writeFileSync(path.join(output,phase+'.json'),JSON.stringify(report,null,2));}
  function fail(error){if(finished)return;finished=true;clearTimeout(watchdog);report.error=error.stack||String(error);report.finished=new Date().toISOString();persist();if(owned&&!owned.isDestroyed())owned.destroy();app.exit(1);}
  process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
  const step=(name,details={})=>{report.steps.push({name,at:new Date().toISOString(),...details});persist();};
  const evaluate=code=>owned.webContents.executeJavaScript('(()=>{'+code+'})()',true);
  async function wait(code,label,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(!owned||owned.isDestroyed()||owned.webContents.isLoading()){await sleep(80);continue;}const value=await evaluate(code);if(value)return value;await sleep(80);}throw Error('Timed out: '+label+'; '+await evaluate("return document.querySelector('.calendar-status')?.textContent||document.body.textContent.slice(0,400);"));}
  async function click(text,scope='document'){await evaluate(`const root=${scope};const element=[...root.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&!e.disabled&&e.getClientRects().length);if(!element)throw Error('Missing button');element.click();`);}
  async function aria(label){await evaluate(`const e=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('Missing labelled button');e.click();`);}
  async function field(label,value){await evaluate(`const e=[...document.querySelectorAll('.calendar-field')].find(e=>e.firstChild.textContent===${JSON.stringify(label)})?.querySelector('input');if(!e||e.disabled)throw Error('Missing editable field');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`);}
  async function formValues(){return evaluate("return Object.fromEntries([...document.querySelectorAll('.calendar-field')].map(e=>[e.firstChild.textContent,e.querySelector('input').value]));");}
  async function cleanForm(){await wait("return document.querySelector('.calendar-editor')?.hidden===true&&!document.querySelector('.calendar-status')?.textContent;",'durable acknowledgement and refresh');}
  async function calendarView(value){await evaluate(`const e=document.querySelector('select[aria-label="Calendar view"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);await wait("return !document.querySelector('.calendar-status')?.textContent;",'visible range loaded');await sleep(150);}
  async function eventElement(){return evaluate("const e=[...document.querySelectorAll('.calendar-grid [tabindex]')].find(e=>e.textContent.includes('Calendar proof'));if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,text:e.textContent};");}
  async function openEvent(){await wait("return [...document.querySelectorAll('.calendar-grid [tabindex]')].some(e=>e.textContent.includes('Calendar proof'));",'fixture event');await evaluate("[...document.querySelectorAll('.calendar-grid [tabindex]')].find(e=>e.textContent.includes('Calendar proof')).focus();");owned.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});owned.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});await wait("return document.querySelector('.calendar-editor')?.hidden===false;",'keyboard event editor');}
  async function screenshot(name){await sleep(150);const file=path.join(output,phase+'-'+name+'.png');fs.writeFileSync(file,(await owned.capturePage()).toPNG());report.screenshots.push(file);persist();}
  async function theme(value){await evaluate("document.querySelector('[data-hotkey-command=\"settings\"]').click();");await click('Appearance',"document.querySelector('.settings-modal')");await evaluate(`const e=document.querySelector('[aria-label="Base color scheme"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);owned.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});owned.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(`return !document.querySelector('.modal-overlay')&&document.documentElement.dataset.theme===${JSON.stringify(value)};`,'theme applied');}
  async function gesture(resize){
    const rect=await eventElement();assert.ok(rect&&rect.height>8,'visible event geometry');
    const start={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+(resize?rect.height-2:Math.min(14,rect.height/2)))};
    const end={x:start.x,y:start.y+42};
    owned.webContents.sendInputEvent({type:'mouseMove',...start});owned.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start});await sleep(100);
    for(let i=1;i<=8;i++){owned.webContents.sendInputEvent({type:'mouseMove',x:start.x,y:Math.round(start.y+(end.y-start.y)*i/8),movementY:6});await sleep(30);}
    owned.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...end});
    await wait("return document.querySelector('.calendar-editor')?.hidden===false&&document.querySelector('.calendar-editor h3')?.textContent==='Review time change';",resize?'actual resize review':'actual drag review');
    const proposed=await formValues();await click('Cancel',"document.querySelector('.calendar-editor')");await cleanForm();step(resize?'actual-resize-cancel':'actual-move-cancel',{proposed});
  }
  app.on('browser-window-created',(_event,window)=>{assert.ok(!owned,'only one owned window expected');owned=window;window.webContents.on('render-process-gone',(_event,details)=>fail(Error('Renderer exited '+details.reason)));});
  require(path.join(target,'desktop/main.cjs'));
  try{
    await app.whenReady();await wait("return !!document.querySelector('.ribbon [aria-label=\"Open Calendar\"]');",'normal Workspace admission',45000);
    step('normal-workspace-opened');
    if(!await evaluate("return !!document.querySelector('.calendar-view');"))await aria('Open Calendar');
    await wait("return !!document.querySelector('.calendar-grid')&&!document.querySelector('.calendar-status')?.textContent;",'real supported Calendar',30000);
    await calendarView('timeGridDay');await click('Today');await wait("return !document.querySelector('.calendar-status')?.textContent;",'today loaded');
    if(phase==='author'){
      const date=await evaluate("const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');");
      const zone=await evaluate("return Intl.DateTimeFormat().resolvedOptions().timeZone;");
      await click('Add work block');await field('Title','Calendar proof');await field('Start',date+'T10:00');await field('End',date+'T11:00');await field('Time zone',zone);await click('Add block');await cleanForm();await eventElement();step('create-acknowledged');
      await openEvent();await field('Title','Calendar proof edited');await click('Save title');await cleanForm();step('title-acknowledged');
      await openEvent();await field('Start',date+'T12:00');await field('End',date+'T13:30');await click('Save time');await cleanForm();step('atomic-range-acknowledged');
      await gesture(false);await gesture(true);await openEvent();const final=await formValues();assert.equal(final.Title,'Calendar proof edited');assert.equal(final['Time zone'],zone);assert.ok(final.Start.startsWith(date+'T12:00'));assert.ok(final.End.startsWith(date+'T13:30'));await click('Cancel');await cleanForm();fs.writeFileSync(path.join(output,'expected.json'),JSON.stringify(final));step('gesture-cancellation-preserves-time',{final});
      for(const type of ['dayGridMonth','timeGridWeek','timeGridDay','listWeek']){await calendarView(type);assert.ok(await eventElement(),'fixture visible in '+type);step('view-'+type);}
      await theme('light');await screenshot('light-list');await theme('dark');await calendarView('dayGridMonth');await screenshot('dark-month');
      await evaluate("document.querySelector('[data-hotkey-command=\"command-palette\"]').click();");await evaluate("const e=document.querySelector('.command-input');e.value='Split right';e.dispatchEvent(new Event('input',{bubbles:true}));");owned.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});owned.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});await wait("return document.querySelectorAll('.calendar-grid').length===2&&[...document.querySelectorAll('.calendar-view .calendar-status')].every(e=>!e.textContent);",'normal split Calendar');owned.setContentSize(1000,760);await screenshot('dark-narrow-split');step('normal-split-calendar');
      await evaluate("document.querySelector('.pane.is-active .tab.is-active .tab-close').click();");await wait("return document.querySelectorAll('.calendar-view').length===1;",'secondary Calendar closed');owned.setContentSize(1280,820);
      await calendarView('timeGridDay');
    }else if(phase==='reopen-delete'){
      await openEvent();const actual=await formValues(),expected=JSON.parse(fs.readFileSync(path.join(output,'expected.json'),'utf8'));assert.deepEqual(actual,expected,'durable record survived app quit/reopen');step('durable-reopen-exact-title-range',{actual});
      await click('Delete block');await screenshot('delete-confirmation');await click('Keep block');await click('Delete block');await click('Confirm delete');await cleanForm();await wait("return ![...document.querySelectorAll('.calendar-grid [tabindex]')].some(e=>e.textContent.includes('Calendar proof'));",'deleted event absent');step('delete-acknowledged');
    }else{
      await wait("return !document.querySelector('.calendar-status')?.textContent;",'reopened calendar loaded');assert.equal(await eventElement(),null,'delete survived process reopen');step('durable-deletion-reopen');await screenshot('deleted');
    }
    report.passed=true;report.finished=new Date().toISOString();persist();clearTimeout(watchdog);finished=true;app.quit();
    setTimeout(()=>{if(BrowserWindow.getAllWindows().length)app.exit(2);},12000).unref();
  }catch(error){fail(error);}
}
if(process.versions.electron)void electronProof();else void driver().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
