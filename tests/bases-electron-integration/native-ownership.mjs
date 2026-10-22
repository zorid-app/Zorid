import assert from 'node:assert/strict';
import path from 'node:path';

/** Inspect only this launch's authenticated relay events and exact commands.
 * Remember command identities independently of PPID so later reparenting never
 * makes an owned native process invisible to cleanup. No broad name matching. */
export function relayProcessOwnership({events,rows,native,vault,identity,appPid,requireLineage=false}){
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
  for(const owned of expected){const live=rows.find(row=>row.pid===owned.pid);if(requireLineage)assert.ok(live,'Owned process is live at launch');if(live){assert.equal(live.command,owned.command,'Exact owned process command');if(requireLineage)assert.equal(live.parent,owned.parent,'Actual app → relay → genuine-native lineage');owned.observedParent=live.parent;}}
  return expected;
}
export function livingOwnedProcesses(owned,rows){return [...owned].filter(value=>rows.some(row=>row.pid===value.pid&&row.command===value.command));}

/** Startup can die before its first event append. The fresh private relay
 * control path and fresh private vault identify these exact two allowed argv
 * forms independently of PPID; an app/relay exit must not hide their children. */
export function discoverUnannouncedRelayProcesses({rows,native,vault,identity}){
  assert.ok(path.isAbsolute(identity?.executable)&&Array.isArray(identity.args),'Exact relay prefix');
  const nativeArgs=[['--vault',vault],['--vault',vault,'--initialize-local']];
  const commands=new Map(nativeArgs.flatMap(args=>[[[identity.executable,...identity.args,...args].join(' '),'relay'],[[native,...args].join(' '),'genuine-native']]));
  return rows.flatMap(row=>{const kind=commands.get(row.command);return kind?[{...row,kind,discoveredBeforeEvent:true}]:[];});
}
