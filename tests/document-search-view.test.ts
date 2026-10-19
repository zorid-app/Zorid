import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDocumentSearchView } from '../src/ui/document-search.ts';
import type { DocumentSearchFrame, DocumentSearchGroup, DocumentSearchIdentity } from '../src/ui/document-search.ts';
import type { SearchLocation, SearchSpec } from '../src/core/document-search-types.ts';
const range=(from=0,to=3)=>({bytes:[from,to]as const,utf16:[from,to]as const});
const spec:SearchSpec={query:'cat',caseSensitive:false,sort:'nameAsc',context:'line',explain:false};
function group(id:string,path=id+'.md'):DocumentSearchGroup {
  return {entry:{id,revision:'r1',path,kind:'file',deleted:false},occurrenceCount:7,outputComplete:true,
    locations:[{index:9,locator:{origin:'source',range:range(),kind:'occurrence'},role:'occurrence',occurrences:1},
      {index:10,locator:{origin:'source',range:{bytes:[9,12],utf16:[7,10]},kind:'occurrence'},role:'occurrence',occurrences:1}],
    snippets:[{origin:'source',text:'cat 😀 cat\r\n<script>',originRange:{bytes:[0,22],utf16:[0,20]},primaryLocationIndex:9,
      highlights:[{utf16:[0,3],locationIndices:[9]},{utf16:[7,10],locationIndices:[10]}],clippedBefore:true,clippedAfter:true}]};
}
function frame(changes:Partial<DocumentSearchFrame>={}):DocumentSearchFrame {
  return {scopeId:'vault1',requestId:'request1',spec,phase:'results',groups:[group('z'),group('a')],stale:false,displayTruncated:false,canExplain:true,actions:['loadMore'],
    result:{snapshot:{localStoreId:'store1',generation:'1',generationEpoch:'epoch',versions:{schema:2,extraction:'x',resolver:'r',query:'q'}},source:{localStoreId:'store1',watermark:'1'},
      totals:{occurrences:{relation:'exact',value:24},files:{relation:'exact',value:4}},coverage:{candidateFiles:4,evaluatedFiles:4,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true},coverageComplete:true,outputComplete:true,complete:true,explanation:null},...changes};
}
function deepFreeze<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}
function setup(t:TestContext){
  const dom=new JSDOM('<!doctype html><textarea id="editor"></textarea><main></main>',{pretendToBeVisual:true}),doc=dom.window.document;
  const searches:{identity:DocumentSearchIdentity;spec:SearchSpec}[]=[],opens:{identity:DocumentSearchIdentity;entry:DocumentSearchGroup['entry'];location:SearchLocation|undefined;modifiers:unknown}[]=[],actions:unknown[]=[];
  const view=createDocumentSearchView(doc.querySelector('main')!,{onSearch:(identity,spec)=>searches.push({identity,spec}),onOpen:(identity,entry,location,modifiers)=>opens.push({identity,entry,location,modifiers}),onAction:(identity,action)=>actions.push({identity,action})});
  t.after(()=>{view.destroy();dom.window.close();});
  const field=doc.querySelector<HTMLInputElement>('input[type=search]')!;
  const button=(name:string)=>doc.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const check=(name:string)=>[...doc.querySelectorAll('label')].find(label=>label.textContent===name)!.querySelector('input')!;
  const toggle=(name:string,value:boolean)=>{const input=check(name);input.checked=value;input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  const input=(value:string,isComposing=false)=>{field.value=value;field.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,isComposing}));};
  const press=(target:Element,key:string,extra:KeyboardEventInit={})=>{const e=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(e);return e;};
  return {dom,doc,view,searches,opens,actions,field,button,check,toggle,input,press};
}

test('renders exact core spans/counts/order and immutable plain text without querying or DOM recount',t=>{
  const f=setup(t),value=deepFreeze(frame()),before=JSON.stringify(value);f.view.render(value);
  assert.deepEqual([...f.doc.querySelectorAll('.document-search-name')].map(n=>n.textContent),['z.md','a.md']);
  assert.equal(f.doc.querySelector('.document-search-total')!.textContent,'24 matches in 4 files');
  assert.deepEqual([...f.doc.querySelectorAll('.document-search-badge')].map(n=>n.textContent),['7','7']);
  assert.deepEqual([...f.doc.querySelectorAll('mark')].map(n=>n.textContent),['cat','cat','cat','cat']);
  assert.equal(f.doc.querySelector('.document-search-excerpt')!.textContent,'…cat 😀 cat\r\n<script>…');assert.equal(f.doc.querySelector('script'),null);
  assert.equal(JSON.stringify(value),before);assert.equal(f.searches.length,0);
});

