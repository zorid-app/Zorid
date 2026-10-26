import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {baseExpressionValue} from '../src/bases/expression.ts';
import type {BaseExpressionValue} from '../src/bases/expression.ts';
import type {DocumentBaseValue} from '../src/core/document-semantics.ts';
import {createSharedBaseValueProjector} from '../src/bases/shared-values.ts';
import {mountBasePropertyWidget} from '../src/bases/property-widgets.ts';
import type {BasePropertyDefinition} from '../src/bases/property-definitions.ts';

function fixture(raw:BaseExpressionValue,display:BaseExpressionValue,definition:BasePropertyDefinition){
  const dom=new JSDOM('<main><div></div></main>',{pretendToBeVisual:true}),element=dom.window.document.querySelector('div')!;
  const opened:unknown[]=[],edits:unknown[]=[],before=JSON.stringify(raw);
  const dispose=mountBasePropertyWidget(element,{row:{path:'Books/Book.md',values:{},entryId:'book',revision:'b1'},property:'note.author',value:display,version:1},{
    getDefinition:()=>definition,getEditableValue:()=>raw,
    // A later choices list cannot promote an explicit null from this saved display.
    getRelationTargets:()=>[{path:'Missing person',entryId:'later-candidate',revision:'r9'}],
    openFile:(path,_event,witness)=>opened.push({path,witness}),commit:edit=>{edits.push(edit);}});
  const pill=()=>element.querySelector<HTMLElement>('.multi-select-pill')!;
  const key=(node:Element,key:string)=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  return{dom,element,opened,edits,pill,key,close(){assert.equal(JSON.stringify(raw),before,'display does not rewrite stored link source');dispose();dom.window.close();}};
}
const rawText='[[../Missing person#^block|Original alias]]';
const coreMissing:DocumentBaseValue={type:'link',path:'Missing person',subpath:'#^block',target:null,display:'Original alias',external:false};

for(const {type,multiple} of [{type:'relation',multiple:false},{type:'relation',multiple:true},{type:'link',multiple:false}] as const)test(`core unresolved ${multiple?'list':'scalar'} ${type} stays visible without a fabricated navigable target`,()=>{
  const project=createSharedBaseValueProjector(),raw=baseExpressionValue(multiple?[rawText]:rawText);
  const display=project(multiple?{type:'list',value:[coreMissing]}:coreMissing);
  const f=fixture(raw,display,{type,...(type==='relation'?{relation:{multiple}}:{})});try{
    assert.equal(f.pill().textContent,'Original alias');assert.equal(f.pill().classList.contains('is-unresolved'),true);
    assert.match(f.pill().title,/unresolved|preserved/i);assert.equal(f.pill().getAttribute('role'),null);assert.equal(f.pill().classList.contains('internal-link'),false);
    f.pill().dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));f.key(f.pill(),'Enter');
    assert.deepEqual(f.opened,[]);assert.deepEqual(f.edits,[]);
    f.pill().dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.deepEqual(f.opened,[]);
    const input=f.dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    if(!multiple)assert.equal(input.value,rawText,'editor keeps the exact relative link, fragment and alias');
    f.key(input,'Escape');assert.deepEqual(f.edits,[]);
  }finally{f.close();}
});

test('resolved core relations keep captured identity and fragment even when current choices differ',()=>{
  const display=createSharedBaseValueProjector()({...coreMissing,path:'People/Ada.md',target:{entryId:'ada',revision:'a7'}});
  const f=fixture(baseExpressionValue(rawText),display,{type:'relation'});try{
    assert.equal(f.pill().classList.contains('is-unresolved'),false);assert.equal(f.pill().getAttribute('role'),'link');
    f.pill().dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
    assert.deepEqual(f.opened,[{path:'People/Ada.md',witness:{entryId:'ada',revision:'a7',subpath:'#^block'}}]);assert.deepEqual(f.edits,[]);
  }finally{f.close();}
});

test('external core links with null local target retain their existing navigation behavior',()=>{
  const display=createSharedBaseValueProjector()({type:'link',path:'https://example.com/person',display:'Website',target:null,external:true});
  const f=fixture(baseExpressionValue('https://example.com/person'),display,{type:'link'});try{
    assert.equal(f.pill().classList.contains('is-unresolved'),false);assert.equal(f.pill().getAttribute('role'),'link');
    f.pill().dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.deepEqual(f.opened,[{path:'https://example.com/person',witness:undefined}]);
  }finally{f.close();}
});

for(const shared of [undefined,{type:'link',path:'Missing person',external:false},{type:'link',path:'Missing person',target:null},Object.assign(Object.create({target:null}),{type:'link',external:false})])test(`absent or unknown resolution metadata is not promoted to core-proven missing (${JSON.stringify(shared)})`,()=>{
  const display={type:'namespace',name:'Legacy alias',presentation:{kind:'link',value:'Missing person'},...(shared?{sharedValue:shared}:{}),get(){throw new Error('Namespace getters are inert');}} as BaseExpressionValue;
  const f=fixture(baseExpressionValue(rawText),display,{type:'relation'});try{
    assert.equal(f.pill().classList.contains('is-unresolved'),false);assert.equal(f.pill().getAttribute('role'),'link');
    f.pill().dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.deepEqual(f.opened,[{path:'Missing person',witness:undefined}]);
  }finally{f.close();}
});

test('resolution metadata accessors are never executed while pairing a relation',()=>{
  let reads=0;const display={type:'namespace',name:'Alias',presentation:{kind:'link',value:'Missing person'},get(){throw new Error('Namespace getters are inert');}} as BaseExpressionValue;
  Object.defineProperty(display,'sharedValue',{get(){reads++;throw new Error('Accessor is not trusted core data');}});
  const f=fixture(baseExpressionValue(rawText),display,{type:'relation'});try{assert.equal(reads,0);assert.equal(f.pill().classList.contains('is-unresolved'),false);}finally{f.close();}
});
