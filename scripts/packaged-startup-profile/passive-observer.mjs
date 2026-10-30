import {observerSource} from './observer.mjs';
import {visibleFramesSource} from './measurement.mjs';
const replaced='PACKAGED_OBSERVER_CONTEXT_REPLACED';
export function contextReplaced(error){
  if(error?.code===replaced)return true;
  let protocol;try{protocol=JSON.parse(error?.message??'');}catch{return false;}
  return protocol?.code===-32000&&/^(?:Execution context was destroyed\.?|Cannot find context with specified id\.?|Cannot find default execution context\.?)$/.test(protocol.message);
}
/** Register the future-document observer ONCE, then tolerate only ordinary CDP
 * context replacement while sampling the current passive observer/clock. */
export async function configurePassiveObserver({renderer,config,newDocument,sampleClock,now,timeoutMs,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const setup={startedAt:now(),attempts:[],discardedClockSamples:[]},end=setup.startedAt+timeoutMs;
  let script,last;
  try{
    if(newDocument)script=await renderer.call('Page.addScriptToEvaluateOnNewDocument',{source:observerSource(config)});
    while(now()<end){
      const attempt={startedAt:now()};setup.attempts.push(attempt);
      try{
        attempt.document=await renderer.evaluate(`${observerSource(config)};({identity:window.__zoridPackagedProbe?.identity,timeOrigin:performance.timeOrigin})`);
        if(attempt.document?.identity!==config.identity)throw Error('Passive observer identity differs');
        attempt.clock=await sampleClock();
        if(attempt.clock.timeOrigin!==attempt.document.timeOrigin){setup.discardedClockSamples.push(attempt.clock);throw Object.assign(Error('Observer document changed between installation and clock'),{code:replaced});}
        if(now()>=end)throw Error('Passive observer original setup deadline expired');
        attempt.completedAt=now();setup.completedAt=now();return {script,sample:attempt.clock,setup};
      }catch(error){attempt.error=String(error);attempt.completedAt=now();if(!contextReplaced(error))throw error;last=error;await pause(Math.min(10,Math.max(0,end-now())));}
    }
    throw last??Error('Passive observer original setup deadline expired');
  }catch(error){setup.completedAt=now();if(error&&typeof error==='object'&&Object.isExtensible(error))error.passiveObservation=setup;throw error;}
}

/** A historical first-ready event remains immutable. Every input independently
 * proves the CURRENT selected fixture after its already accepted marker prefix. */
export function selectedProbeViewport(config){
  const state=window.__zoridPackagedProbe,pane=document.querySelector('.pane.is-active'),node=pane?.querySelector('.cm-content'),view=node?.cmTile?.root?.view??node?.cmView?.view;
  if(state?.identity!==config.identity||!state.ready||!view||view.contentDOM!==node||pane.querySelector('.note-title')?.value!==config.path.split('/').at(-1).replace(/\.md$/i,''))throw Error('Selected probe viewport identity differs');
  if(state.probes.some(probe=>probe.accepted!==true||probe.trusted!==true))throw Error('Earlier trusted probe is not confirmed');
  const markers=state.probes.map(probe=>probe.marker).join(''),bounds=node.getBoundingClientRect();
  if(document.hidden||document.visibilityState!=='visible')throw Error('PACKAGED_MEASUREMENT_INTERFERENCE: selected probe viewport is hidden');
  if(node.getAttribute('contenteditable')!=='true'||node.closest('[inert]')||bounds.width<=0||bounds.height<=0||bounds.bottom<=0||bounds.top>=innerHeight||view.state.doc.length!==config.characters+markers.length||view.state.doc.sliceString(0,markers.length)!==markers||view.state.doc.sliceString(markers.length,markers.length+config.prefix.length)!==config.prefix||view.state.selection.main.head!==markers.length)throw Error('Selected probe viewport/source changed');
  const lines=[...pane.querySelectorAll('.cm-line')].slice(0,6),visible=lines.some(line=>{const r=line.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&line.textContent.includes(config.visibleText);});
  if(!visible)throw Error('Selected probe viewport marker is not visible');
  return {view,node,at:performance.now(),identity:state.identity,characters:view.state.doc.length,acceptedMarkers:markers,visible:true,editable:true,prefixMatches:true};
}
export const probeViewportSource=config=>`(async()=>{const check=${selectedProbeViewport.toString()},config=${JSON.stringify(config)},before=check(config);await ${visibleFramesSource};const after=check(config);if(after.view!==before.view||after.node!==before.node)throw Error('Selected probe viewport changed during paint');const {view,node,...evidence}=after;return evidence;})()`;
