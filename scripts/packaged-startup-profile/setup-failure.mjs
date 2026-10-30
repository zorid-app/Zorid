import {captureObserverFailure} from './observer.mjs';
/** Independent passive evidence attempts never hide the original setup failure
 * or prevent normal quit. Preserve case/activation history verbatim. */
export async function captureSetupFailure({renderer,main,windowSource,launch}){
  await Promise.allSettled([
    captureObserverFailure(renderer,launch),
    (async()=>{try{launch.failureWindow=main?await main.evaluate(windowSource):{unavailable:'Main inspector not attached'};}catch(error){launch.failureWindow={error:String(error)};}})(),
  ]);
}
