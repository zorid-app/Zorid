import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureText} from './oracle.mjs';
import {fixtureOptions,fixtureSources,preparedRestore,returnTarget,startupTarget} from './fixtures.mjs';
const largeBytes=5*1024*1024;
const clean=()=>({returnToStartupNoteVerified:true,errors:[],cleanup:{normal:true,gone:true},fixturesRestored:true,sourcePathsExact:true,artifactsUnchanged:true});
test('default fixture bytes paths metric kinds and Note0 restoration remain unchanged',()=>{
  const options=fixtureOptions(),sources=fixtureSources(2,options);assert.equal(options.largeBytes,432000);assert.equal(options.largePath,'Large 432000.md');assert.equal(options.largeOpenKind,'large432000-note-open');assert.equal(options.reopenKind,'startup-reopen');assert.deepEqual([...sources.keys()],['Note 0000.md','Note 0001.md','Large 432000.md','Profile.base']);assert.equal(sources.get(options.largePath),fixtureText(432000,2));assert.equal(returnTarget(options),'Note 0000.md');assert.equal(startupTarget(options,'reopen'),'Note 0000.md');assert.equal(preparedRestore(clean(),options),true);
});
test('custom five-MiB fixture and large-restore labels are exact while first import still starts Note0',()=>{
  const options=fixtureOptions(['--large-note-bytes',String(largeBytes),'--restore-large']),sources=fixtureSources(2,options);assert.equal(options.largeBytes,largeBytes);assert.equal(options.largePath,'Large 5242880.md');assert.equal(options.largeOpenKind,'large5242880-note-open');assert.equal(options.reopenKind,'startup-reopen-large5242880');assert.equal(Buffer.byteLength(sources.get(options.largePath)),largeBytes);assert.equal(startupTarget(options,'first-import'),'Note 0000.md');assert.equal(startupTarget(options,'reopen'),options.largePath);assert.equal(returnTarget(options),options.largePath);assert.equal(sources.size,4);
});
test('missing malformed duplicated unsafe and out-of-bound fixture sizes reject before fixture creation',()=>{
  for(const args of [['--large-note-bytes'],['--large-note-bytes','NaN'],['--large-note-bytes','1.5'],['--large-note-bytes','0'],['--large-note-bytes','1023'],['--large-note-bytes',String(largeBytes+1)],['--large-note-bytes','432000','--large-note-bytes','432000']])assert.throws(()=>fixtureOptions(args));
});
test('large reopen requires the exact prepared path and independent physical Core and clean-state evidence',()=>{
  const options=fixtureOptions(['--restore-large']),proof={path:options.largePath,bytes:options.largeBytes,physicalSha256:'same',coreSha256:'same',expectedSha256:'same',entryId:'entry',revision:'revision',sourceExact:true,coreExact:true,uiClean:true},launch={...clean(),preparedRestorePath:options.largePath,restorePreparation:proof};assert.equal(preparedRestore(launch,options),true);
  for(const change of [{preparedRestorePath:'Note 0000.md'},{restorePreparation:undefined},{restorePreparation:{...proof,coreExact:false}},{restorePreparation:{...proof,physicalSha256:'changed'}},{restorePreparation:{...proof,entryId:''}},{restorePreparation:{...proof,uiClean:false}},{errors:['Base failed']},{cleanup:{normal:false,gone:true}},{fixturesRestored:false}])assert.equal(preparedRestore({...launch,...change},options),false);
});
