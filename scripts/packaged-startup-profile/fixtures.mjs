import {baseFixtureSource,fixtureText,reopenPrepared} from './oracle.mjs';
// Existing fixed fixture/restore policy, extracted for the opt-in regression.
export function fixtureOptions(){return {largeBytes:432000,largePath:'Large 432000.md',largeOpenKind:'large432000-note-open',restoreLarge:false,reopenKind:'startup-reopen'};}
export function fixtureSources(notes,options){const result=new Map(Array.from({length:notes},(_,index)=>[`Note ${String(index).padStart(4,'0')}.md`,fixtureText(8192,index)]));result.set(options.largePath,fixtureText(options.largeBytes,notes));result.set('Profile.base',baseFixtureSource());return result;}
export const startupTarget=()=> 'Note 0000.md';
export const returnTarget=()=> 'Note 0000.md';
export const preparedRestore=launch=>reopenPrepared(launch);
