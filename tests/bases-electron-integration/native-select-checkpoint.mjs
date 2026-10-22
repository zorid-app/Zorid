import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function nativeSelectCuaMode(args,{windowMode,bootstrap,campaignPath,minimalCampaignPath,allowedCampaignPaths}){
  const minimal=args.includes('--cua-native-select-checkpoint'),journey=args.includes('--cua-native-selects');
  assert.ok(!(minimal&&journey),'CUA input modes are mutually exclusive');
  if(!minimal&&!journey)return undefined;
  assert.equal(windowMode,'visible','CUA checkpoint requires the shown owned window');
  assert.equal(bootstrap,false,'CUA input mode cannot run the window bootstrap probe');
  if(minimal)assert.equal(campaignPath,minimalCampaignPath,'CUA takeover is restricted to the minimal native SELECT probe');
  else assert.ok(!campaignPath||allowedCampaignPaths.includes(campaignPath),'CUA selects require the default journey or a canonical owned campaign');
  return minimal?'minimal':'journey';
}

export function nativeSelectCuaRequest(frame){
  assert.equal(typeof frame.selector,'string');assert.equal(typeof frame.expectedValue,'string');
  const options=frame.options.filter(option=>option.value===frame.expectedValue);
  assert.equal(options.length,1,'Exact uniquely identified requested native option');assert.equal(options[0].disabled,false);
  const {tag,matches,connected,open,focus,nativeDisabled,ariaDisabled,inert,document,value,selectedIndex}=frame;
  return {tag,matches,connected,open,focus,nativeDisabled,ariaDisabled,inert,document,value,selectedIndex,
    selectorSHA256:sha256(frame.selector),expectedValue:frame.expectedValue,
    expectedOption:{value:frame.expectedValue,label:options[0].label,index:frame.options.indexOf(options[0])}};
}

export function assertSingleCuaProcess(rows,executable,pid){
  const matches=rows.filter(row=>row.command===executable||row.command.startsWith(executable+' '));
  assert.deepEqual(matches.map(row=>row.pid),[pid],'CUA executable identifies only the owned Electron main process');
  return matches[0];
}

/** Control-flow rendezvous only: this helper cannot issue input or select data. */
export async function waitForNativeSelectCua({directory,identity,request,evidence,isAlive,onReady=()=>{},timeoutMs=300000,pollMs=100}){
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'Bounded CUA checkpoint deadline');
  assert.ok(Number.isInteger(pollMs)&&pollMs>0&&pollMs<=1000,'Bounded checkpoint polling');
  assert.ok(path.isAbsolute(directory)&&await fs.realpath(path.dirname(directory))===path.dirname(directory),'Canonical private evidence parent');
  assert.ok(Number.isSafeInteger(identity.pid)&&identity.pid>0&&path.isAbsolute(identity.executable)&&path.isAbsolute(identity.profile),'Exact owned process identity required');
  assert.ok(Array.isArray(identity.windowIds)&&identity.windowIds.length&&identity.windowIds.every(id=>Number.isSafeInteger(id)&&id>0),'Owned visible window identity required');
  assert.equal(request.tag,'SELECT');assert.equal(request.matches,1);assert.equal(request.connected,true);assert.equal(request.open,true);assert.equal(request.focus.isSelect,true);
  assert.equal(request.nativeDisabled,false);assert.equal(request.ariaDisabled,false);assert.equal(request.inert,false);assert.ok(isAlive(),'Owned Electron process is alive');
  await fs.mkdir(directory,{mode:0o700}); // Fresh, non-shared, never reused.
  assert.equal(await fs.realpath(directory),directory);
  const readyFile=path.join(directory,'ready.json'),continueFile=path.join(directory,'continue.json'),token=randomUUID();
  const ready={kind:'owned-native-select-cua-checkpoint',token,created:new Date().toISOString(),deadlineMs:timeoutMs,identity:structuredClone(identity),request:structuredClone(request),continueFile,continuationSchema:{token,action:'continue'}};
  const bytes=JSON.stringify(ready,null,2)+'\n';await fs.writeFile(readyFile,bytes,{flag:'wx',mode:0o600});
  evidence.actions.push({action:'native-select-cua-ready',readyFile,readySHA256:sha256(bytes),...ready,at:Date.now()});onReady({readyFile,continueFile,token,pid:identity.pid,windowIds:identity.windowIds});
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    assert.ok(isAlive(),'Owned Electron exited during CUA checkpoint');
    const folder=await fs.lstat(directory);assert.ok(folder.isDirectory()&&!folder.isSymbolicLink(),'Private checkpoint directory cannot alias another location');
    let handle;
    try{handle=await fs.open(continueFile,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(handle){
      let signalBytes;
      try{const stat=await handle.stat();assert.ok(stat.isFile()&&stat.size<=4096,'Bounded regular continuation file');signalBytes=await handle.readFile();}finally{await handle.close();}
      const signal=JSON.parse(signalBytes.toString('utf8'));
      assert.deepEqual(Object.keys(signal).sort(),['action','token'],'Continuation accepts control flow only');assert.equal(signal.token,token,'Fresh checkpoint nonce required');assert.equal(signal.action,'continue');
      const readyHandle=await fs.open(readyFile,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{assert.equal(await readyHandle.readFile('utf8'),bytes,'Ready identity and request stayed unchanged');}finally{await readyHandle.close();}
      assert.ok(isAlive(),'Owned Electron is still alive');
      evidence.actions.push({action:'native-select-cua-continued',continueFile,signalSHA256:sha256(signalBytes),token,at:Date.now()});return;
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,end-Date.now()))));
  }
  throw new Error('Owned native SELECT CUA checkpoint deadline expired');
}
