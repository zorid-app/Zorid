/** Runs through the real packaged main inspector AFTER attachment. Earlier
 * startup phases stay censored; callbacks only observe normal product calls. */
export function installMainLifecycle(config){
  const builtin=name=>process.getBuiltinModule?process.getBuiltinModule(name):require(name);
  const req=builtin('module').createRequire(process.resourcesPath+'/app.asar/package.json');
  const {app,BrowserWindow}=req('electron'),{performance}=builtin('perf_hooks'),fs=builtin('fs');
  const assertScope=candidate=>{if(process.pid!==config.pid||process.execPath!==config.executable||!app.isPackaged||app.getAppPath()!==config.expectedAppPath||app.getPath('userData')!==config.profile||process.env.ZORID_LOCAL_DATA_DIR!==config.localDataDirectory||candidate.expectedAppPath!==config.expectedAppPath||candidate.profile!==config.profile||candidate.localDataDirectory!==config.localDataDirectory||candidate.pid!==undefined&&candidate.pid!==config.pid||candidate.executable!==undefined&&candidate.executable!==config.executable||candidate.outputFile!==undefined&&candidate.outputFile!==config.outputFile)throw Error('Packaged lifecycle scope differs');};
  assertScope(config);
  if(globalThis.__zoridPackagedLifecycle){globalThis.__zoridPackagedLifecycle.assertScope(config);return globalThis.__zoridPackagedLifecycle.describe();}
  const now=()=>performance.now(),state={installedAt:now(),timeOrigin:performance.timeOrigin,pid:process.pid,
    packaged:app.isPackaged,appPath:app.getAppPath(),executable:process.execPath,resourcesPath:process.resourcesPath,
    userData:app.getPath('userData'),localDataDirectory:process.env.ZORID_LOCAL_DATA_DIR,electron:process.versions.electron,
    phases:[],requests:[],nativeOpen:[],nativePids:[],nativeExits:[],errors:[],normalQuitObserved:false};
  globalThis.__zoridPackagedMain=state;
  globalThis.__zoridPackagedQuit=()=>app.quit();
  const mark=(phase,extra={})=>state.phases.push({phase,at:now(),...extra});
  mark('inspector-attached',{appReadyAlready:app.isReady(),windowCountAlready:BrowserWindow.getAllWindows().length});
  if(!app.isReady())app.once('ready',()=>mark('app-ready'));
  const windowEvents=window=>{
    mark('window-observed',{id:window.id,url:window.webContents.getURL()});
    for(const event of ['ready-to-show','show'])window.once(event,()=>mark(event,{windowId:window.id}));
    for(const event of ['dom-ready','did-finish-load'])window.webContents.once(event,()=>mark(event,{windowId:window.id}));
  };
  for(const window of BrowserWindow.getAllWindows())windowEvents(window);
  app.on('browser-window-created',(_event,window)=>windowEvents(window));
  const willQuits=[],prevented=event=>{try{const value=event?.defaultPrevented;return typeof value==='boolean'?value:null;}catch{return null;}};
  app.on('before-quit',()=>mark('before-quit'));
  app.on('will-quit',event=>{
    const phase={phase:'will-quit',at:now(),defaultPreventedAtObserver:prevented(event)};
    state.phases.push(phase);willQuits.push({event,phase});
  });
  app.once('quit',(_event,exitCode)=>{
    // Product may cancel will-quit while it asynchronously drains Core. Only
    // the actual terminal quit event can freeze the final native-exit receipt.
    for(const attempt of willQuits)attempt.phase.defaultPreventedAtFinalQuit=prevented(attempt.event);
    state.quitExitCode=exitCode;state.normalQuitObserved=exitCode===0;mark('quit',{exitCode});
    try{fs.writeFileSync(config.outputFile,JSON.stringify(state),{mode:0o600});}catch(error){state.errors.push('Final main observer write: '+error.message);}
  });
  const observeChild=child=>{if(child?.pid&&!state.nativePids.includes(child.pid)){state.nativePids.push(child.pid);child.once?.('exit',(code,signal)=>state.nativeExits.push({pid:child.pid,code,signal,at:now()}));}};
  const describe=()=>({packaged:state.packaged,appPath:state.appPath,userData:state.userData,electron:state.electron,installedAt:state.installedAt,timeOrigin:state.timeOrigin});
  globalThis.__zoridPackagedLifecycle={state,req,now,assertScope,describe,observeChild};
  try{
    // The product already uses this class. Track real child objects without
    // decoding requests or requiring the document-runtime instrumentation.
    const {RustVaultService}=req('./desktop/rust-vault-service.cjs'),originalOpen=RustVaultService.open,originalRequest=RustVaultService.prototype.request;
    RustVaultService.open=function(...args){const row={startedAt:now()};state.nativeOpen.push(row);const result=originalOpen.apply(this,args);result.then(value=>{row.finishedAt=now();row.pid=value.child?.pid;observeChild(value.child);row.initialReconciliation=value.reconciliation??null;},error=>{row.finishedAt=now();row.error=error.code??error.message;});return result;};
    RustVaultService.prototype.request=function(...args){observeChild(this.child);return originalRequest.apply(this,args);};
    state.nativeTrackingInstalledAt=now();
  }catch(error){state.errors.push('Native child tracking unavailable: '+error.message);}
  return describe();
}

