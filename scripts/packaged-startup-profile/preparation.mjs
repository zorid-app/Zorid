// Existing serial attachment order, retained for the test-first regression.
export async function observeEarly(hooks){
  const main=await hooks.connectMain();await hooks.foreground();await hooks.installNativeObserver(main);
  const renderer=await hooks.connectRenderer();await hooks.installObserver(renderer);return {main,renderer};
}
export function validateEmptyWarmEvidence(value){return value;}
export async function resetEmptyWarmState(){return {removed:[]};}
