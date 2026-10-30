import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';

const isZombie=row=>typeof row.state==='string'&&row.state.startsWith('Z');
// macOS ps(1): E is a modifier after a run state, meaning trying to exit.
// It grants neither live authority nor proof that the process has exited.
const isExiting=row=>typeof row.state==='string'&&/^[IRSTU][+<>AELNSsVWX]*$/.test(row.state)&&row.state.slice(1).includes('E');
const isLive=row=>!isZombie(row)&&!isExiting(row);
const observedRow=row=>JSON.stringify({pid:row.pid,parent:row.parent,state:row.state??null,command:row.command});
export function parseProcessRows(output){
  return output.split('\n').filter(line=>line.trim()).map(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    assert.ok(match,`Process row includes PID, PPID and state (row length ${line.length})`);
    const pid=Number(match[1]),parent=Number(match[2]);
    assert.ok(Number.isSafeInteger(pid)&&Number.isSafeInteger(parent),'Safe process IDs');
    return {pid,parent,state:match[3],command:match[4]??''};
  });
}

/** Inspect only this launch's authenticated relay events and exact commands.
 * Remember command identities independently of PPID so later reparenting never
 * makes an owned native process invisible to cleanup. No broad name matching. */
export function relayProcessOwnership({events,rows,native,vault,identity,appPid,requireLineage=false,previouslyOwned=[],generation}){
  assert.ok(path.isAbsolute(identity?.executable)&&Array.isArray(identity.args)&&identity.args.every(value=>typeof value==='string'),'Exact relay executable/argv prefix');
  const started=events.filter(event=>event.kind==='started'&&(generation===undefined||event.generation===generation));assert.equal(started.length,1,'One real relay/native launch');
  const event=started[0];assert.equal(event.native,native,'Matched genuine native path');
  assert.ok(Array.isArray(event.args)&&event.args.every(value=>typeof value==='string'),'Observed native argv');
  assert.equal(event.args[0],'--vault');assert.equal(event.args[1],vault,'Only the owned disposable vault');
  assert.ok(Number.isSafeInteger(event.relayPid)&&event.relayPid>0&&Number.isSafeInteger(event.nativePid)&&event.nativePid>0&&event.nativePid!==event.relayPid,'Distinct owned process IDs');
  const expected=[
    {pid:event.relayPid,parent:appPid,command:[identity.executable,...identity.args,...event.args].join(' '),kind:'relay'},
    {pid:event.nativePid,parent:event.relayPid,command:[native,...event.args].join(' '),kind:'genuine-native'},
  ];
  const previous=[...previouslyOwned];
  for(const owned of expected){
    const prior=previous.find(row=>row.pid===owned.pid&&row.command===owned.command&&row.kind===owned.kind&&row.parent===owned.parent&&row.authenticatedAtLaunch===true);
    if(prior){owned.authenticatedAtLaunch=true;if(prior.exitedNotReaped)owned.exitedNotReaped={...prior.exitedNotReaped};if(prior.exiting)owned.exiting={...prior.exiting};}
    const live=rows.find(row=>row.pid===owned.pid);
    if(requireLineage)assert.ok(live&&isLive(live),'Owned process is live at launch');
    if(!live)continue;
    if(isZombie(live)){
      assert.ok(prior,'Exited-not-reaped process requires exact prior launch authentication');
      owned.exitedNotReaped={state:live.state,parent:live.parent,command:live.command};
    }else if(isExiting(live)){
      assert.ok(prior,'Exiting process requires exact prior launch authentication');
      owned.exiting={state:live.state,parent:live.parent,command:live.command};
    }else{
      assert.ok(!prior?.exiting,'An exiting process cannot regain live authority');
      assert.equal(live.command,owned.command,`Exact owned process command; observed row ${observedRow(live)}`);
      if(requireLineage){assert.equal(live.parent,owned.parent,'Actual app → relay → genuine-native lineage');owned.authenticatedAtLaunch=true;}
    }
    owned.observedParent=live.parent;owned.observedState=live.state;
  }
  return expected;
}
export function livingOwnedProcesses(owned,rows){return [...owned].filter(value=>rows.some(row=>row.pid===value.pid&&row.command===value.command&&isLive(row)));}

