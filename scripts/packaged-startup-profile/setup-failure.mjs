import {captureObserverFailure} from './observer.mjs';
// Existing warm catch: captures renderer state but omits the owned native window.
export async function captureSetupFailure({renderer,launch}){await captureObserverFailure(renderer,launch);}
