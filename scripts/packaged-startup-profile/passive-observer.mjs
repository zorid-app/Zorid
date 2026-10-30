import {observerSource} from './observer.mjs';
// Existing current-document setup, extracted for navigation-race regression.
export async function configurePassiveObserver({renderer,config,newDocument,sampleClock}){
  const script=newDocument?await renderer.call('Page.addScriptToEvaluateOnNewDocument',{source:observerSource(config)}):undefined;
  await renderer.evaluate(observerSource(config));return {script,sample:await sampleClock(),setup:{attempts:[],discardedClockSamples:[]}};
}