test('Aa clear six sorts and context/explain emit controlled full specs and scope identity',t=>{
  const f=setup(t);f.view.render(frame());assert.equal(f.button('Match case').getAttribute('aria-pressed'),'false');
  f.button('Match case').click();assert.equal(f.searches.at(-1)!.spec.caseSensitive,true);
  const sort=f.doc.querySelector('select')!;assert.equal(sort.options.length,6);
  for(const option of sort.options){sort.value=option.value;sort.dispatchEvent(new f.dom.window.Event('change'));assert.equal(f.searches.at(-1)!.spec.sort,option.value);}
  f.button('Search options').click();assert.equal(f.button('Search options').getAttribute('aria-expanded'),'true');
  f.toggle('Show more context',true);assert.equal(f.searches.at(-1)!.spec.context,'section');
  f.toggle('Explain search',true);assert.equal(f.searches.at(-1)!.spec.explain,true);
  f.button('Clear search').click();assert.equal(f.searches.at(-1)!.spec.query,'');assert.equal(f.doc.activeElement,f.field);
  assert.deepEqual(f.searches.at(-1)!.identity,{scopeId:'vault1',requestId:'request1'});
});

test('IME draft survives refresh and emits only committed query; scope changes disown old draft',t=>{
  const f=setup(t);f.view.render(frame());f.view.focusQuery();f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));f.input('猫',true);
  f.view.render(frame({phase:'loading'}));assert.equal(f.field.value,'猫');assert.equal(f.searches.length,0);
  f.press(f.field,'Enter',{isComposing:true});assert.equal(f.searches.length,0);
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));assert.equal(f.searches.length,1);assert.equal(f.searches[0].spec.query,'猫');assert.equal(f.searches[0].identity.requestId,'request1');
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));f.input('old vault draft',true);
  f.view.render(frame({scopeId:'vault2',spec:{...spec,query:'new vault'}}));f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));
  assert.equal(f.searches.length,1);assert.equal(f.field.value,'new vault');
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));f.input('old request draft',true);
  f.view.render(frame({scopeId:'vault2',requestId:'new-request',spec:{...spec,query:'new query'}}));f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));
  assert.equal(f.searches.length,1);assert.equal(f.field.value,'new query');
});

test('disclosure is separate from open, collapse survives rename and new groups follow collapse-all',t=>{
  const f=setup(t);f.view.render(frame());f.button('Collapse file results').click();assert.equal(f.opens.length,0);
  assert.equal(f.doc.querySelector<HTMLElement>('.document-search-contexts')!.hidden,true);
  f.view.render(frame({groups:[group('z','Folder/Renamed.md'),group('a')]}));assert.equal(f.doc.querySelector<HTMLElement>('.document-search-contexts')!.hidden,true);
  f.toggle('Collapse all results',true);f.view.render(frame({groups:[group('z'),group('a'),group('new')]}));assert.ok([...f.doc.querySelectorAll<HTMLElement>('.document-search-contexts')].every(n=>n.hidden));
  f.view.render(frame({scopeId:'new-scope'}));assert.ok([...f.doc.querySelectorAll<HTMLElement>('.document-search-contexts')].every(n=>!n.hidden));
});

test('no-highlight property Exists/anchor primary opens exact locator; empty group keeps header only',t=>{
  const f=setup(t),base=group('props');const exists:SearchLocation={index:17,locator:{origin:'propertyKey',key:'Status',match:{kind:'exists'}},role:'existence',occurrences:1};
  const anchor:SearchLocation={index:25,locator:{origin:'source',kind:'anchor',range:range(8,8)},role:'anchor',occurrences:0};
  const props:DocumentSearchGroup={...base,locations:[exists,anchor],snippets:[{...base.snippets[0],origin:'propertyKey',key:'Status',text:'Status',originRange:range(0,6),primaryLocationIndex:17,highlights:[]},{...base.snippets[0],primaryLocationIndex:25,highlights:[]}]};
  f.view.render(frame({groups:[props,{...group('zero'),occurrenceCount:0,locations:[],snippets:[]}]}));
  const rows=f.doc.querySelectorAll<HTMLButtonElement>('.document-search-snippet');rows[0].click();assert.equal(f.opens[0].location,exists);rows[1].click();assert.equal(f.opens[1].location,anchor);
  assert.equal(f.doc.querySelectorAll('.document-search-title').length,2);assert.equal(f.doc.querySelectorAll('mark').length,0);
  f.doc.querySelector<HTMLButtonElement>('.document-search-title')!.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,ctrlKey:true,shiftKey:true}));assert.equal(f.opens.at(-1)!.location,undefined);assert.deepEqual(f.opens.at(-1)!.modifiers,{primary:true,shift:true,alt:false});
});

