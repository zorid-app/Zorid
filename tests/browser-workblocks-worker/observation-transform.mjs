import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
/** Exact, auditable test-only prepend. Never substitutes a product module body. */
export function workBlockObservationTransform({workerPath,source,channel}){
  if(!/^[A-Za-z0-9:_-]+$/.test(channel))throw new Error('Invalid observation channel');
  const prepend=`import {installWorkBlockObserver as __installWorkBlockProofObserver} from '/tests/browser-workblocks-worker/worker-observer.mjs';\n__installWorkBlockProofObserver(${JSON.stringify(channel)});\n`;
  const proof={path:'src/platform/browser-core-worker.ts',mode:'test-only prepend; original product body unchanged',originalSha256:sha(source),prependSha256:sha(prepend),transformedSha256:sha(prepend+source)};
  return {proof,transform(code,id){
    if(id.split('?')[0]!==workerPath)return null;
    if(code!==source)throw new Error('Normal Worker body differs from frozen observation transform input');
    return {code:prepend+code,map:null};
  }};
}