/** Detailed request observations start only after early passive attachment and
 * the measured foreground gate. Lifecycle/exit state remains shared. */
export function installMainObserver(config){
  const lifecycle=globalThis.__zoridPackagedLifecycle;if(!lifecycle)throw Error('Main lifecycle observer is not installed');lifecycle.assertScope(config);
  const {state,req,now,observeChild}=lifecycle;if(state.nativeRequestInstrumentationAt!==undefined)return lifecycle.describe();
  try{
    const {RustVaultService}=req('./desktop/rust-vault-service.cjs');
    const runtime=req('./desktop/document-runtime.cjs'),issued=new Map();
    const remember=token=>{if(token&&issued.size<30000)issued.set(token.lifetime+':'+token.effectId,{kind:token.effect.kind,priority:token.priority,targetSource:token.targetSource,snapshot:token.effect.snapshot??null});};
    const original=RustVaultService.prototype.request;
    RustVaultService.prototype.request=function(command,...args){
      const operation=command?.request?.command?.op??command?.request?.op??null;
      const row={method:command?.method,operation,calledAt:now(),queueDepthAtCall:this.queuedCount,nativePid:this.child?.pid??null};
      observeChild(this.child);
      const token=command?.method==='document_work'?command.request?.ticket:operation==='runtime_step'?command.request.command:null;
      if(token){row.ticket=token;row.effect=token.lane==='draft'?{kind:'draft',priority:'unobserved'}:issued.get(token.lifetime+':'+(token.effectId??token.id))??{kind:'unknown',priority:'unobserved'};}
      if(command?.method==='checkpoint_cas')row.checkpoint={scope:command.scope,key:command.key,nextRevision:command.next_revision,hasState:command.has_state};
      if(command?.method==='prepare_intent')row.prepared={operationId:command.operation_id,entryId:command.mutation?.id??null};
      if(command?.method==='commit_intent')row.reference=command.reference;
      // The prior queue tail can settle before ready/reauthorization awaits.
      // This is deliberately NOT labeled actual transport dispatch time.
      Promise.resolve(this.tail).then(()=>{row.queuePredecessorSettledAt=now();},()=>{row.queuePredecessorSettledAt=now();});
      const result=original.call(this,command,...args);
      result.then(reply=>{
        row.finishedAt=now();row.ok=true;
        try{
          if(command?.method==='documents'&&runtime.isRuntimeOp(operation)){
            const value=runtime.decodeRuntimeReply(command.request,reply.result,reply.bytes),snapshot=value?.snapshot;
            remember(snapshot?.inFlight);remember(snapshot?.lastStep?.reduction?.effect);
            row.runtime=snapshot?{update:snapshot.update,execution:snapshot.execution}:value?.update??value?.frame?.update??null;
          }
          if(command?.method==='rescan')row.reconciliation=reply.result?.reconciliation??null;
          if(command?.method==='commit_intent'||command?.method==='prepare_intent'){
            const intent=reply.result?.intent;row.intent=intent?{state:intent.state,operationId:intent.operation_id,entryId:intent.entry_id,receipt:intent.receipt??null}:null;
          }
          if(command?.method==='checkpoint_cas')row.checkpointResult=reply.result?.checkpoint??null;
        }catch(error){row.observationError=error.message;}
      },error=>{row.finishedAt=now();row.ok=false;row.error=error.code??error.message;});
      if(state.requests.length<30000)state.requests.push(row);else state.truncated=true;
      return result;
    };
    state.nativeRequestInstrumentationAt=now();state.phases.push({phase:'native-request-instrumentation-attached',at:state.nativeRequestInstrumentationAt});
  }catch(error){state.errors.push('Native request instrumentation unavailable: '+error.message);}
  return lifecycle.describe();
}
