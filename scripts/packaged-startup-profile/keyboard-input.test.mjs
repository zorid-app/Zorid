import test from 'node:test';
import assert from 'node:assert/strict';
import {pressProfileKey} from './keyboard-input.mjs';

for(const [key,code,windowsVirtualKeyCode,nativeVirtualKeyCode]of [['s','KeyS',83,1],['z','KeyZ',90,6],['Home','Home',36,115]])test(`trusted ${code} carries consistent logical, Windows and macOS key identities on both edges`,async()=>{
  const calls=[];await pressProfileKey({call:async(method,event)=>calls.push({method,event})},key,code);
  assert.deepEqual(calls,['keyDown','keyUp'].map(type=>({method:'Input.dispatchKeyEvent',event:{type,code,modifiers:4,key,windowsVirtualKeyCode,nativeVirtualKeyCode}})));
});
test('the existing explicit Home movement command is passed on keydown only',async()=>{
  const calls=[],commands=['moveToBeginningOfDocument'];await pressProfileKey({call:async(_method,event)=>calls.push(event)},'Home','Home',commands);
  assert.deepEqual(calls[0].commands,commands);assert.notEqual(calls[0].commands,commands);assert.equal(Object.hasOwn(calls[1],'commands'),false);
});
test('normal Save and Undo never invent native edit commands or retry after a dispatch failure',async()=>{
  for(const [key,code]of [['s','KeyS'],['z','KeyZ']]){
    const calls=[];await pressProfileKey({call:async(_method,event)=>calls.push(event)},key,code,[]);assert.ok(calls.every(event=>!Object.hasOwn(event,'commands')));
  }
  let calls=0;await assert.rejects(pressProfileKey({call:async()=>{calls++;throw Error('dispatch failed');}},'s','KeyS'),/dispatch failed/);assert.equal(calls,1);
});
test('mismatched or unplanned key identities cannot reach native dispatch',async()=>{
  for(const [key,code]of [['z','KeyS'],['s','KeyZ'],['x','KeyX']])await assert.rejects(pressProfileKey({call:()=>assert.fail('foreign key cannot dispatch')},key,code),/explicit key identities/);
});
