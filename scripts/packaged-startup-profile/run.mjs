#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CDP} from '../../tests/tasks-electron-integration/cdp.mjs';
import {assessNote,baseFixtureSource,clockInterval,DEADLINE_MS,fixtureText,planCampaign,reopenPrepared} from './oracle.mjs';
import {navigateFileTree} from './file-navigation.mjs';
import {captureObserverFailure,observerSource,sampleObserverSource} from './observer.mjs';
import {installMainObserver} from './main-observer.mjs';
import {stopOwned} from './cleanup.mjs';
import {appPins,currentBrowserEndpoint,hash,hashFile,journalHeads,launchEnvironment,ownedOutput,ownedProcesses} from './support.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const getOption=(args,name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const serializableState=sampleObserverSource;
export async function main(args=process.argv.slice(2)){
  const root=fileURLToPath(new URL('../..',import.meta.url)),require=createRequire(import.meta.url);
  const candidate=await fs.realpath(getOption(args,'--candidate-app','')),baseline=await fs.realpath(getOption(args,'--baseline-app',''));
  assert.ok(candidate.endsWith('.app')&&baseline.endsWith('.app'),'Two explicit .app inputs are required');
  const out=ownedOutput(getOption(args,'--out',`/private/tmp/zorid-packaged-startup-${Date.now()}-${randomUUID().slice(0,8)}`));
  const notes=Number(getOption(args,'--notes','1000')),repetitions=Number(getOption(args,'--repetitions','1')),seed=Number(getOption(args,'--seed','42'));
  const timeoutMs=Number(getOption(args,'--timeout-ms','30000')),shutdownMs=Number(getOption(args,'--shutdown-timeout-ms','60000'));
  assert.ok(Number.isSafeInteger(notes)&&notes>=2&&notes<=10000);assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=4000&&timeoutMs<=120000&&Number.isSafeInteger(shutdownMs)&&shutdownMs>=10000&&shutdownMs<=120000);
  const schedule=planCampaign(repetitions,seed),asar=await import(pathToFileURL(require.resolve('@electron/asar')).href);
  await fs.mkdir(out,{recursive:false,mode:0o700});await fs.mkdir(path.join(out,'clones'));
  const report={version:1,label:'Real packaged Zorid startup and trusted editor input',out,notes,repetitions,seed,deadlineMs:DEADLINE_MS,
    harnessHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),started:new Date().toISOString(),plannedOrder:schedule,actualOrder:[],apps:{},launches:[],skipped:[],errors:[],limitations:[
      'Process-cold, not disk-cold. Fixture creation, hashing, APFS clones and prior repetitions affect filesystem caches.',
      'Actual packaged main/renderer are unchanged; inspectors, buffered observers and automation have overhead recorded separately.',
      'Startup phases before main/renderer attachment are censored. Observer attachment is never a main-module-entry marker.',
      'Trusted CDP input is observed through beforeinput and exact CodeMirror state. Foreground physical keyboard input is not claimed.',
      'Independent journal disk heads are read-only evidence, not a journal fsync/ACK or recovery proof. Core ACKs are reported only when actually observed.',
      'An unobservable fixed800ms attempt is indeterminate, not a fabricated valid target miss. Base readiness is a separate view metric without protected edit acceptance.',
    ]};
  report.harnessFiles={};
  for(const name of await fs.readdir(fileURLToPath(new URL('.',import.meta.url))))if(/\.(mjs|md)$/.test(name))report.harnessFiles[name]=await hashFile(fileURLToPath(new URL(name,import.meta.url)));
  report.cdpHelperSha256=await hashFile(fileURLToPath(new URL('../../tests/tasks-electron-integration/cdp.mjs',import.meta.url)));
  const save=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  const clones=[],pairs=new Map();let active;
  async function bounded(action,record,ms=timeoutMs){const end=performance.now()+ms;let last;do{if(record?.exitCode!==undefined||record?.launchError)throw Error('Owned app exited before evidence: '+record.stderr);try{return await action();}catch(error){last=error;}await sleep(10);}while(performance.now()<end);throw last??Error('Packaged profiling deadline');}
  async function clock(cdp,record){const before=record.elapsed(),sample=await cdp.evaluate('({remoteNow:performance.now(),timeOrigin:performance.timeOrigin})'),after=record.elapsed();return {...sample,before,after};}
  const remaining=(launch,record)=>{const value=record.originMs+timeoutMs-launch.elapsed();assert.ok(value>0,'Original navigation/readiness deadline expired');return value;};
  async function selectFile(launch,record,name){record.navigation={};return navigateFileTree(active.renderer,name,{now:launch.elapsed,timeoutMs:remaining(launch,record),receipt:record.navigation});}
  async function press(renderer,key,code,commands){await renderer.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers:4,...(commands?.length?{commands}:{})});await renderer.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers:4});}
  async function coreRead(renderer,vault,name){return renderer.evaluate(`(async()=>{const context=await window.zorid.getDurableContext(${JSON.stringify(vault)});const value=await window.zorid.durableInvoke(${JSON.stringify(vault)},context.admissionId,'readText',[${JSON.stringify(name)}]);return{entryId:value.entryId,revision:value.revision,content:value.content};})()`);}
  async function stop(launch){
    if(!active)return;
    const owned=active;await stopOwned(owned,launch,{apps:clones,shutdownMs});
    if(owned.child.exitCode!==null||owned.child.signalCode!==null)active=null;
  }
  async function configure(launch,record,newDocument=false){
    const config={identity:record.identity,path:record.path,characters:record.expectedCharacters,prefix:record.original.slice(0,160),visibleText:record.original.split('\n')[0].replace(/^#+\s*/,''),markers:{ready:'x',deadline:'y'}};
    Object.defineProperty(record,'client',{value:active.renderer});
    if(newDocument)record.newDocumentScript=await active.renderer.call('Page.addScriptToEvaluateOnNewDocument',{source:observerSource(config)});
    await active.renderer.evaluate(observerSource(config));record.clockSamples.push(await clock(active.renderer,launch));
  }
  function noteCase(launch,name,kind,originMs){
    const original=pairs.get(launch.pairId).sources.get(name);
    return {kind,path:name,identity:randomUUID(),originMs,deadlineMs:DEADLINE_MS,expectedCharacters:original.length,original,prefix:original.slice(0,160),clockSamples:[],dispatches:[],errors:[],packaged:launch.scopeVerified===true,packagedUrlVerified:launch.scopeVerified===true};
  }
  function arm(launch,record){
    let done;record.deadlineDone=new Promise(resolve=>{done=resolve;});record.resolveDeadline=done;record.inputQueue=Promise.resolve();
    record.deadlineTimer=setTimeout(()=>{record.deadlineTask=(async()=>{
      const attempt={name:'deadline',scheduledForMs:record.originMs+DEADLINE_MS,attemptedAtMs:launch.elapsed(),status:'unobservable'};record.dispatches.push(attempt);
      if(!record.cancelled&&launch.vaultVerified&&record.client&&active?.renderer===record.client&&record.configured){
        try{const observed=await record.client.evaluate(serializableState);if(observed?.identity===record.identity){attempt.observation={at:observed.sampledAt,ready:observed.ready,readinessCheck:observed.readinessCheck};if(observed.ready)await sendProbe(launch,record,attempt);else if(observed.readinessCheck?.eligible===false&&observed.readinessCheck.framesPending===false)attempt.status='observed-not-ready';else attempt.status='readiness-unresolved';}}
        catch(error){attempt.error=String(error);}
      }
    })().finally(done);},Math.max(0,record.originMs+DEADLINE_MS-launch.elapsed()));
  }
  async function sendProbe(launch,record,attempt){
    record.inputQueue=record.inputQueue.then(async()=>{
      const renderer=record.client;
      if(record.cancelled||!launch.vaultVerified||active?.renderer!==renderer)throw Error('Owned input scope retired before dispatch');
      if(!record.focused){await renderer.evaluate("document.querySelector('.pane.is-active .cm-content').focus();true");await press(renderer,'Home','Home',['moveToBeginningOfDocument']);record.focused=true;}
      await renderer.evaluate(`(()=>{const s=window.__zoridPackagedProbe,p=document.querySelector('.pane.is-active'),n=p?.querySelector('.cm-content'),v=n?.cmTile?.root?.view??n?.cmView?.view;const title=${JSON.stringify(record.path.split('/').at(-1).replace(/\.md$/i,''))};if(s?.identity!==${JSON.stringify(record.identity)}||p?.querySelector('.note-title')?.value!==title||!v||n.closest('[inert]')||n.getAttribute('contenteditable')!=='true'||v.state.doc.length!==${record.expectedCharacters}+s.probes.length||v.state.doc.sliceString(s.probes.length,s.probes.length+${record.prefix.length})!==${JSON.stringify(record.prefix)})throw Error('Selected fixture changed before trusted input');return true;})()`);
      if(record.cancelled||active?.renderer!==renderer)throw Error('Owned input scope retired during preparation');
      attempt.dispatchAtMs=launch.elapsed();await renderer.call('Input.insertText',{text:attempt.name==='ready'?'x':'y'});attempt.completedAtMs=launch.elapsed();attempt.status='sent';
    });await record.inputQueue;
  }
  async function finishNote(launch,record){
    await bounded(async()=>{const value=await active.renderer.evaluate(serializableState);assert.equal(value?.identity,record.identity);assert.ok(value.ready,'Correct selected fixture is not ready');return value;},launch,remaining(launch,record));
    const ready={name:'ready',attemptedAtMs:launch.elapsed(),status:'unobservable'};record.dispatches.push(ready);await sendProbe(launch,record,ready);
    await record.deadlineDone;await record.inputQueue;
    record.observed=await bounded(async()=>{const value=await active.renderer.evaluate(serializableState);assert.ok(value.probes.length&&value.probes.every(p=>p.caretAfterPaint!==undefined));return value;},launch);
    record.clockSamples.push(await clock(active.renderer,launch));
    const inserted=record.observed.probes.map(p=>p.marker).join(''),expected=inserted+record.original;
    const body=await active.renderer.evaluate("(()=>{const node=document.querySelector('.pane.is-active .cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;if(!view)throw Error('Actual CodeMirror missing');return view.state.doc.toString();})()");
    record.expectedEditedSha256=hash(expected);record.body={exact:body===expected,sha256:hash(body),characters:body.length};assert.ok(record.body.exact,'Later full body was truncated or changed');
    await press(active.renderer,'s','KeyS',[]);
    const pair=pairs.get(launch.pairId),file=path.join(pair.vault,record.path);
    await bounded(async()=>assert.equal(await fs.readFile(file,'utf8'),expected),launch);
    const committed=await coreRead(active.renderer,pair.vault,record.path);assert.equal(committed.content,expected);
    record.coreReadback={entryId:committed.entryId,revision:committed.revision,sha256:hash(committed.content),exact:true};
    record.independentJournal=await journalHeads(pair.profile);
    record.coreAckEvidence=await active.main.evaluate(`globalThis.__zoridPackagedMain.requests.filter(row=>row.method==='commit_intent'&&row.ok&&row.intent?.state==='committed'&&row.intent.receipt?.changes?.some(change=>change.after?.id===${JSON.stringify(committed.entryId)}&&change.after.revision===${JSON.stringify(committed.revision)}))`);
    record.checkpointAckEvidence=await active.main.evaluate(`globalThis.__zoridPackagedMain.requests.filter(row=>row.method==='checkpoint_cas'&&row.ok&&row.checkpoint?.key?.includes(${JSON.stringify(committed.entryId)}))`);
    record.coreAckStatus=record.coreAckEvidence.length?'normal-core-receipts-observed':'not-observed';
    // Restore through ordinary trusted Undo, never a bridge/filesystem write.
    // Stop as soon as source is exact: typing history may coalesce two probes.
    let restored=body;
    for(let count=0;restored!==record.original&&count<record.observed.probes.length;count++){
      await press(active.renderer,'z','KeyZ');
      restored=await active.renderer.evaluate("(()=>{const n=document.querySelector('.pane.is-active .cm-content');return(n.cmTile?.root?.view??n.cmView?.view).state.doc.toString();})()");
    }
    assert.equal(restored,record.original,'Normal Undo did not restore the exact disposable source');
    await press(active.renderer,'s','KeyS',[]);await bounded(async()=>assert.equal(await fs.readFile(file,'utf8'),record.original),launch);
    const restoredCore=await coreRead(active.renderer,pair.vault,record.path);assert.equal(restoredCore.content,record.original);
    record.restoration={physicalSha256:await hashFile(file),coreSha256:hash(restoredCore.content),revision:restoredCore.revision,exact:true};
    delete record.original;delete record.deadlineDone;delete record.deadlineTimer;delete record.inputQueue;delete record.deadlineTask;delete record.resolveDeadline;
  }
  async function baseCase(launch,pair){
    const record={kind:'base',path:'Profile.base',originMs:launch.elapsed(),trustedEditAuthority:'not-measured',errors:[]};launch.cases.push(record);
    await selectFile(launch,record,record.path);
    const snapshot=`(()=>{
      const pane=document.querySelector('.pane.is-active'),s=pane?.querySelector('.bases-session'),g=s?.querySelector('.zorid-bases-table');if(!s||!g||s.dataset.baseControllerUpdating!=='false'||s.querySelector('.bases-session-content')?.getAttribute('aria-busy')!=='false'||!g.getClientRects().length||pane.querySelector('.error-message')||s.dataset.baseControllerError==='true'||!s.querySelector('.bases-session-toolbar button:not([disabled])'))return null;
      const cells=[...g.querySelectorAll('[role="gridcell"][data-property="file.name"][data-path]')],chrome=1+(g.querySelector('.zorid-bases-table-new-row')?1:0)+(g.querySelector('.zorid-bases-table-footer:not([hidden])')?1:0),total=Number(g.getAttribute('aria-rowcount'))-chrome;
      if(total!==${notes+1}||!cells.some(c=>c.dataset.path==='Note 0000.md'))return null;
      return{at:performance.now(),totalRows:total,knownFixtureRow:'Note 0000.md',visibleRows:cells.length,controlsReady:true};})()`;
    await bounded(async()=>assert.ok(await active.renderer.evaluate(snapshot),'Known Base fixture row/controls not ready'),launch,remaining(launch,record));
    await active.renderer.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const observed=await active.renderer.evaluate(snapshot);assert.ok(observed,'Base became unavailable after paint');
    record.observed=observed;const sample=await clock(active.renderer,launch),interval=clockInterval(observed.at,[sample]);record.readyMs={lower:interval.lower-record.originMs,upper:interval.upper-record.originMs};
    record.definitionUnchanged=await hashFile(path.join(pair.vault,'Profile.base'))===hash(pair.sources.get('Profile.base'));
    record.metric='normal Base controls and known fixture row ready; not CodeMirror/protected edit latency';
  }
  try{
    for(const [label,app] of [['baseline',baseline],['candidate',candidate]]){
      const manifest=getOption(args,`--${label}-source-manifest`),original=await appPins(app,asar,manifest);
      if(manifest){const receipt=path.join(out,label+'-inputs.json');await fs.copyFile(manifest,receipt);assert.equal(await hashFile(receipt),original.provenance.sha256);original.provenance.retainedCopy=receipt;}
      const clone=path.join(out,'clones',label+'.app');execFileSync('/bin/cp',['-cR',app,clone]);clones.push(clone);
      const pinned=await appPins(clone,asar,manifest);for(const field of ['executableSha256','asarSha256','nativeSha256','frameworkSha256','infoSha256'])assert.equal(original[field],pinned[field]);
      report.apps[label]={original,pinned};
    }
    await save();
    for(const scheduled of schedule){
      let pair=pairs.get(scheduled.pairId);
      if(!pair){
        const directory=path.join(out,scheduled.pairId),profile=path.join(directory,'profile'),vault=path.join(directory,'vault'),data=path.join(directory,'app-data');
        await fs.mkdir(directory);await fs.mkdir(profile);await fs.mkdir(vault);await fs.mkdir(data);
        const sources=new Map(Array.from({length:notes},(_,index)=>[`Note ${String(index).padStart(4,'0')}.md`,fixtureText(8192,index)]));sources.set('Large 432000.md',fixtureText(432000,notes));
        sources.set('Profile.base',baseFixtureSource());
        for(const [name,text] of sources)await fs.writeFile(path.join(vault,name),text,{flag:'wx',mode:0o600});
        await fs.writeFile(path.join(profile,'vault.json'),JSON.stringify({path:vault}),{flag:'wx'});
        pair={directory,profile,vault,data,sources,fixtureHashes:Object.fromEntries([...sources].map(([name,text])=>[name,hash(text)]))};pairs.set(scheduled.pairId,pair);
      }
      if(scheduled.mode==='reopen'&&pair.reopenPrepared!==true){
        const skipped={...scheduled,status:'skipped-dependency',reason:'Prior first-import did not complete verified Note0000 return, fixture restoration and normal cleanup',priorResult:path.join(pair.directory,'first-import/result.json')};
        report.skipped.push(skipped);process.stdout.write(JSON.stringify({event:'launch-skipped',...skipped})+'\n');await save();continue;
      }
      const directory=path.join(pair.directory,scheduled.mode);await fs.mkdir(directory);
      const launch={...scheduled,directory,profile:pair.profile,vault:pair.vault,localDataDirectory:pair.data,fixtureHashesBefore:pair.fixtureHashes,mainFinalFile:path.join(directory,'main-final.json'),cases:[],stderr:'',stdout:'',errors:[]};report.launches.push(launch);
      const start=performance.now();Object.defineProperty(launch,'elapsed',{value:()=>performance.now()-start});launch.spawnWallClockDiagnostic=new Date().toISOString();
      const startup=noteCase(launch,'Note 0000.md','startup-'+scheduled.mode,0);launch.cases.push(startup);arm(launch,startup);
      const pinned=report.apps[scheduled.label].pinned;
      const child=spawn(pinned.executable,['--inspect=127.0.0.1:0','--user-data-dir='+pair.profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'],{env:launchEnvironment(pair.profile,pair.data),cwd:out,stdio:['ignore','pipe','pipe']});launch.pid=child.pid;
      const exit=new Promise(resolve=>{child.once('exit',(code,signal)=>{launch.exitCode=code;launch.signal=signal;resolve();});child.once('error',error=>{launch.launchError=String(error);resolve();});});active={child,exit,main:null,renderer:null};report.actualOrder.push({...scheduled,pid:child.pid});
      process.stdout.write(JSON.stringify({event:'launch-start',...scheduled,pid:child.pid,app:pinned.app,profile:pair.profile,directory})+'\n');
      child.stderr.on('data',chunk=>{launch.stderr=(launch.stderr+chunk).slice(-1000000);});child.stdout.on('data',chunk=>{launch.stdout=(launch.stdout+chunk).slice(-1000000);});
      try{
        const mainURL=await bounded(()=>{const url=/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(launch.stderr)?.[1];assert.ok(url,'Packaged main inspector not observable');return url;},launch);
        active.main=new CDP(mainURL);await active.main.call('Runtime.enable');launch.mainAttachedMs=launch.elapsed();launch.mainClockSamples=[await clock(active.main,launch)];
        launch.mainScope=await active.main.evaluate(`(${installMainObserver.toString()})(${JSON.stringify({expectedAppPath:pinned.archive,profile:pair.profile,localDataDirectory:pair.data,outputFile:launch.mainFinalFile})})`);
        const endpoint=await bounded(()=>currentBrowserEndpoint(launch.stderr),launch);launch.browserEndpoint=endpoint;
        active.browser=new CDP(endpoint.url);await active.browser.opened;
        const expectedURL=pathToFileURL(path.join(pinned.archive,'dist/index.html')).href;
        const target=await bounded(async()=>{
          // The current child's nonce-bearing browser WS must authenticate the
          // target ID; a recycled HTTP port cannot grant another app's page.
          const {targetInfos}=await active.browser.call('Target.getTargets');
          const owned=targetInfos.filter(t=>t.type==='page'&&(t.url.split('#')[0]===expectedURL||t.url==='about:blank'));assert.equal(owned.length,1,'Expected one current browser page');
          const response=await fetch(`http://127.0.0.1:${endpoint.port}/json/list`),targets=await response.json();
          const page=targets.find(t=>t.id===owned[0].targetId&&t.type==='page'&&(t.url.split('#')[0]===expectedURL||t.url==='about:blank'));
          assert.ok(page,'HTTP page is not the current authenticated browser target');return page;
        },launch);
        active.renderer=new CDP(target.webSocketDebuggerUrl);await active.renderer.opened;launch.rendererAttachedMs=launch.elapsed();
        active.browser.close();active.browser=null;
        await configure(launch,startup,true);startup.configured=true;
        await active.renderer.call('Runtime.enable');await active.renderer.call('Page.enable');
        await bounded(async()=>assert.equal(await active.renderer.evaluate('location.href.split("#")[0]'),expectedURL),launch);
        const loadedClock=await clock(active.renderer,launch);
        if(startup.clockSamples.some(sample=>sample.timeOrigin!==loadedClock.timeOrigin)){startup.preNavigationClockSamples=startup.clockSamples;startup.clockSamples=[];}
        startup.clockSamples.push(loadedClock);launch.scopeVerified=true;startup.packaged=true;startup.packagedUrlVerified=true;
        assert.equal((await active.renderer.evaluate('window.zorid.getVault()')).path,pair.vault);launch.vaultVerified=true;
        if(scheduled.mode==='first-import')await selectFile(launch,startup,startup.path);
        await finishNote(launch,startup);
        launch.navigationTiming=await active.renderer.evaluate('performance.getEntriesByType("navigation").map(value=>value.toJSON())');
        launch.rendererResources=await active.renderer.evaluate('performance.getEntriesByType("resource").slice(0,500).map(value=>({name:value.name,startTime:value.startTime,duration:value.duration,transferSize:value.transferSize,decodedBodySize:value.decodedBodySize}))');
        for(const [name,kind] of [['Note 0001.md','ordinary-note-open'],['Large 432000.md','large432000-note-open']]){
          const record=noteCase(launch,name,kind,0);launch.cases.push(record);await configure(launch,record);record.configured=true;record.originMs=launch.elapsed();arm(launch,record);await selectFile(launch,record,name);await finishNote(launch,record);
        }
        await baseCase(launch,pair);
        launch.returnNavigation={};await navigateFileTree(active.renderer,'Note 0000.md',{now:launch.elapsed,timeoutMs,receipt:launch.returnNavigation});
        await bounded(async()=>assert.equal(await active.renderer.evaluate("(()=>{const n=document.querySelector('.pane.is-active .cm-content');return(n?.cmTile?.root?.view??n?.cmView?.view)?.state.doc.toString();})()"),pair.sources.get('Note 0000.md')),launch);
        launch.returnToStartupNoteVerified=true;
        launch.mainClockSamples.push(await clock(active.main,launch));
      }catch(error){launch.errors.push(error.stack??String(error));report.errors.push({pairId:scheduled.pairId,mode:scheduled.mode,error:String(error)});await captureObserverFailure(active.renderer,launch);try{if(active.renderer){const image=await active.renderer.call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(directory,'failure.png'),Buffer.from(image.data,'base64'));}}catch{}}
      finally{
        for(const record of launch.cases){
          record.cancelled=true;
          if(record.deadlineTimer)clearTimeout(record.deadlineTimer);
          if(!record.deadlineTask)record.resolveDeadline?.();
          await Promise.allSettled([record.deadlineTask,record.inputQueue].filter(Boolean));
          for(const key of ['inputQueue','deadlineDone','deadlineTask','deadlineTimer','resolveDeadline','original'])delete record[key];
        }
        await stop(launch);
      }
      const after=await appPins(pinned.app,asar);launch.artifactsUnchanged=['executableSha256','asarSha256','nativeSha256','frameworkSha256','infoSha256'].every(field=>after[field]===pinned[field]);
      try{launch.mainPhaseIntervals=(launch.mainFinal?.phases??[]).map(phase=>({...phase,launchMs:clockInterval(phase.at,launch.mainClockSamples)}));}catch(error){launch.mainPhaseClockError=String(error);}
      launch.nativeRequestCounts={};
      for(const row of launch.mainFinal?.requests??[]){const key=[row.method,row.operation??'',row.effect?.kind??'',row.effect?.priority??''].join(':');launch.nativeRequestCounts[key]=(launch.nativeRequestCounts[key]??0)+1;}
      launch.fixtureHashesAfter={};for(const name of pair.sources.keys())launch.fixtureHashesAfter[name]=await hashFile(path.join(pair.vault,name));
      launch.fixturesRestored=JSON.stringify(launch.fixtureHashesAfter)===JSON.stringify(pair.fixtureHashes);
      launch.sourcePathsExact=JSON.stringify((await fs.readdir(pair.vault)).filter(name=>!name.startsWith('.')).sort())===JSON.stringify([...pair.sources.keys()].sort());
      if(scheduled.mode==='first-import')pair.reopenPrepared=reopenPrepared(launch);
      for(const record of launch.cases)if(record.kind!=='base'){record.cleanup=launch.cleanup;record.artifactsUnchanged=launch.artifactsUnchanged;record.assessment=assessNote(record);}
      await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(launch,null,2));await save();
      process.stdout.write(JSON.stringify({event:'launch-complete',label:launch.label,mode:launch.mode,pid:launch.pid,cleanup:launch.cleanup,cases:launch.cases.map(c=>({kind:c.kind,assessment:c.assessment??c.readyMs}))})+'\n');
      assert.ok(launch.cleanup?.gone,'Owned packaged processes remain; do not launch another app');
    }
  }catch(error){report.errors.push(error.stack??String(error));}
  finally{
    if(active){const launch=report.launches.at(-1);try{await stop(launch);}catch(error){report.errors.push('Final cleanup: '+error.message);}}
    try{report.remainingOwnedProcesses=ownedProcesses(clones);}catch(error){report.errors.push('Owned PID proof unavailable: '+error.message);report.remainingOwnedProcesses=[{unverifiable:true}];}
    if(!report.remainingOwnedProcesses.length&&!args.includes('--keep-clones'))for(const app of clones)await fs.rm(app,{recursive:true});
    report.clonesRetained=args.includes('--keep-clones')||report.remainingOwnedProcesses.length>0;
    const runtimeVersions=label=>[...new Set(report.launches.filter(launch=>launch.label===label&&launch.mainScope?.electron).map(launch=>launch.mainScope.electron))];
    report.runtimeComparison={baseline:runtimeVersions('baseline'),candidate:runtimeVersions('candidate')};
    report.runtimeComparison.sameElectronVersion=report.runtimeComparison.baseline.length===1&&report.runtimeComparison.candidate.length===1&&report.runtimeComparison.baseline[0]===report.runtimeComparison.candidate[0];
    report.noteSummary=[];
    for(const label of ['baseline','candidate'])for(const kind of ['startup-first-import','startup-reopen','ordinary-note-open','large432000-note-open']){
      const cases=report.launches.filter(launch=>launch.label===label).flatMap(launch=>launch.cases.filter(record=>record.kind===kind));
      const observed=cases.map(record=>record.assessment?.inputMs?.upper).filter(Number.isFinite).sort((a,b)=>a-b);
      report.noteSummary.push({label,kind,attempts:cases.length,valid:cases.filter(c=>c.assessment?.valid).length,outcomes:cases.map(c=>c.assessment?.outcome??'missing'),observedInputUpperMs:observed,
        diagnosticMedianUpperMs:observed.length?observed[Math.floor(observed.length/2)]:null,limit:'Observed input timings include diagnostic/indeterminate cases;800ms acceptance is only assessment.usableByDeadline'});
    }
    report.artifactsValid=report.launches.length===schedule.length&&report.launches.every(l=>!l.errors.length&&!l.cleanupErrors?.length&&l.cleanup?.normal&&l.cleanup.gone&&l.fixturesRestored&&l.sourcePathsExact&&l.artifactsUnchanged);
    report.candidateTargetMet=report.artifactsValid&&report.launches.filter(l=>l.label==='candidate').every(l=>l.cases.filter(c=>c.kind!=='base').every(c=>c.assessment?.usableByDeadline));
    report.complete=report.launches.length===schedule.length;report.allPlannedProcessed=report.launches.length+report.skipped.length===schedule.length;await save();
  }
  process.stdout.write(JSON.stringify({out,complete:report.complete,artifactsValid:report.artifactsValid,candidateTargetMet:report.candidateTargetMet})+'\n');
  return report.artifactsValid&&report.candidateTargetMet?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
