import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,StateEffect,Text} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {liveProperties} from '../src/editor/live-properties.ts';
import {liveBases} from '../src/editor/live-bases.ts';

const prefix='# Large ordinary note\n\n',line='Ordinary Markdown text; retained later content must stay exact.\n';
const plain=prefix+line.repeat(Math.floor((432000-prefix.length)/line.length))+line.slice(0,(432000-prefix.length)%line.length);
function copies<T>(action:()=>T):{value:T;copies:number}{
  const original=Text.prototype.toString;let count=0;
  Text.prototype.toString=function(){if(this.length>=432000)count++;return original.call(this);};
  try{return{value:action(),copies:count};}finally{Text.prototype.toString=original;}
}
function state(source:string){return EditorState.create({doc:source,extensions:[markdown({base:markdownLanguage,addKeymap:false}),liveProperties(),liveBases(()=>{throw Error('A state-only fixture must not mount DOM');})]});}

test('opening a large ordinary note needs no complete containing-source capture for absent Bases',()=>{
  assert.equal(plain.length,432000);
  const result=copies(()=>state(plain));assert.equal(result.value.doc.length,432000);assert.equal(result.copies,0);
});
