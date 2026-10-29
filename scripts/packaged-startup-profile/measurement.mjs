export const INTERFERENCE_CODE='PACKAGED_MEASUREMENT_INTERFERENCE';
export class MeasurementInterference extends Error{
  constructor(message){super(message);this.name='MeasurementInterference';this.code=INTERFERENCE_CODE;}
}
export const isMeasurementInterference=error=>error?.code===INTERFERENCE_CODE||String(error?.message??error).includes(INTERFERENCE_CODE);
export function requireForeground(window,document){
  if(!window?.visible||window.minimized||!window.focused)throw new MeasurementInterference('Owned window lost foreground visibility/focus');
  if(document&&(document.hidden||document.visibilityState!=='visible'))throw new MeasurementInterference('Owned renderer became hidden');
}
/** Expected loading assertions may retry. Measurement interference is terminal. */
export async function boundedMeasurement(action,{timeoutMs,now=()=>performance.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),guard=async()=>{}}){
  const end=now()+timeoutMs;let last;
  do{
    await guard();let value,succeeded=false;
    try{value=await action();succeeded=true;}
    catch(error){if(isMeasurementInterference(error))throw error;last=error;}
    if(succeeded){await guard();return value;}
    await pause(10);
  }while(now()<end);
  throw last??Error('Packaged profiling deadline');
}
export const documentVisibilitySource='({visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus()})';
/** A hidden renderer may never deliver RAF. Reject on visibility loss rather
 * than waiting for the CDP transport deadline; no refocus or input is sent. */
export function visibleFrames(){
  return new Promise((resolve,reject)=>{
    let ended=false;
    const finish=error=>{if(ended)return;ended=true;document.removeEventListener('visibilitychange',changed);error?reject(error):resolve();};
    const changed=()=>{if(document.hidden||document.visibilityState!=='visible')finish(Error('PACKAGED_MEASUREMENT_INTERFERENCE: renderer hidden during frame validation'));};
    document.addEventListener('visibilitychange',changed);changed();if(ended)return;
    requestAnimationFrame(()=>{if(!ended)requestAnimationFrame(()=>finish());});
  });
}
export const visibleFramesSource=`(${visibleFrames.toString()})()`;
