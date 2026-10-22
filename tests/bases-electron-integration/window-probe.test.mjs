import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const runner=fileURLToPath(new URL('./run.mjs',import.meta.url));
// These fail before root/native lookup, output creation or process launch.
function rejected(args,message){const result=spawnSync(process.execPath,[runner,...args],{encoding:'utf8',timeout:3000});assert.equal(result.status,1);assert.match(result.stderr,message);}
test('window-only probe rejects the product readiness gate',()=>rejected(['--window-bootstrap-probe','--show-window','--ready','bases-native-and-frontend-frozen'],/Coordinator readiness gate/));
test('window-only probe requires actual visible mode',()=>rejected(['--window-bootstrap-probe','--ready','owned-window-bootstrap-frozen'],/requires --show-window/));
test('window-only probe cannot combine with a product campaign',()=>rejected(['--window-bootstrap-probe','--show-window','--ready','owned-window-bootstrap-frozen','--campaign-module','/not-imported/campaign.mjs'],/cannot run a product campaign/));
