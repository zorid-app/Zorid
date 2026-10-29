export const DEADLINE_MS=800;
export const baseFixtureSource=()=>JSON.stringify({filters:'file.ext == "md"',views:[{id:'profilebase1',type:'table',name:'Profile table',source:{kind:'untyped'},order:['file.name'],sort:[{property:'file.name',direction:'ASC'}]}]},null,2)+'\n';
export function reopenPrepared(launch){return launch.returnToStartupNoteVerified===true&&!launch.errors?.length&&!launch.cleanupErrors?.length&&launch.cleanup?.normal===true&&launch.cleanup.gone===true&&launch.fixturesRestored===true&&launch.sourcePathsExact===true&&launch.artifactsUnchanged===true;}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function fixtureText(bytes,index=0){
  if(!Number.isSafeInteger(bytes)||bytes<1024||bytes>1024*1024)throw Error('Fixture size outside bounded note range');
  const prefix=`# Packaged profile ${index}\n\nVisible first paragraph for note ${index}.\n\n`,line='Ordinary Markdown text; retained later content must stay exact.\n';
  return prefix+line.repeat(Math.floor((bytes-prefix.length)/line.length))+line.slice(0,(bytes-prefix.length)%line.length);
}
/** A remote performance.now() sample belongs somewhere inside its monotonic
 * runner request/response bracket. Never subtract independent timeOrigins. */
export function clockInterval(at,samples){
  if(!finite(at)||!Array.isArray(samples)||!samples.length)throw Error('Missing monotonic clock handshake');
  const origin=samples[0].timeOrigin;
  for(const sample of samples)if(!finite(origin)||!finite(sample.remoteNow)||sample.remoteNow<0||!finite(sample.before)||sample.before<0||!finite(sample.after)||sample.after<sample.before||sample.timeOrigin!==origin)throw Error('Invalid or replaced renderer clock');
  return {lower:at+Math.min(...samples.map(s=>s.before-s.remoteNow)),upper:at+Math.max(...samples.map(s=>s.after-s.remoteNow))};
}
export function assessNote(value){
  const errors=[...(value.errors??[]),...(value.observed?.errors??[])],require=(ok,message)=>{if(!ok)errors.push(message);};
  require(value.deadlineMs===DEADLINE_MS,'Deadline differs from fixed800ms');
  require(value.packaged===true&&value.packagedUrlVerified===true,'Actual packaged app/renderer not verified');
  require(finite(value.originMs),'Missing monotonic launch/open origin');
  require(value.observed?.identity===value.identity,'Observer identity differs');
  require(value.observed?.initial?.length===value.expectedCharacters&&value.observed.initial.prefixMatches===true,'Wrong initial full document');
  require(value.observed?.ready?.visible===true&&value.observed.ready.editable===true,'Missing visible editable first viewport');
  require(value.body?.exact===true&&value.body?.sha256===value.expectedEditedSha256,'Complete edited-body verification failed');
  require(value.cleanup?.normal===true&&value.cleanup?.gone===true,'App did not quit normally with all owned PIDs gone');
  require(value.artifactsUnchanged===true,'Packaged artifacts changed during launch');
  const probes=value.observed?.probes??[],dispatches=value.dispatches??[];
  const ready=probes.filter(p=>p.name==='ready'),deadline=dispatches.filter(p=>p.name==='deadline');
  require(ready.length===1&&dispatches.filter(p=>p.name==='ready').length===1,'Readiness input was missing or retried');
  require(deadline.length===1,'Fixed deadline attempt was missing or retried');
  for(const p of probes){
    require(p.trusted===true&&p.accepted===true&&p.identity===value.identity,`${p.name}: input not trusted/accepted in selected editor`);
    require(p.caretAfterPaint===p.expectedCaretAfterPaint,`${p.name}: caret changed after paint`);
  }
  require(probes.length===new Set(probes.map(p=>p.name)).size,'Repeated input probe');
  const firstInput=[...probes].sort((a,b)=>a.appliedAt-b.appliedAt)[0];
  let input=null,viewport=null,installed=null,deadlineObserved=null;
  try{
    if(firstInput)input=clockInterval(firstInput.appliedAt,value.clockSamples);
    viewport=clockInterval(value.observed?.ready?.at,value.clockSamples);
    installed=clockInterval(value.observed?.installedAt,value.clockSamples);
    if(deadline[0]?.observation)deadlineObserved=clockInterval(deadline[0].observation.at,value.clockSamples);
  }catch(error){errors.push(error.message);}
  require(firstInput?.appliedAt>=value.observed?.ready?.at,'Input preceded verified first viewport');
  if(deadline[0]?.status==='sent')require(probes.filter(p=>p.name==='deadline').length===1,'Sent fixed probe was not observed exactly once');
  const diagnosticInput=input?{lower:input.lower-value.originMs,upper:input.upper-value.originMs}:null;
  if(errors.length)return {valid:false,outcome:'invalid-receipt',usableByDeadline:false,inputMs:diagnosticInput,errors};
  const end=value.originMs+DEADLINE_MS;
  if(deadline[0].status==='unobservable'||!installed||installed.upper>end)return {valid:false,outcome:'indeterminate',usableByDeadline:false,inputMs:diagnosticInput,errors:['Deadline not continuously observable; attachment overhead cannot establish an app miss']};
  if(input.upper<=end&&viewport.upper<=end)return {valid:true,outcome:'target-met',usableByDeadline:true,inputMs:diagnosticInput,viewportMs:{lower:viewport.lower-value.originMs,upper:viewport.upper-value.originMs},errors:[]};
  // An installed continuous observer retains the FIRST verified viewport. A
  // not-ready observation after the deadline proves it was not ready by800ms.
  if(deadline[0].status==='observed-not-ready'&&deadline[0].observation?.ready===null&&deadlineObserved?.lower>=end)return {valid:true,outcome:'target-missed',usableByDeadline:false,inputMs:diagnosticInput,errors:[]};
  return {valid:false,outcome:'indeterminate',usableByDeadline:false,inputMs:diagnosticInput,errors:['Clock uncertainty or automation dispatch delay overlaps the deadline; no app latency verdict']};
}
export function planCampaign(repetitions=1,seed=1){
  if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>5||!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('Invalid repetitions or seed');
  let state=seed>>>0;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const result=[];
  for(let repetition=1;repetition<=repetitions;repetition++){
    const labels=random()<0.5?['baseline','candidate']:['candidate','baseline'];
    for(const label of labels)for(const mode of ['first-import','reopen'])result.push({label,mode,repetition,pairId:`${label}-${repetition}`});
  }
  return result;
}
