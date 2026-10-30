import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,StateEffect,StateField,Text} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {ensureSyntaxTree,syntaxTree} from '@codemirror/language';
import {EditorView} from '@codemirror/view';
import type {DecorationSet,WidgetType} from '@codemirror/view';
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
function widgets(state:EditorState):WidgetType[]{
  const result:WidgetType[]=[];
  for(const decorations of state.facet(EditorView.decorations))if(typeof decorations!=='function')(decorations as DecorationSet).between(0,state.doc.length,(_from,_to,value)=>{if(value.spec.widget)result.push(value.spec.widget);});
  return result;
}

test('opening a large ordinary note needs no complete containing-source capture for absent Bases',()=>{
  assert.equal(plain.length,432000);
  const result=copies(()=>state(plain));assert.equal(result.value.doc.length,432000);assert.equal(result.copies,0);
});

test('large ordinary and incomplete fences do not capture a containing document for an absent Base',()=>{
  for(const source of ['```js\n'+plain+'\n```','~~~yaml\n'+plain+'\n~~~','```base\n'+plain]){
    const result=copies(()=>state(source));assert.equal(result.value.doc.length,source.length);assert.equal(result.copies,0);
  }
});

test('selection and unrelated effects reuse a Base capture while its document and parse tree are unchanged',()=>{
  const source='Before\n\n```base\nviews: []\n```\n\n'+plain;
  const initial=copies(()=>state(source));assert.equal(initial.copies,1,'a real Base retains the complete original source');
  const selection=copies(()=>initial.value.update({selection:{anchor:2}}).state);assert.equal(selection.copies,0);
  const unrelated=StateEffect.define<null>();
  const effect=copies(()=>selection.value.update({effects:unrelated.of(null)}).state);assert.equal(effect.copies,0);
  assert.equal(effect.value.doc,initial.value.doc);
});

test('reused Base spans still refresh exact containing-source authority after an outside edit',()=>{
  const source='Before\n\n```base\nviews: []\n```\n\n'+plain,initial=state(source);
  const original=widgets(initial);assert.equal(original.length,1);
  const selection=initial.update({selection:{anchor:1}}).state;assert.equal(widgets(selection)[0].eq(original[0]),true);
  const changed=copies(()=>selection.update({changes:{from:source.length,insert:' changed outside'}}).state);
  assert.equal(changed.copies,1);assert.equal(widgets(changed.value).length,1);assert.equal(widgets(changed.value)[0].eq(original[0]),false,'a retained widget must not keep an old whole-document guard');
});

test('two actual Base fences share one exact complete source capture per discovery',()=>{
  const source='```base\nviews: []\n```\n\n'+plain+'\n```base\nviews: []\n```',result=copies(()=>state(source));
  // Publish a complete parse before checking the second occurrence.
  assert.ok(ensureSyntaxTree(result.value,result.value.doc.length,1000));
  const published=copies(()=>result.value.update({selection:{anchor:0}}).state);
  assert.equal(widgets(published.value).length,2);assert.ok(result.copies<=1);assert.ok(published.copies<=1);
});

test('syntax-tree advancement discovers a later Base without any document edit',()=>{
  const source='# Start\n'+'body\n'.repeat(10000)+'\n```base\nviews: []\n```',initial=state(source);
  assert.ok(syntaxTree(initial).length<initial.doc.length);assert.equal(widgets(initial).length,0);
  assert.ok(ensureSyntaxTree(initial,initial.doc.length,1000));
  const published=initial.update({selection:{anchor:1}}).state;
  assert.equal(published.doc,initial.doc);assert.equal(widgets(published).length,1,'an unchanged document still needs new parser discoveries');
});

test('effect-only render exclusion ownership changes still hide and rediscover Bases',()=>{
  const source='Before\n\n```base\nviews: []\n```\n\nAfter',toggle=StateEffect.define<boolean>();
  const excluded=StateField.define<boolean>({create:()=>false,update:(value,transaction)=>{for(const effect of transaction.effects)if(effect.is(toggle))value=effect.value;return value;}});
  let current=EditorState.create({doc:source,extensions:[markdown(),excluded,liveBases(()=>{throw Error('No DOM');},{excludes:value=>value.field(excluded)?[{from:0,to:value.doc.length}]:[]})]});
  assert.equal(widgets(current).length,1);const originalDoc=current.doc,originalTree=syntaxTree(current);
  current=current.update({effects:toggle.of(true)}).state;assert.equal(current.doc,originalDoc);assert.equal(syntaxTree(current),originalTree);assert.equal(widgets(current).length,0);
  current=current.update({effects:toggle.of(false)}).state;assert.equal(widgets(current).length,1);
});
