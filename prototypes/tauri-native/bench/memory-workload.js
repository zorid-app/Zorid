/* Throwaway memory workload; inject in place of measure.js before the editor. */
(() => {
  const fixedLayout=document.createElement('style');fixedLayout.textContent='.workspace{width:1200px!important;height:760px!important;min-width:1200px!important;min-height:760px!important;max-height:760px!important;}';document.head.append(fixedLayout);
  const phases = ['single', 'tabs', 'large', 'save', 'close', 'done'];
  const ordinaryPaths = ['Benchmark.md', ...Array.from({ length: 7 }, (_, i) => `Note ${i + 1}.md`)];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = { phase: 'injected', requestedPhase: null, expectedNotes: null, lastReport: null, polling: false };
  let queue = Promise.resolve(), completed = -1, stopped = false;
  const memoryInputs=[],memoryChanges=[],memoryViews=new WeakSet();
  let memoryInputCount=0,memoryChangeCount=0;
  const memoryPhase=()=>['single','tabs','large'].includes(state.requestedPhase);
  let measurementLockActive=false,measurementBanner;
  let blockedInputCount=0,blockedNonCancelable=0;
  const blockedInputTypes=Object.create(null);
  const lockEvents=['keydown','beforeinput','pointerdown','pointerup','mousedown','mouseup',
    'click','dblclick','contextmenu','wheel','touchmove','touchstart','touchend','paste','cut','drop'];
  const lockSnapshot=()=>({enabled:measurementLockActive,blockedInputCount,
    blockedInputTypes:{...blockedInputTypes},blockedNonCancelable});
  const blockMeasurementInput=event=>{
    if(!measurementLockActive||!event.isTrusted)return;
    blockedInputCount++;blockedInputTypes[event.type]=(blockedInputTypes[event.type]||0)+1;
    if(event.cancelable)event.preventDefault();else blockedNonCancelable++;
    event.stopImmediatePropagation();
  };
  // Install before the observer below. Real user trials must not alter the
  // disposable fixture during sampling; ordinary synthetic benchmark clicks pass.
  for(const name of lockEvents)document.addEventListener(name,blockMeasurementInput,{capture:true,passive:false});
  function setMeasurementLock(enabled){
    measurementLockActive=enabled;
    if(enabled){
      if(!measurementBanner){
        measurementBanner=document.createElement('div');
        measurementBanner.id='native-memory-measurement-lock';
        measurementBanner.setAttribute('role','status');
        measurementBanner.textContent='Automated memory measurement — editing disabled';
        measurementBanner.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;border:1px solid #737373;border-radius:6px;background:#202020;color:#fff;font:12px system-ui;pointer-events:none;';
      }
      if(!measurementBanner.isConnected)(document.body||document.documentElement).append(measurementBanner);
    }else measurementBanner?.remove();
  }
  function removeMeasurementLock(){
    setMeasurementLock(false);
    for(const name of lockEvents)document.removeEventListener(name,blockMeasurementInput,true);
  }
  const docFacts=text=>({length:text.length,bytes:new TextEncoder().encode(text).length,
    trailingNewlines:(text.match(/\n*$/)||[''])[0].length});
  const whitespaceFacts=text=>/^\s*$/.test(text)?{length:text.length,codes:[...text].slice(0,20).map(c=>c.codePointAt(0))}:{length:text.length,content:'<non-whitespace>'};
  const memoryTrace=()=>({timeOrigin:performance.timeOrigin,inputs:memoryInputs.slice(),documentChanges:memoryChanges.slice(),
    totalInputs:memoryInputCount,totalDocumentChanges:memoryChangeCount,
    truncated:memoryInputCount>memoryInputs.length||memoryChangeCount>memoryChanges.length,
    measurementLock:lockSnapshot()});
  // DEBUG-native-focus: observe fixture-window input without suppressing it.
  // Printable key/data text is deliberately omitted from retained traces.
  const traceInput=event=>{
    if(!memoryPhase())return;memoryInputCount++;
    if(memoryInputs.length>=100)return;
    const printable=typeof event.key==='string'&&event.key.length===1;
    memoryInputs.push({type:event.type,at:performance.now(),phase:state.requestedPhase,
      key:printable?'<printable>':event.key??null,code:printable?'<printable>':event.code??null,
      inputType:event.inputType??null,dataLength:typeof event.data==='string'?event.data.length:null,
      trusted:event.isTrusted,composing:!!event.isComposing,
      shift:!!event.shiftKey,meta:!!event.metaKey,ctrl:!!event.ctrlKey,alt:!!event.altKey,
      target:event.target?.nodeName,targetClass:typeof event.target?.className==='string'?event.target.className:null,
      activeTitle:document.querySelector('.pane.is-active .note-title')?.value??null});
  };
  for(const name of ['keydown','beforeinput','input'])document.addEventListener(name,traceInput,true);

  function instrumentMemoryEditor(editor,path){
    if(!memoryPhase()||memoryViews.has(editor.view))return;
    const view=editor.view,dispatch=view.dispatch;memoryViews.add(view);
    view.dispatch=function(...args){
      const beforeDoc=view.state.doc;
      try{return dispatch.apply(this,args);}
      finally{
        const afterDoc=view.state.doc;
        if(memoryPhase()&&beforeDoc!==afterDoc&&!beforeDoc.eq(afterDoc)){
          const before=beforeDoc.toString(),after=afterDoc.toString();
          memoryChangeCount++;
          if(memoryChanges.length<100){
            const changes=[];
            for(const arg of args){
              try{
                if(typeof arg?.changes?.iterChanges==='function')arg.changes.iterChanges((from,to,_fromNew,_toNew,insert)=>{
                  if(changes.length<20)changes.push({from,to,removed:whitespaceFacts(before.slice(from,to)),inserted:whitespaceFacts(insert.toString())});
                });
                else for(const change of Array.isArray(arg?.changes)?arg.changes:arg?.changes?[arg.changes]:[]){
                  if(changes.length<20)changes.push({from:change.from,to:change.to??change.from,
                    removed:whitespaceFacts(before.slice(change.from,change.to??change.from)),
                    inserted:whitespaceFacts(String(change.insert??''))});
                }
              }catch{changes.push({unavailable:true});}
            }
            memoryChanges.push({path,at:performance.now(),phase:state.requestedPhase,before:docFacts(before),after:docFacts(after),changes,
              input:args.some(a=>typeof a?.isUserEvent==='function'?a.isUserEvent('input'):String(a?.userEvent??'').startsWith('input')),
              delete:args.some(a=>typeof a?.isUserEvent==='function'?a.isUserEvent('delete'):String(a?.userEvent??'').startsWith('delete'))});
          }
        }
      }
    };
  }

  async function bounded(promise, label, ms = 15000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  async function until(probe, label, ms = 45000) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const value = probe();
      if (value) return value;
      await pause(40);
    }
    throw new Error(`${label} timed out`);
  }

  const titleFor = path => path.split('/').at(-1).replace(/\.md$/i, '');
  const tabs = () => [...document.querySelectorAll('.pane.is-active .tab-strip [role="tab"]')];
  const tabTitles = () => tabs().map(tab => tab.querySelector('.tab-title')?.textContent || '');
  function activeEditor(path) {
    const content = document.querySelector('.pane.is-active .cm-content[contenteditable="true"]');
    const title = document.querySelector('.pane.is-active .note-title');
    const view = content?.cmTile?.root?.view || content?.cmView?.view;
    return title?.value === titleFor(path) && content?.getClientRects().length && view
      ? { content, view } : null;
  }

  async function openNote(path, newTab) {
    const existing = tabs().find(tab => tab.querySelector('.tab-title')?.textContent === titleFor(path));
    if (existing) existing.click();
    else {
      const row = await until(() => [...document.querySelectorAll('[role="treeitem"][data-path]')]
        .find(node => node.dataset.path === path), `${path} file-tree row`);
      row.scrollIntoView({ block: 'nearest' });
      row.dispatchEvent(new MouseEvent('click', {
        bubbles: true, button: 0, metaKey: newTab, ctrlKey: newTab,
      }));
    }
    const editor = await until(() => activeEditor(path), `${path} editor`);
    instrumentMemoryEditor(editor,path);
    editor.view.focus();
    await pause(100);
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function listedVault() {
    const vault = await bounded(window.__ZORID_NATIVE_BENCH__.getVault(), 'Admitted vault');
    if (!vault?.path) throw new Error('Memory workload requires an admitted disposable vault');
    const entries = await bounded(window.__ZORID_NATIVE_BENCH__.list(vault.path), 'Vault list', 30000);
    if (!Array.isArray(entries)) throw new Error('Vault list must return the ordinary entry array');
    const noteCount = entries.filter(entry => entry.type === 'file' && /\.md$/i.test(entry.path)).length;
    return { vault, listEntryCount: entries.length, listNoteCount: noteCount };
  }

  async function waitForFixtureAdmission() {
    if (!Number.isSafeInteger(state.expectedNotes) || state.expectedNotes < 1)
      throw new Error('Control must supply expectedNotes before the single-note baseline');
    const end = performance.now() + 120000;
    let last;
    while (performance.now() < end) {
      last = await listedVault();
      if (last.listNoteCount > state.expectedNotes)
        throw new Error(`Vault has ${last.listNoteCount} notes; expected exactly ${state.expectedNotes}`);
      if (last.listNoteCount === state.expectedNotes) return last;
      await pause(500);
    }
    throw new Error(`Fixture admission incomplete: ${last?.listNoteCount} of ${state.expectedNotes} notes`);
  }

  async function snapshot(phase) {
    const path = phase === 'large' ? 'Large.md' : phase === 'tabs' ? ordinaryPaths.at(-1) : ordinaryPaths[0];
    const editor = activeEditor(path);
    if (!editor) throw new Error(`Active editor changed before ${phase} snapshot`);
    const expectedPaths = phase === 'single' ? ordinaryPaths.slice(0, 1)
      : phase === 'tabs' ? ordinaryPaths : [...ordinaryPaths, 'Large.md'];
    const expectedTitles = expectedPaths.map(titleFor), actualTitles = tabTitles();
    if (actualTitles.length !== expectedTitles.length
      || !expectedTitles.every(title => actualTitles.filter(actual => actual === title).length === 1)) {
      throw new Error(`Expected ${expectedTitles.length} unique note tabs; found ${JSON.stringify(actualTitles)}`);
    }
    const { vault, listEntryCount, listNoteCount } = await listedVault();
    if (listNoteCount !== state.expectedNotes)
      throw new Error(`Admitted note count changed: ${listNoteCount} of ${state.expectedNotes}`);
    const source = await bounded(window.__ZORID_NATIVE_BENCH__.read(vault.path, path), 'Active durable source read');
    const documentText = editor.view.state.doc.toString();
    const docHash = await sha256(documentText), sourceHash = await sha256(source);
    if (docHash !== sourceHash) throw new Error('Active editor differs from durable fixture source');
    const byteLength = text => new TextEncoder().encode(text).byteLength;
    return {
      expectedPaths, expectedTitles, actualTitles, tabCount: actualTitles.length,
      activePath: path, activeTitle: document.querySelector('.pane.is-active .note-title')?.value,
      activeDocument: { length: documentText.length, bytes: byteLength(documentText), sha256: docHash },
      durableSource: { length: source.length, bytes: byteLength(source), sha256: sourceHash },
      exactActiveSourceMatches: documentText === source,
      paneCount: document.querySelectorAll('.pane').length,
      editorDOMCount: document.querySelectorAll('.cm-editor').length,
      editableDOMCount: document.querySelectorAll('.cm-content[contenteditable="true"]').length,
      activeDOMLines: editor.content.querySelectorAll('.cm-line').length,
      activeDocumentLines: editor.view.state.doc.lines,
      treeItemCount: document.querySelectorAll('[role="treeitem"][data-path]').length,
      fileTreeItemCount: document.querySelectorAll('[role="treeitem"][data-path]:not(.folder-row)').length,
      expectedNotes: state.expectedNotes, listEntryCount, listNoteCount,
      reconciliation: vault.reconciliation ?? null,
      visibility: document.visibilityState, documentHasFocus: document.hasFocus(),
      activeElement: document.activeElement?.className || null,
      workspaceRect: {width:document.querySelector('.workspace').getBoundingClientRect().width,height:document.querySelector('.workspace').getBoundingClientRect().height},
      editorRect:{width:editor.content.getBoundingClientRect().width,height:editor.content.getBoundingClientRect().height},
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      userAgent: navigator.userAgent,
      inputTrace: memoryTrace(),
      measurementLock:lockSnapshot(),
      actionEvidence: 'Programmatic DOM file-tree/tab clicks through ordinary application handlers; no keyboard/IME or OS input claim.',
      tabsEvidence: 'Actual tab DOM and active CodeMirror state; inactive tabs need not retain editor DOM instances.',
      sourceEvidence: 'Active CodeMirror document exactly equals read-only durable bridge source; no fixture edits performed.',
    };
  }

  async function deliver(report) {
    state.lastReport = report;
    await bounded(window.__TAURI__.core.invoke('tauri_bench_report', { input: report }), 'Native phase report');
  }

  async function runPhase(phase) {
    if(phase==='close'){
      stopped=true;
      try{
        if(memoryPhase()&&state.lastReport)await deliver({...state.lastReport,traceAtClose:true,inputTrace:memoryTrace(),measurementLock:lockSnapshot()});
      }finally{removeMeasurementLock();}
      await window.__TAURI__.core.invoke('tauri_bench_close');return;
    }
    if(phase==='save'){setMeasurementLock(false);return runSave();}
    const index = phases.indexOf(phase);
    if (index < 0) throw new Error(`Unknown memory phase ${phase}`);
    if (index <= completed) return state.lastReport;
    state.requestedPhase = phase;
    setMeasurementLock(memoryPhase());
    if (phase === 'done') { stopped = true; state.phase = 'done'; removeMeasurementLock();return state.lastReport; }
    state.phase = `preparing-${phase}`;
    try {
      await until(() => window.__ZORID_NATIVE_BENCH__ && document.querySelector('.workspace'), 'Workspace and bridge');
      if (completed < 0) {
        await waitForFixtureAdmission();
        await openNote('Benchmark.md', false);
        if (tabs().length !== 1) throw new Error('Single-note baseline requires exactly one actual note tab');
      }
      if (index >= 1 && completed < 1) {
        for (const path of ordinaryPaths.slice(1)) await openNote(path, true);
      }
      if (index >= 2 && completed < 2) await openNote('Large.md', true);
      const evidence = await snapshot(phase);
      const report = { version: 1, kind: 'shell-memory-phase', phase, status: 'ready',
        date: new Date().toISOString(), ...evidence };
      completed = index; state.phase = `ready-${phase}`;
      await deliver(report);
      return report;
    } catch (error) {
      state.phase = `failed-${phase}`;
      const report = { version: 1, kind: 'shell-memory-phase', phase, status: 'failed',
        error: String(error?.message || error), actualTitles: tabTitles(),
        visibility: document.visibilityState, documentHasFocus: document.hasFocus(), inputTrace:memoryTrace(),measurementLock:lockSnapshot() };
      await deliver(report);
      return report;
    }
  }

  async function runSave(){
    const control=window.__nativeBenchControl, report={phase:'save',status:'running',marker:control.marker,verifyOnly:!!control.verifyOnly};
    try{
      await until(()=>window.__ZORID_NATIVE_BENCH__&&document.querySelector('.workspace'),'Native workspace');
      if(control.probeFocus===true){
        const bridge=window.__ZORID_NATIVE_BENCH__, vault=await bridge.getVault();
        // DEBUG-native-focus: observe the untouched seed before any focus action.
        const original=await bridge.read(vault.path,'Benchmark.md');
        const events=[],transactions=[],wrapped=new WeakSet(),restore=[];
        const short=text=>({length:text.length,bytes:new TextEncoder().encode(text).length,tail:text.slice(-90)});
        const boundedJSON=value=>{try{return JSON.stringify(value).slice(0,1500);}catch{return '<unserializable>';}};
        const activeDocument=()=>{
          const title=document.querySelector('.pane.is-active .note-title')?.value;
          const editor=title?activeEditor(title+'.md'):null;
          return{title,document:editor?short(editor.view.state.doc.toString()):null};
        };
        const onEvent=event=>{
          if(events.length>=100)return;
          events.push({type:event.type,inputType:event.inputType??null,isTrusted:event.isTrusted,
            at:performance.now(),target:event.target?.nodeName,className:event.target?.className,
            ...activeDocument()});
        };
        const eventNames=['beforeinput','input','focusin','focusout'];
        for(const name of eventNames)document.addEventListener(name,onEvent,true);
        function instrument(path){
          const editor=activeEditor(path);if(!editor||wrapped.has(editor.view))return;
          const view=editor.view,dispatch=view.dispatch;wrapped.add(view);
          view.dispatch=function(...args){
            const before=view.state.doc.toString();
            const changes=args.map(arg=>{
              const change=arg?.changes;
              let value=null;
              try{value=change?.toJSON?change.toJSON():change??null;}catch{}
              return{changes:value,userEvent:arg?.userEvent??null,
                input:!!arg?.isUserEvent?.('input')||String(arg?.userEvent??'').startsWith('input'),
                delete:!!arg?.isUserEvent?.('delete')||String(arg?.userEvent??'').startsWith('delete')};
            });
            try{return dispatch.apply(this,args);}
            finally{
              const after=view.state.doc.toString();
              if(transactions.length<100)transactions.push({path,at:performance.now(),changed:before!==after,
                before:short(before),after:short(after),changes:boundedJSON(changes),
                domTail:editor.content.innerHTML.slice(-350)});
            }
          };
          restore.push(()=>{view.dispatch=dispatch;});
        }
        try{
          await openNote('Benchmark.md',false);instrument('Benchmark.md');
          report.probeFocus=true;report.original=short(original);report.originalHash=await sha256(original);
          report.afterFirstOpen=short(activeEditor('Benchmark.md').view.state.doc.toString());
          for(let cycle=0;cycle<4;cycle++){
            await openNote('Note 1.md',true);instrument('Note 1.md');await pause(200);
            await openNote('Benchmark.md',false);instrument('Benchmark.md');await pause(200);
          }
          await pause(1200);
          const saved=await bridge.read(vault.path,'Benchmark.md');
          const current=activeEditor('Benchmark.md').view.state.doc.toString();
          Object.assign(report,{saved:short(saved),savedHash:await sha256(saved),currentDocument:short(current),
            currentHash:await sha256(current),events,transactions,noteTitles:tabTitles(),
            exactOriginalPreserved:saved===original&&current===original});
          if(!report.exactOriginalPreserved)throw Error('Read-only focus probe changed the original fixture text');
          report.status='passed';
        }finally{
          for(const name of eventNames)document.removeEventListener(name,onEvent,true);
          for(const stop of restore)stop();
        }
        await window.__TAURI__.core.invoke('tauri_bench_report',{input:report});return report;
      }
      const bridge=window.__ZORID_NATIVE_BENCH__, vault=await bridge.getVault();
      const original=await bridge.read(vault.path,'Benchmark.md');
      await openNote('Benchmark.md',false);
      const beforeEditDocument=activeEditor('Benchmark.md').view.state.doc.toString();
      const beforeEditSaved=await bridge.read(vault.path,'Benchmark.md');
      report.originalHash=await sha256(original);report.originalLength=original.length;
      report.preEditOriginalPreserved=beforeEditDocument===original&&beforeEditSaved===original;
      if(!report.preEditOriginalPreserved)throw Error('Opening/focusing changed the original note before any intended edit');
      if(control.verifyOnly){
        if(!original.startsWith(control.marker+'\n'))throw Error('Restart lost exact benchmark prefix');
        if(await bridge.read(vault.path,'Untitled.md')!==control.marker+' created note\n')throw Error('Restart lost created note');
        report.benchmarkText=original;report.createdText=await bridge.read(vault.path,'Untitled.md');
      }else{
        const view=activeEditor('Benchmark.md').view;
        view.dispatch({changes:{from:0,insert:control.marker+'\n'},userEvent:'input.type'});
        const expected=control.marker+'\n'+original;
        const end=performance.now()+30000;let saved;
        while(performance.now()<end){saved=await bridge.read(vault.path,'Benchmark.md');if(saved===expected)break;await pause(100);}
        if(saved!==expected)throw Error('Native edit did not save exact bytes');
        report.benchmarkText=saved;
        document.querySelector('button[aria-label="New note"]').click();
        const note=await until(()=>activeEditor('Untitled.md'),'Created note editor');
        note.view.dispatch({changes:{from:0,insert:control.marker+' created note\n'},userEvent:'input.type'});
        // The close handshake must flush this note, even if its timer has not fired.
        report.createdText=control.marker+' created note\n';report.createdDOM=note.view.state.doc.toString();
        if(report.createdDOM!==report.createdText)throw Error('New note edit rejected');
      }
      report.noteTitles=tabTitles();report.hasDesktopSidebar=!!document.querySelector('[role="tree"]');report.status='passed';
    }catch(error){report.status='failed';report.error=String(error?.message||error);report.body=document.body.innerText.slice(0,3000);}
    await window.__TAURI__.core.invoke('tauri_bench_report',{input:report});return report;
  }

  function advance(phase) {
    const pending = queue.then(() => runPhase(phase));
    queue = pending.catch(() => {});
    return pending;
  }

  async function poll() {
    state.polling = true;
    let requested;
    while (!stopped) {
      try {
        const control = await bounded(window.__TAURI__.core.invoke('tauri_bench_control'), 'Native phase control');
        window.__nativeBenchControl=control;
        if(control.phase!=='close'&&control.phase!=='done')setMeasurementLock(['single','tabs','large'].includes(control.phase));
        if (Number.isSafeInteger(control.expectedNotes) && control.expectedNotes > 0) {
          if (state.expectedNotes !== null && state.expectedNotes !== control.expectedNotes)
            throw new Error('Expected fixture count changed during memory run');
          state.expectedNotes = control.expectedNotes;
        }
        if (control.phase && control.phase !== requested) {
          requested = control.phase;
          await advance(control.phase);
        }
      } catch (error) { state.pollError = String(error?.message || error); }
      if (!stopped) await pause(250);
    }
    state.polling = false;
  }

  window.__memoryBench = { state, advance, trace:memoryTrace };
  const start = () => { void poll(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
