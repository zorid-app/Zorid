import assert from 'node:assert/strict';
import {baseFixtureSource,fixtureText,MAX_FIXTURE_BYTES,reopenPrepared} from './oracle.mjs';
export function fixtureOptions(args=[]){
  const positions=args.flatMap((value,index)=>value==='--large-note-bytes'?[index]:[]);assert.ok(positions.length<=1,'Duplicate --large-note-bytes');
  const input=positions.length?args[positions[0]+1]:'432000';assert.ok(typeof input==='string'&&/^[0-9]+$/.test(input),'--large-note-bytes requires decimal bytes');
  const largeBytes=Number(input);assert.ok(Number.isSafeInteger(largeBytes)&&largeBytes>=1024&&largeBytes<=MAX_FIXTURE_BYTES,'Large fixture must be1024..5242880 bytes');
  const restoreLarge=args.includes('--restore-large'),largePath=`Large ${largeBytes}.md`;
  return Object.freeze({largeBytes,largePath,largeOpenKind:`large${largeBytes}-note-open`,restoreLarge,reopenKind:restoreLarge?`startup-reopen-large${largeBytes}`:'startup-reopen'});
}
export function fixtureSources(notes,options){
  assert.ok(Number.isSafeInteger(notes)&&notes>=2&&notes<=10000,'Invalid fixture note count');
  const result=new Map(Array.from({length:notes},(_,index)=>[`Note ${String(index).padStart(4,'0')}.md`,fixtureText(8192,index)]));result.set(options.largePath,fixtureText(options.largeBytes,notes));result.set('Profile.base',baseFixtureSource());return result;
}
export const startupTarget=(options,mode)=>mode==='reopen'&&options.restoreLarge?options.largePath:'Note 0000.md';
export const returnTarget=options=>options.restoreLarge?options.largePath:'Note 0000.md';
export function preparedRestore(launch,options){
  if(!reopenPrepared(launch))return false;
  if(!options.restoreLarge)return launch.preparedRestorePath===undefined||launch.preparedRestorePath==='Note 0000.md';
  const proof=launch.restorePreparation,digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  return launch.preparedRestorePath===options.largePath&&proof?.path===options.largePath&&proof.bytes===options.largeBytes
    &&proof.sourceExact===true&&proof.coreExact===true&&proof.uiClean===true&&typeof proof.entryId==='string'&&proof.entryId.length>0&&typeof proof.revision==='string'&&proof.revision.length>0
    &&digest(proof.expectedSha256)&&proof.physicalSha256===proof.expectedSha256&&proof.coreSha256===proof.expectedSha256;
}