/** Startup can die before its first event append. The fresh private relay
 * control path and fresh private vault identify these exact two allowed argv
 * forms independently of PPID; an app/relay exit must not hide their children. */
export function discoverUnannouncedRelayProcesses({rows,native,vault,identity}){
  assert.ok(path.isAbsolute(identity?.executable)&&Array.isArray(identity.args),'Exact relay prefix');
  const nativeArgs=[['--vault',vault],['--vault',vault,'--initialize-local']];
  const commands=new Map(nativeArgs.flatMap(args=>[[[identity.executable,...identity.args,...args].join(' '),'relay'],[[native,...args].join(' '),'genuine-native']]));
  return rows.flatMap(row=>{const kind=commands.get(row.command);return kind&&isLive(row)?[{...row,kind,discoveredBeforeEvent:true}]:[];});
}

const generationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const closeKinds=new Set(['closed','drop-child-closed','held-child-closed']);
/** Positive generation authority comes only from a started event AND a fresh
 * exact app → relay → Native process observation. Discovery remains separate. */
export function createNativeGenerationRegistry({native,vault,identity,appCommand}){
  assert.ok(typeof appCommand==='string'&&appCommand.length,'Exact owned app command');
  let records=new Map(),currentGeneration=null,eventFingerprints=[];
  const snapshot=()=>structuredClone({current:records.get(currentGeneration)??null,generations:[...records.values()]});
  function observe({events,rows,appPid}){
    assert.ok(Array.isArray(events)&&Array.isArray(rows),'Complete relay events and actual process rows');
    assert.equal(new Set(rows.map(row=>row.pid)).size,rows.length,'Unambiguous process IDs');
    const fingerprints=events.map(event=>createHash('sha256').update(JSON.stringify(event)).digest('hex'));
    assert.ok(fingerprints.length>=eventFingerprints.length&&eventFingerprints.every((hash,index)=>fingerprints[index]===hash),'Append-only relay event history');
    const next=new Map([...records].map(([generation,record])=>[generation,structuredClone(record)]));
    const starts=events.filter(event=>event.kind==='started'),seen=new Set();
    for(const event of starts){
      assert.match(event.generation,generationPattern,'Canonical relay generation');
      assert.ok(!seen.has(event.generation),'One start per relay generation');seen.add(event.generation);
      assert.ok(event.args?.length===2||(event.args?.length===3&&event.args[2]==='--initialize-local'),'Exact owned Native argv');
      let record=next.get(event.generation);
      if(record){
        assert.deepEqual({native:event.native,args:event.args,relayPid:event.relayPid,nativePid:event.nativePid},record.start,'Immutable generation launch identity');
      }else{
        for(const previous of next.values())assert.ok(![previous.relayPid,previous.nativePid].some(pid=>pid===event.relayPid||pid===event.nativePid),'No process ID reuse across generations');
        const app=rows.find(row=>row.pid===appPid);
        assert.ok(app&&isLive(app),'Original owned app is live for first generation authentication');
        assert.equal(app.command,appCommand,`Exact owned app command; observed row ${observedRow(app)}`);
        assert.ok(appPid!==event.relayPid&&appPid!==event.nativePid,'Distinct owned app, relay and Native PIDs');
        const processes=relayProcessOwnership({events:[event],rows,native,vault,identity,appPid,requireLineage:true});
        record={generation:event.generation,appPid,relayPid:event.relayPid,nativePid:event.nativePid,authenticatedAtLaunch:true,
          start:{native:event.native,args:[...event.args],relayPid:event.relayPid,nativePid:event.nativePid},
          expectedCommands:{app:appCommand,relay:processes[0].command,native:processes[1].command},processes,closeObservations:[],intentionalFault:null,terminalProcessIds:[]};
        next.set(event.generation,record);
      }
    }
    for(const generation of next.keys())assert.ok(seen.has(generation),'Previously authenticated start remains in complete event history');
    for(const event of events){
      assert.match(event.generation,generationPattern,'Every relay event has a canonical generation');
      const record=next.get(event.generation);assert.ok(record,'Event belongs to a started generation');
      assert.equal(event.relayPid,record.relayPid,'Event relay PID matches generation');
      assert.equal(event.nativePid,record.nativePid,'Event Native PID matches generation');
    }
    const liveGenerations=[];
    for(const record of next.values()){
      const app=rows.find(row=>row.pid===record.appPid);
      if(app&&isExiting(app)){
        assert.ok(record.authenticatedAtLaunch,'Exiting app requires exact prior launch authentication');
        record.appExiting={state:app.state,parent:app.parent,command:app.command};
      }else if(app&&isLive(app)){
        assert.ok(!record.appExiting,'An exiting app cannot regain live authority');
        assert.equal(app.command,appCommand,`Exact live owned app command; observed row ${observedRow(app)}`);
      }
      for(const pid of record.terminalProcessIds){const row=rows.find(value=>value.pid===pid);assert.ok(!row||isZombie(row),'No live terminal process ID may reappear');}
      record.processes=relayProcessOwnership({events:starts,rows,native,vault,identity,appPid:record.appPid,generation:record.generation,previouslyOwned:record.processes});
      record.presence=Object.fromEntries(record.processes.map(process=>{const row=rows.find(row=>row.pid===process.pid);return[process.kind,row?(isZombie(row)?'exited-not-reaped':isExiting(row)?'exiting':'live'):'absent'];}));
      const closes=events.filter(event=>event.generation===record.generation&&closeKinds.has(event.kind));
      assert.equal(new Set(closes.map(event=>event.kind)).size,closes.length,'One close observation of each kind per generation');
      record.closeObservations=closes.map(event=>{
        assert.ok(event.exitCode===null||Number.isSafeInteger(event.exitCode),'Explicit Native close exit code');
        assert.ok(event.signal===null||typeof event.signal==='string','Explicit Native close signal');
        if(event.nativeTerminatedDuringHold!==undefined)assert.equal(typeof event.nativeTerminatedDuringHold,'boolean','Typed hold termination flag');
        if(event.withheldResponseSha256!==undefined)assert.ok(typeof event.withheldResponseSha256==='string'&&/^[0-9a-f]{64}$/.test(event.withheldResponseSha256),'SHA-256 sealed response digest');
        return{kind:event.kind,exitCode:event.exitCode,signal:event.signal,...(event.at!==undefined?{at:event.at}:{}),...(event.nativeTerminatedDuringHold!==undefined?{nativeTerminatedDuringHold:event.nativeTerminatedDuringHold}:{}),...(event.withheldResponseSha256!==undefined?{withheldResponseSha256:event.withheldResponseSha256}:{})};
      });
      const terminal=new Set(record.terminalProcessIds);
      for(const process of record.processes)if(['absent','exited-not-reaped'].includes(record.presence[process.kind]))terminal.add(process.pid);
      if(record.closeObservations.length){
        if(record.presence['genuine-native']!=='exiting')terminal.add(record.nativePid);
        assert.ok(record.presence['genuine-native']!=='live','No live terminal process ID after real Native close');
      }
      record.terminalProcessIds=[...terminal];
      if(record.presence['genuine-native']==='live')liveGenerations.push(record);
    }
    assert.ok(liveGenerations.length<=1,'Unambiguous current genuine Native generation');
    const candidate=liveGenerations[0],liveApp=rows.find(row=>row.pid===candidate?.appPid),liveRelay=rows.find(row=>row.pid===candidate?.relayPid),liveNative=rows.find(row=>row.pid===candidate?.nativePid);
    const current=candidate?.appPid===appPid&&liveApp&&isLive(liveApp)&&liveRelay&&isLive(liveRelay)&&liveNative&&isLive(liveNative)&&liveRelay.parent===candidate.appPid&&liveNative.parent===candidate.relayPid;
    records=next;eventFingerprints=fingerprints;currentGeneration=current?candidate.generation:null;
    return snapshot();
  }
  function killCurrent(generation,{events,rows,appPid,kill,at=Date.now()}){
    const observed=observe({events,rows,appPid});
    assert.equal(observed.current?.generation,generation,'Only the current generation may receive an intentional Native fault');
    const record=records.get(generation);assert.ok(!record.intentionalFault,'Generation already has an intentional fault');
    const app=rows.find(row=>row.pid===appPid);assert.ok(app&&isLive(app),'Owned app remains live immediately before fault');
    assert.equal(app.command,appCommand,`Exact owned app command immediately before fault; observed row ${observedRow(app)}`);
    relayProcessOwnership({events,rows,native,vault,identity,appPid,generation,requireLineage:true,previouslyOwned:record.processes});
    assert.equal(typeof kill,'function','Exact Native signal capability');
    assert.ok(Number.isSafeInteger(at)&&at>=0,'Exact intentional fault timestamp');
    kill(record.nativePid,'SIGKILL');
    record.intentionalFault={generation,appPid,relayPid:record.relayPid,nativePid:record.nativePid,signal:'SIGKILL',at};
    return structuredClone(record.intentionalFault);
  }
  function assertShutdown({events,rows,appPid}){
    const observed=observe({events,rows,appPid}),generations=observed.generations.filter(record=>record.appPid===appPid);
    assert.ok(generations.length,'An authenticated generation belongs to the quitting app');
    return generations.map(record=>{
      assert.ok(['absent','exited-not-reaped'].includes(record.presence.relay)&&['absent','exited-not-reaped'].includes(record.presence['genuine-native']),'No living owned generation after quit; exiting processes are still pending');
      const app=rows.find(row=>row.pid===record.appPid);
      assert.ok(!app||isZombie(app),'Owned app must be absent or exited-not-reaped after quit');
      if(record.intentionalFault){
        const held=record.closeObservations.find(close=>close.kind==='held-child-closed'),closed=record.closeObservations.find(close=>close.kind==='closed');
        assert.ok(held,'Real held Native close required after intentional fault');
        assert.ok(closed,'Real final Native close required after intentional fault');
        assert.ok(record.closeObservations.every(close=>close.exitCode===null&&close.signal==='SIGKILL'),'Intentional Native fault is never a normal close');
        assert.ok(record.closeObservations.every(close=>Number.isSafeInteger(close.at)&&close.at>=record.intentionalFault.at)&&closed.at>=held.at,'Real Native closes occur after the intentional fault');
        assert.match(held.withheldResponseSha256??'',/^[0-9a-f]{64}$/,'Sealed response digest required for held Native close');
        assert.equal(closed.nativeTerminatedDuringHold,true,'Real Native terminated during hold');
        return{generation:record.generation,kind:'intentional-native-sigkill',fault:record.intentionalFault,closeObservations:record.closeObservations,presence:record.presence};
      }
      assert.ok(record.closeObservations.some(close=>close.kind==='closed'&&close.exitCode===0&&close.signal===null),'Explicit normal Native closed 0/null signal required for every generation');
      assert.ok(record.closeObservations.every(close=>close.exitCode===0&&close.signal===null),'Consistent normal Native close outcomes');
      return{generation:record.generation,kind:'normal-native-close',closeObservations:record.closeObservations,presence:record.presence};
    });
  }
  return Object.freeze({observe,killCurrent,assertShutdown});
}