test('incomplete empty pages never claim no results; counts coverage stale and display cap stay honest',t=>{
  const f=setup(t),base=frame();
  f.view.render(frame({groups:[],result:{...base.result!,coverage:{candidateFiles:8,evaluatedFiles:1,unavailableFiles:0,scanComplete:false,queryCoverageComplete:false},complete:false}}));
  assert.doesNotMatch(f.doc.querySelector('.document-search-status')!.textContent!,/could not be searched|No matching/);
  f.view.render(frame({groups:[],result:{...base.result!,totals:{occurrences:{relation:'atLeast',value:3},files:{relation:'unknown',value:null}},coverage:{candidateFiles:8,evaluatedFiles:1,unavailableFiles:1,scanComplete:false,queryCoverageComplete:false},outputComplete:false,complete:false},stale:true,displayTruncated:true}));
  assert.equal(f.doc.querySelector('.document-search-total')!.textContent,'3+ matches in Unknown files');
  const status=f.doc.querySelector('.document-search-status')!.textContent!;for(const phrase of ['still scanning','could not be searched','More results','part of the results','earlier snapshot'])assert.ok(status.includes(phrase));assert.ok(!status.includes('No matching'));
  f.view.render(frame({groups:[],result:{...base.result!,totals:{files:{relation:'exact',value:0},occurrences:{relation:'exact',value:0}}}}));assert.match(f.doc.querySelector('.document-search-status')!.textContent!,/No matching files/);
});


test('generation coverage remains independent from exhaustive query and output coverage',t=>{
  const f=setup(t),base=frame();f.view.render(frame({groups:[],result:{...base.result!,coverageComplete:false,
    totals:{files:{relation:'exact',value:0},occurrences:{relation:'exact',value:0}}}}));
  const text=f.doc.querySelector('.document-search-status')!.textContent!;
  assert.match(text,/Some vault files have incomplete search data/);
  assert.match(text,/No matching files/); // This query can be exhaustive despite incomplete generation facts.
  assert.doesNotMatch(text,/still scanning|could not be searched|More results/);
});

test('old result/action/disclosure controls are inert after replacement, local repaint and destroy',t=>{
  const f=setup(t);f.view.render(frame());const old=f.doc.querySelector<HTMLButtonElement>('.document-search-snippet')!,action=f.doc.querySelector<HTMLButtonElement>('.document-search-actions button')!,disclosure=f.button('Collapse file results');
  f.view.render(frame({requestId:'request2'}));old.click();action.click();disclosure.click();assert.equal(f.opens.length,0);assert.equal(f.actions.length,0);
  const oldLocal=f.doc.querySelector<HTMLButtonElement>('.document-search-snippet')!;f.toggle('Collapse all results',true);oldLocal.click();assert.equal(f.opens.length,0);
  const current=f.doc.querySelector<HTMLButtonElement>('.document-search-snippet')!;f.view.destroy();current.click();assert.equal(f.opens.length,0);assert.equal(f.doc.querySelector('.document-search'),null);
});

test('query identity/focus survives refresh; group arrow keys navigate and never open notes',t=>{
  const f=setup(t);f.view.render(frame());f.view.focusQuery();f.field.setSelectionRange(1,2);f.view.render(frame({requestId:'request2'}));assert.equal(f.doc.activeElement,f.field);assert.equal(f.field.selectionStart,1);
  const titles=f.doc.querySelectorAll<HTMLButtonElement>('.document-search-title');titles[0].focus();assert.equal(f.press(titles[0],'ArrowDown').defaultPrevented,true);assert.equal(f.doc.activeElement,titles[1]);
  f.press(titles[1],'ArrowLeft');assert.equal(f.doc.querySelectorAll<HTMLElement>('.document-search-contexts')[1].hidden,true);f.press(titles[1],'ArrowRight');assert.equal(f.doc.querySelectorAll<HTMLElement>('.document-search-contexts')[1].hidden,false);
  f.view.render(frame());assert.equal((f.doc.activeElement as HTMLElement).dataset.focusKey,'title:a');assert.equal(f.opens.length,0);
  const editor=f.doc.querySelector<HTMLTextAreaElement>('#editor')!;editor.focus();f.view.render(frame());assert.equal(f.doc.activeElement,editor);f.view.destroy();assert.equal(f.doc.activeElement,editor);
});

test('explanation uses literal core tree and unavailable capability is truly disabled',t=>{
  const f=setup(t),base=frame();f.view.render(frame({spec:{...spec,explain:true},result:{...base.result!,explanation:{dialect:'zorid-search-rust-unicode-1',root:{kind:'text',queryRange:range(),caseSensitive:false,scope:'content',operand:'<img src=x>',children:[]}}}}));
  assert.match(f.doc.querySelector('.document-search-explanation')!.textContent!,/<img src=x>/);assert.equal(f.doc.querySelector('img'),null);
  f.view.render(frame({canExplain:false}));assert.equal(f.check('Explain search').disabled,true);f.toggle('Explain search',true);assert.equal(f.searches.length,0);
});
