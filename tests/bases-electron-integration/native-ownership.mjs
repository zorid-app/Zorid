import assert from 'node:assert/strict';
import path from 'node:path';

const isZombie=row=>typeof row.state==='string'&&row.state.startsWith('Z');
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
export function relayProcessOwnership({events,rows,native,vault,identity,appPid,requireLineage=false,previouslyOwned=[]}){
  assert.ok(path.isAbsolute(identity?.executable)&&Array.isArray(identity.args)&&identity.args.every(value=>typeof value==='string'),'Exact relay executable/argv prefix');
  const started=events.filter(event=>event.kind==='started');assert.equal(started.length,1,'One real relay/native launch');
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
    if(prior){owned.authenticatedAtLaunch=true;if(prior.exitedNotReaped)owned.exitedNotReaped={...prior.exitedNotReaped};}
    const live=rows.find(row=>row.pid===owned.pid);
    if(requireLineage)assert.ok(live&&!isZombie(live),'Owned process is live at launch');
    if(!live)continue;
    if(isZombie(live)){
      assert.ok(prior,'Exited-not-reaped process requires exact prior launch authentication');
      owned.exitedNotReaped={state:live.state,parent:live.parent,command:live.command};
    }else{
      assert.equal(live.command,owned.command,'Exact owned process command');
      if(requireLineage){assert.equal(live.parent,owned.parent,'Actual app → relay → genuine-native lineage');owned.authenticatedAtLaunch=true;}
    }
    owned.observedParent=live.parent;owned.observedState=live.state;
  }
  return expected;
}
export function livingOwnedProcesses(owned,rows){return [...owned].filter(value=>rows.some(row=>row.pid===value.pid&&row.command===value.command&&!isZombie(row)));}

/** Startup can die before its first event append. The fresh private relay
 * control path and fresh private vault identify these exact two allowed argv
 * forms independently of PPID; an app/relay exit must not hide their children. */
export function discoverUnannouncedRelayProcesses({rows,native,vault,identity}){
  assert.ok(path.isAbsolute(identity?.executable)&&Array.isArray(identity.args),'Exact relay prefix');
  const nativeArgs=[['--vault',vault],['--vault',vault,'--initialize-local']];
  const commands=new Map(nativeArgs.flatMap(args=>[[[identity.executable,...identity.args,...args].join(' '),'relay'],[[native,...args].join(' '),'genuine-native']]));
  return rows.flatMap(row=>{const kind=commands.get(row.command);return kind&&!isZombie(row)?[{...row,kind,discoveredBeforeEvent:true}]:[];});
}
