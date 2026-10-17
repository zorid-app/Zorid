import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCoreFixtureConfig } from '../src/platform/browser-core-fixture.ts';

const build = '7ab190d';
const vault = '11111111-1111-4111-8111-111111111111', one = '22222222-2222-4222-8222-222222222222', two = '33333333-3333-4333-8333-333333333333';
test('ordinary builds and ordinary URLs keep the existing browser adapter path', () => {
  assert.equal(browserCoreFixtureConfig(false,new URL(`https://zorid.test/?zorid-core-vault=${vault}&zorid-core-client=${one}`),build),null);
  assert.equal(browserCoreFixtureConfig(true,new URL('https://zorid.test/'),build),null);
});
test('two explicit fixture clients share durable vault data but isolate session and recovery identity', () => {
  const a = browserCoreFixtureConfig(true,new URL(`https://zorid.test/app/?zorid-core-vault=${vault}&zorid-core-client=${one}`),build)!;
  const b = browserCoreFixtureConfig(true,new URL(`https://zorid.test/app/?zorid-core-vault=${vault}&zorid-core-client=${two}`),build)!;
  assert.equal(a.database,b.database); assert.notEqual(a.platformId,b.platformId);
  assert.notEqual(a.platformId,'browser:default');
  assert.equal(a.wasmModuleUrl,'https://zorid.test/app/lib/core/zorid_wasm.js');
  assert.deepEqual(browserCoreFixtureConfig(true,new URL(`https://zorid.test/app/?zorid-core-vault=${vault}&zorid-core-client=${one}`),build),a);
});
test('fixture selection fails clearly for missing, malformed or duplicate identities', () => {
  assert.throws(()=>browserCoreFixtureConfig(true,new URL(`https://zorid.test/?zorid-core-vault=${vault}&zorid-core-client=${one}`),''),{code:'missing_fixture_build'});
  for (const query of [`zorid-core-vault=${vault}`,`zorid-core-vault=../legacy&zorid-core-client=${one}`,
    `zorid-core-vault=${vault}&zorid-core-client=${one}&zorid-core-client=${two}`]) {
    assert.throws(()=>browserCoreFixtureConfig(true,new URL(`https://zorid.test/?${query}`),build),{code:'invalid_fixture_identity'});
  }
});
